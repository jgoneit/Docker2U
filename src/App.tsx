import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { AlertTriangle, Boxes, Cable, ChevronRight, Info, LoaderCircle, Monitor, RefreshCw, Search } from 'lucide-react';
import { api, coreError } from './api';
import type { Action, Container, ContainerList, CoreError, Environment, MutationResult, RecentLogs } from './api';
import { ConfirmDialog, ContainerDetail, Diagnostics, ErrorDetails, Health, State, formatTime, readableStates } from './components';
import type { Confirmation, Operation } from './components';
import { BulkResult, BulkSelection, canApply, isBoundBulkResult } from './bulk';
import type { BulkOperation } from './bulk';

type Filter = 'all' | 'running' | 'stopped' | 'attention';
export default function App() {
  const [environment, setEnvironment] = useState<Environment | null>(null);
  const [connecting, setConnecting] = useState(true);
  const [environmentError, setEnvironmentError] = useState<CoreError | null>(null);
  const [snapshot, setSnapshot] = useState<ContainerList | null>(null);
  const [listError, setListError] = useState<CoreError | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [checkedHandles, setCheckedHandles] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [logs, setLogs] = useState<RecentLogs | null>(null);
  const [logsError, setLogsError] = useState<CoreError | null>(null);
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [mutationBlocked, setMutationBlocked] = useState(false);
  const [operation, setOperation] = useState<Operation | null>(null);
  const [bulkOperation, setBulkOperation] = useState<BulkOperation | null>(null);
  const [bulkPending, setBulkPending] = useState<{ action: Action; count: number } | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [clipboardMessage, setClipboardMessage] = useState('');
  const session = useRef<string | null>(null);
  const currentSnapshot = useRef<ContainerList | null>(null);
  const epoch = useRef(0);
  const listSequence = useRef(0);
  const logSequence = useRef(0);
  const busy = useRef(false);
  const refreshBusy = useRef(false);
  const blocked = useRef(false);
  const inventory = useRef<HTMLUListElement>(null);
  const selected = snapshot?.containers.find(container => container.fullId === selectedId) ?? null;
  const visible = (snapshot?.containers ?? []).filter(container => {
    const searchMatches = `${container.name} ${container.image} ${container.shortId} ${container.ports.join(' ')}`.toLowerCase().includes(query.trim().toLowerCase());
    const filterMatches = filter === 'all' || (filter === 'running' && container.state === 'running') || (filter === 'stopped' && ['created', 'exited'].includes(container.state)) || (filter === 'attention' && (container.health === 'unhealthy' || ['dead', 'paused', 'restarting', 'removing', 'unknown'].includes(container.state)));
    return searchMatches && filterMatches;
  });
  const checked = visible.filter(container => checkedHandles.has(container.handle));
  const refresh = useCallback(async (sessionId: string) => {
    const requestEpoch = epoch.current;
    const request = ++listSequence.current;
    refreshBusy.current = true;
    setCheckedHandles(new Set());
    ++logSequence.current;
    setRefreshing(true);
    setLoadingLogs(false);
    try {
      const result = await api.listContainers(sessionId);
      if (epoch.current !== requestEpoch || session.current !== sessionId || request !== listSequence.current) return;
      if (result.sessionId !== sessionId || (currentSnapshot.current && result.generation <= currentSnapshot.current.generation)) throw { code: 'STALE_RESPONSE', message: '최신 목록을 확인하지 못했습니다. Refresh로 다시 조회하세요.' };
      currentSnapshot.current = result;
      setSnapshot(result);
      setListError(null);
      setSelectedId(previous => result.containers.some(container => container.fullId === previous) ? previous : result.containers[0]?.fullId ?? null);
    } catch (error) {
      if (epoch.current !== requestEpoch || session.current !== sessionId || request !== listSequence.current) return;
      setListError(coreError(error));
      if (currentSnapshot.current) {
        currentSnapshot.current = { ...currentSnapshot.current, stale: true };
        setSnapshot(currentSnapshot.current);
      }
    } finally {
      if (epoch.current === requestEpoch && request === listSequence.current) { refreshBusy.current = false; setRefreshing(false); }
    }
  }, []);
  const connect = useCallback(async () => {
    if (busy.current || refreshBusy.current) return;
    const requestEpoch = ++epoch.current;
    session.current = null;
    currentSnapshot.current = null;
    ++listSequence.current;
    ++logSequence.current;
    refreshBusy.current = false;
    setConnecting(true);
    setEnvironment(null);
    setEnvironmentError(null);
    setSnapshot(null);
    setListError(null);
    setLogs(null);
    setLogsError(null);
    setLoadingLogs(false);
    setRefreshing(false);
    setConfirmation(null);
    setOperation(null);
    setBulkOperation(null);
    setCheckedHandles(new Set());
    setSelectedId(null);
    try {
      const result = await api.getEnvironment();
      if (epoch.current !== requestEpoch) return;
      setEnvironment(result);
      if (result.status === 'ready' && result.sessionId) {
        session.current = result.sessionId;
        blocked.current = !result.mutationAllowed;
        setMutationBlocked(blocked.current);
        setConnecting(false);
        await refresh(result.sessionId);
      }
    } catch (error) {
      if (epoch.current === requestEpoch) setEnvironmentError(coreError(error));
    } finally {
      if (epoch.current === requestEpoch) setConnecting(false);
    }
  }, [refresh]);
  useEffect(() => {
    // Defer one microtask so development StrictMode's discarded mount never opens a session.
    let active = true;
    void Promise.resolve().then(() => { if (active) void connect(); });
    return () => { active = false; ++epoch.current; ++logSequence.current; };
  }, [connect]);
  const loadLogs = useCallback(async (container: Container, list: ContainerList) => {
    if (busy.current || list.stale || !readableStates.has(container.state) || session.current !== list.sessionId) return;
    const requestEpoch = epoch.current;
    const request = ++logSequence.current;
    setLoadingLogs(true);
    setLogs(null);
    setLogsError(null);
    try {
      const result = await api.getRecentLogs(list.sessionId, container.handle);
      if (epoch.current !== requestEpoch || request !== logSequence.current || currentSnapshot.current?.generation !== list.generation) return;
      if (result.sessionId !== list.sessionId || result.generation !== list.generation || result.handle !== container.handle) throw { code: 'STALE_RESPONSE', message: '이전 로그 응답입니다. Recent Logs로 다시 조회하세요.' };
      setLogs(result);
    } catch (error) {
      if (epoch.current === requestEpoch && request === logSequence.current) setLogsError(coreError(error));
    } finally {
      if (epoch.current === requestEpoch && request === logSequence.current) setLoadingLogs(false);
    }
  }, []);
  useEffect(() => {
    ++logSequence.current;
    setLogs(null);
    setLogsError(null);
    setLoadingLogs(false);
    if (selected && snapshot && !refreshing && !mutating) void loadLogs(selected, snapshot);
  }, [selected, snapshot, refreshing, mutating, loadLogs]);
  async function mutate(container: Container, action: Action, targetSession: string, generation: number) {
    const current = currentSnapshot.current;
    const actionAllowed = action === 'start' ? ['created', 'exited'].includes(container.state) : container.state === 'running';
    if (busy.current || refreshBusy.current || blocked.current || !actionAllowed || session.current !== targetSession || current?.stale || current?.generation !== generation || !current.containers.some(item => item.handle === container.handle)) return;
    busy.current = true;
    setMutating(true);
    setOperation(null);
    setConfirmation(null);
    const requestEpoch = epoch.current;
    let result: MutationResult;
    try { result = await api.mutateContainer(targetSession, container.handle, action); }
    catch (error) {
      const failure = coreError(error);
      const uncertain = failure.code === 'IPC_FAILURE' || failure.code === 'WorkerFailed';
      result = { outcome: uncertain ? 'resultUnknown' : 'failed', message: failure.message, command: failure.command ?? '', stderr: failure.stderr ?? '', reconciliation: uncertain ? 'failed' : 'notNeeded', mutationBlocked: true };
    }
    if (epoch.current !== requestEpoch) return;
    blocked.current = blocked.current || result.mutationBlocked || result.reconciliation === 'failed';
    setMutationBlocked(blocked.current);
    setOperation({ ...result, fullId: container.fullId, name: container.name, action, profile: environment?.profile ?? 'colima-docker2u' });
    await refresh(targetSession);
    if (epoch.current === requestEpoch) { busy.current = false; setMutating(false); }
  }
  function requestAction(action: Action, returnFocus?: HTMLElement) {
    if (busy.current || refreshBusy.current || blocked.current || !selected || !snapshot || snapshot.stale || !environment?.mutationAllowed || !session.current || !canApply(selected, action)) return;
    if (action === 'start') void mutate(selected, action, session.current, snapshot.generation);
    else setConfirmation({ container: selected, action, sessionId: session.current, generation: snapshot.generation, profile: environment.profile, endpoint: environment.endpoint ?? '—', returnFocus });
  }
  async function mutateBulk(containers: Container[], action: Action, targetSession: string, generation: number) {
    const current = currentSnapshot.current;
    if (busy.current || refreshBusy.current || blocked.current || !containers.length || !containers.some(container => canApply(container, action)) || session.current !== targetSession || current?.stale || current?.generation !== generation || containers.some(container => !current.containers.some(item => item.handle === container.handle))) return;
    busy.current = true;
    setMutating(true);
    setBulkPending({ action, count: containers.filter(container => canApply(container, action)).length });
    setBulkOperation(null);
    setOperation(null);
    setConfirmation(null);
    const requestEpoch = epoch.current;
    const context = { action, profile: environment?.profile ?? 'colima-docker2u', containers };
    try {
      const result = await api.mutateContainers(targetSession, generation, containers.map(container => container.handle), action);
      if (epoch.current !== requestEpoch) return;
      if (!isBoundBulkResult(result, targetSession, generation, containers, action)) throw { code: 'INVALID_BULK_RESPONSE', message: '요청 대상과 일치하는 전체 일괄 응답을 확인하지 못했습니다.' };
      blocked.current = blocked.current || result.mutationBlocked || result.items.some(item => item.result?.mutationBlocked || item.result?.reconciliation === 'failed');
      setBulkOperation({ ...context, result });
    } catch (error) {
      if (epoch.current !== requestEpoch) return;
      const failure = coreError(error);
      // Only these structured native rejections prove that no command was dispatched.
      const preflightRejection = ['Busy', 'StaleSession', 'NeedsValidation', 'StaleHandle', 'InvalidSelection'].includes(failure.code);
      blocked.current = true;
      setBulkOperation({ ...context, error: failure, uncertain: !preflightRejection });
    } finally {
      if (epoch.current === requestEpoch) {
        setMutationBlocked(blocked.current);
        await refresh(targetSession);
        if (epoch.current === requestEpoch) { busy.current = false; setMutating(false); setBulkPending(null); }
      }
    }
  }
  function requestBulkAction(action: Action, returnFocus?: HTMLElement) {
    if (busy.current || refreshBusy.current || blocked.current || !checked.length || !checked.some(container => canApply(container, action)) || !snapshot || snapshot.stale || !environment?.mutationAllowed || !session.current) return;
    if (action === 'start') void mutateBulk(checked, action, session.current, snapshot.generation);
    else setConfirmation({ containers: checked, action, sessionId: session.current, generation: snapshot.generation, profile: environment.profile, endpoint: environment.endpoint ?? '—', returnFocus });
  }
  function changeSelection(next: (previous: Set<string>) => Set<string>) {
    if (busy.current || refreshBusy.current || !currentSnapshot.current || currentSnapshot.current.stale) return;
    setCheckedHandles(next);
  }
  async function copy(text: string, label: string) {
    try { await navigator.clipboard.writeText(text); setClipboardMessage(`${label} 복사됨`); }
    catch { setClipboardMessage('클립보드에 복사하지 못했습니다.'); }
  }
  function selectWithKeyboard(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next = index;
    if (event.key === 'ArrowDown') next = Math.min(index + 1, visible.length - 1);
    else if (event.key === 'ArrowUp') next = Math.max(index - 1, 0);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = visible.length - 1;
    else return;
    event.preventDefault();
    const item = visible[next];
    if (item) { setSelectedId(item.fullId); inventory.current?.querySelectorAll<HTMLButtonElement>('.container-row')[next]?.focus(); }
  }
  const ready = environment?.status === 'ready' && !!environment.sessionId;
  return <div className="app-shell">
    <div className="main-content" inert={!!confirmation}>
      <header className="app-header"><div className="brand"><span className="brand-icon" aria-hidden="true"><Boxes size={22} /></span><div><h1>Docker2U</h1><p>Docker CLI, without the CLI friction.</p></div></div><div className="header-right"><span className="platform-badge"><Monitor size={14} aria-hidden="true" /> macOS local alpha</span><button className="icon-button" aria-label="환경 진단 보기" aria-expanded={showDiagnostics} onClick={() => setShowDiagnostics(!showDiagnostics)}><Info size={18} aria-hidden="true" /></button></div></header>
      <section className="connection-bar" aria-label="연결 환경"><div className="connection-label"><span className={`connection-dot ${ready ? 'connected' : ''}`} /><strong>colima-docker2u</strong><span className="muted">{connecting ? '환경 확인 중' : ready ? 'Local · 연결됨' : '연결되지 않음'}</span></div><div className="connection-actions"><button onClick={() => void connect()} disabled={connecting || refreshing || mutating}><Cable size={14} aria-hidden="true" />Reconnect</button><button className="primary-button" disabled={!ready || refreshing || mutating} onClick={() => { if (session.current && !busy.current && !refreshBusy.current) void refresh(session.current); }}><RefreshCw size={14} className={refreshing ? 'spin' : ''} aria-hidden="true" />{refreshing ? '갱신 중…' : 'Refresh'}</button></div></section>
      {showDiagnostics && <Diagnostics environment={environment} close={() => setShowDiagnostics(false)} copy={copy} />}
      <main className="workspace">
        <aside className="inventory-panel" aria-labelledby="inventory-title">
          <div className="panel-heading"><h2 id="inventory-title">Containers <span className="count-badge">{snapshot?.containers.length ?? '—'}</span></h2><span className="muted small">수동 갱신</span></div>
          <div className="inventory-controls"><label className="search-field"><Search size={16} aria-hidden="true" /><input aria-label="Container 검색" placeholder="이름, 이미지 또는 ID 검색" value={query} disabled={mutating} onChange={event => { if (!busy.current) { setQuery(event.target.value); setCheckedHandles(new Set()); } }} /></label><div className="filter-group" aria-label="Container 필터">{([['all', '전체'], ['running', '실행 중'], ['stopped', '중지'], ['attention', '확인 필요']] as const).map(([value, label]) => <button key={value} aria-pressed={filter === value} disabled={mutating} onClick={() => { if (!busy.current) { setFilter(value); setCheckedHandles(new Set()); } }}>{label}</button>)}</div></div>
          <BulkSelection visible={visible} checked={checked} disabled={mutating || refreshing || connecting || !snapshot || snapshot.stale} actionsDisabled={mutating || refreshing || mutationBlocked || !environment?.mutationAllowed || !snapshot || snapshot.stale} pending={bulkPending} onToggleAll={() => changeSelection(() => checked.length === visible.length ? new Set() : new Set(visible.map(container => container.handle)))} onClear={() => changeSelection(() => new Set())} onAction={requestBulkAction} />
          {snapshot?.stale && <div className="stale-notice" role="status"><AlertTriangle size={14} aria-hidden="true" /><span>Stale · 마지막 정상 목록입니다.</span></div>}
          {listError && <div className="inline-error" role="alert"><p>목록을 갱신하지 못했습니다.</p><p>{listError.message}</p><ErrorDetails error={listError} /></div>}
          <ul ref={inventory} aria-label="Container 목록" aria-busy={refreshing || mutating} className="container-list">{visible.map((container, index) => <li key={container.fullId} className="container-list-item"><input type="checkbox" className="container-checkbox" aria-label={`${container.name} 작업 대상으로 선택`} checked={checkedHandles.has(container.handle)} disabled={mutating || refreshing || !!snapshot?.stale} onChange={() => changeSelection(previous => { const next = new Set(previous); if (next.has(container.handle)) next.delete(container.handle); else next.add(container.handle); return next; })} /><button aria-label={`${container.name} 상세`} aria-current={selectedId === container.fullId ? 'true' : undefined} tabIndex={selectedId === container.fullId || (!visible.some(item => item.fullId === selectedId) && index === 0) ? 0 : -1} className="container-row" onClick={() => setSelectedId(container.fullId)} onKeyDown={event => selectWithKeyboard(event, index)}><span className="container-row-title"><strong>{container.name}</strong><ChevronRight size={15} aria-hidden="true" /></span><span className="container-image">{container.image}</span><span className="container-statuses"><State value={container.state} /><Health value={container.health} /></span></button></li>)}</ul>
          {!visible.length && <div className="inventory-placeholder"><Boxes size={28} aria-hidden="true" /><p>{connecting || (refreshing && !snapshot) ? 'Container를 확인하고 있습니다.' : !ready ? '로컬 환경을 연결하면 목록이 표시됩니다.' : !snapshot ? 'Refresh로 목록을 다시 조회하세요.' : snapshot.containers.length === 0 ? '현재 Engine에 Container가 없습니다.' : '검색 결과가 없습니다.'}</p>{snapshot && snapshot.containers.length > 0 && <button className="text-button" disabled={mutating} onClick={() => { if (!busy.current) { setQuery(''); setFilter('all'); setCheckedHandles(new Set()); } }}>검색·필터 초기화</button>}</div>}
        </aside>
        <section className="detail-panel" aria-labelledby="detail-title">
          <div className="panel-heading"><h2 id="detail-title">{selected ? 'Container 상세' : '환경 연결'}</h2><span className="muted small">{snapshot ? `최근 갱신 ${formatTime(snapshot.refreshedAt)}` : '환경 진단'}</span></div>
          {bulkOperation && <BulkResult operation={bulkOperation} />}
          {connecting ? <div className="startup-panel"><div className="startup-icon"><LoaderCircle className="spin" size={30} aria-hidden="true" /></div><h3>로컬 환경을 확인하고 있습니다.</h3><p>Colima 프로파일과 Engine 연결 정보를 확인합니다.</p></div> : !ready ? <div className="startup-panel"><div className="startup-icon"><Cable size={32} aria-hidden="true" /></div><span className="eyebrow">LOCAL ENVIRONMENT</span><h3>{environment?.status === 'unsupported' ? '지원하는 로컬 환경이 아닙니다.' : environment?.dockerPath === null ? 'Docker CLI를 확인할 수 없습니다.' : '로컬 환경에 연결하지 못했습니다.'}</h3><p>Colima의 docker2u 프로파일과 Docker CLI가 준비되어 있는지 확인한 뒤 다시 연결하세요.</p>{environmentError && <div role="alert"><p>{environmentError.message}</p><ErrorDetails error={environmentError} /></div>}{environment?.diagnostics.map((message, index) => <p key={index} className="diagnostic-message">{message}</p>)}<button className="primary-button" onClick={() => void connect()}><RefreshCw size={14} aria-hidden="true" />다시 연결</button></div> : selected && snapshot ? <ContainerDetail container={selected} snapshot={snapshot} logs={logs} logsError={logsError} loadingLogs={loadingLogs} refreshing={refreshing} mutating={mutating} mutationBlocked={mutationBlocked} mutationAllowed={!!environment?.mutationAllowed} operation={operation?.fullId === selected.fullId ? operation : null} loadLogs={() => void loadLogs(selected, snapshot)} clearLogs={() => { ++logSequence.current; setLogs(null); }} requestAction={requestAction} copy={copy} /> : <div className="startup-panel"><div className="startup-icon"><Boxes size={32} aria-hidden="true" /></div><h3>{refreshing ? 'Container 목록을 불러오고 있습니다.' : snapshot?.containers.length === 0 ? '아직 Container가 없습니다.' : 'Container를 선택하세요.'}</h3><p>{snapshot?.containers.length === 0 ? '현재 Engine에 생성된 Container가 없습니다. 준비된 개발 서비스를 실행한 뒤 Refresh를 눌러주세요.' : '왼쪽 목록에서 상태와 최근 로그를 확인할 대상을 선택하세요.'}</p></div>}
        </section>
      </main>
      <footer className="app-footer"><span><span className="footer-dot" />LOCAL ALPHA · COLIMA</span><span role="status" aria-live="polite">{clipboardMessage || (ready ? `연결 대상 고정 · ${environment.profile}` : '로컬 환경 연결 대기')}</span></footer>
    </div>
    {confirmation && <ConfirmDialog confirmation={confirmation} onCancel={() => setConfirmation(null)} onConfirm={() => { if (confirmation.containers) void mutateBulk(confirmation.containers, confirmation.action, confirmation.sessionId, confirmation.generation); else void mutate(confirmation.container, confirmation.action, confirmation.sessionId, confirmation.generation); }} />}
  </div>;
}
