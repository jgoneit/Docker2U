import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { AlertTriangle, Boxes, Cable, ChevronRight, Info, LoaderCircle, Monitor, RefreshCw, Search, Settings, X } from 'lucide-react';
import { api, coreError } from './api';
import type { Action, ConnectionTarget, Container, ContainerList, CoreError, Environment, MutationResult } from './api';
import { ConfirmDialog, ContainerDetail, ContainerSummary, Diagnostics, ErrorDetails, OperationResult, Health, State, readableStates } from './components';
import type { Confirmation, Operation, CopyLabel } from './components';
import { BulkResult, BulkSelection, canApply, isBoundBulkResult } from './bulk';
import type { BulkOperation } from './bulk';
import type { LogSnapshot } from './logSnapshot';

import { PreferencesProvider } from './preferences';
import { SettingsDialog } from './SettingsDialog';
import { useI18n } from './i18n';
import { appMessages } from './messages/app';

type Filter = 'all' | 'running' | 'stopped' | 'attention';
function matchesContainer(container: Container, query: string, filter: Filter) {
  const searchMatches = `${container.name} ${container.image} ${container.shortId} ${container.fullId} ${container.ports.join(' ')}`.toLowerCase().includes(query.trim().toLowerCase());
  const filterMatches = filter === 'all' || (filter === 'running' && container.state === 'running') || (filter === 'stopped' && ['created', 'exited'].includes(container.state)) || (filter === 'attention' && (container.health === 'unhealthy' || ['dead', 'paused', 'restarting', 'removing', 'unknown'].includes(container.state)));
  return searchMatches && filterMatches;
}
const connectionInvalidatingErrors = new Set(['EnvironmentChanged', 'Disconnected', 'SocketMissing', 'PermissionDenied', 'Configuration', 'EndpointMismatch', 'RemoteEndpoint']);
function connectionIssue(error: CoreError | null, unsupported: boolean): [keyof typeof appMessages, keyof typeof appMessages] {
  const issues: Record<string, [keyof typeof appMessages, keyof typeof appMessages]> = {
    CliNotFound: ['cliTitle', 'cliHelp'], Configuration: ['configTitle', 'configHelp'],
    ContextSelection: ['contextTitle', 'contextHelp'], SocketMissing: ['socketTitle', 'socketHelp'],
    PermissionDenied: ['permissionTitle', 'permissionHelp'], RemoteEndpoint: ['remoteTitle', 'remoteHelp'],
    EndpointMismatch: ['endpointTitle', 'endpointHelp'], UnsupportedRuntime: ['unsupportedTitle', 'unsupportedHelp'],
    MalformedOutput: ['malformedTitle', 'malformedHelp'], EnvironmentChanged: ['changedTitle', 'changedHelp'],
  };
  return (error && issues[error.code]) || (unsupported ? issues.UnsupportedRuntime : null) || ['failedTitle', 'failedHelp'];
}
function connectionTarget(environment: Environment | null): ConnectionTarget {
  return { contextName: environment?.contextName ?? null, endpoint: environment?.endpoint ?? null, engineId: environment?.engineId ?? null };
}
export default function App() {
  return <PreferencesProvider><AppContent /></PreferencesProvider>;
}
function AppContent() {
  const t = useI18n(appMessages);
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
  const [logs, setLogs] = useState<LogSnapshot | null>(null);
  const [logsError, setLogsError] = useState<CoreError | null>(null);
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [reconnectRequired, setReconnectRequired] = useState(false);
  const [mutationBlocked, setMutationBlocked] = useState(false);
  const [operation, setOperation] = useState<Operation | null>(null);
  const [bulkOperation, setBulkOperation] = useState<BulkOperation | null>(null);
  const [bulkPending, setBulkPending] = useState<{ action: Action; count: number } | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [clipboardMessage, setClipboardMessage] = useState<{ key: 'copied'; label: CopyLabel } | { key: 'copyFailure' } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [logsExpanded, setLogsExpanded] = useState(false);
  const settingsTrigger = useRef<HTMLButtonElement>(null);
  const session = useRef<string | null>(null);
  const currentSnapshot = useRef<ContainerList | null>(null);
  const epoch = useRef(0);
  const listSequence = useRef(0);
  const logSequence = useRef(0);
  const busy = useRef(false);
  const refreshBusy = useRef(false);
  const blocked = useRef(false);
  const selectedIdRef = useRef<string | null>(null);
  const searchCriteria = useRef<{ query: string; filter: Filter }>({ query: '', filter: 'all' });
  const initialSelection = useRef(true);
  const pendingRemovedFocus = useRef<Element | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const inventory = useRef<HTMLUListElement>(null);
  const bulkSelectAll = useRef<HTMLInputElement>(null);
  const bulkRegion = useRef<HTMLElement>(null);
  const pendingBulkFocus = useRef<{ epoch: number } | null>(null);
  useEffect(() => {
    function preserveUserFocus(event: FocusEvent) {
      const target = event.target;
      if (pendingBulkFocus.current && target instanceof HTMLElement && target !== document.body && target !== document.documentElement && !target.matches(':disabled') && !target.closest('[role="dialog"], [inert]')) pendingBulkFocus.current = null;
    }
    document.addEventListener('focusin', preserveUserFocus);
    return () => {
      pendingBulkFocus.current = null;
      document.removeEventListener('focusin', preserveUserFocus);
    };
  }, []);
  useEffect(() => {
    const pending = pendingBulkFocus.current;
    if (!pending) return;
    if (pending.epoch !== epoch.current) { pendingBulkFocus.current = null; return; }
    if (busy.current || refreshBusy.current || mutating || refreshing || confirmation || settingsOpen || logsExpanded) return;
    // Consume before focusin fires, after React has enabled the final controls.
    pendingBulkFocus.current = null;
    if (bulkSelectAll.current && !bulkSelectAll.current.disabled) bulkSelectAll.current.focus();
    else bulkRegion.current?.focus();
  }, [mutating, refreshing, confirmation, settingsOpen, logsExpanded, snapshot]);
  const visible = (snapshot?.containers ?? []).filter(container => matchesContainer(container, query, filter));
  const selected = visible.find(container => container.fullId === selectedId) ?? null;
  const checked = visible.filter(container => checkedHandles.has(container.handle));
  const selectContainer = useCallback((id: string | null) => {
    if (selectedIdRef.current === id) return;
    selectedIdRef.current = id;
    ++logSequence.current;
    setSelectedId(id);
    setLogs(null);
    setLogsError(null);
    setLoadingLogs(false);
    setLogsExpanded(false);
  }, []);
  function updateSearch(nextQuery: string, nextFilter: Filter) {
    if (busy.current) return;
    pendingRemovedFocus.current = document.activeElement;
    searchCriteria.current = { query: nextQuery, filter: nextFilter };
    setQuery(nextQuery);
    setFilter(nextFilter);
    setCheckedHandles(new Set());
    if (!currentSnapshot.current?.containers.some(container => container.fullId === selectedIdRef.current && matchesContainer(container, nextQuery, nextFilter))) selectContainer(null);
  }
  useLayoutEffect(() => {
    const previous = pendingRemovedFocus.current;
    pendingRemovedFocus.current = null;
    if (previous && !previous.isConnected && (document.activeElement === document.body || document.activeElement === document.documentElement)) {
      const firstRow = inventory.current?.querySelector<HTMLButtonElement>('.container-row');
      (firstRow ?? searchInput.current)?.focus();
    }
  }, [snapshot, query, filter]);
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
      pendingRemovedFocus.current = document.activeElement;
      currentSnapshot.current = result;
      setSnapshot(result);
      setListError(null);
      const criteria = searchCriteria.current;
      const matching = result.containers.filter(container => matchesContainer(container, criteria.query, criteria.filter));
      if (initialSelection.current) { initialSelection.current = false; selectContainer(matching[0]?.fullId ?? null); }
      else {
        const retained = matching.find(container => container.fullId === selectedIdRef.current);
        if (!retained) selectContainer(null);
        else if (!result.stale && !readableStates.has(retained.state)) {
          // The identity can remain selected after its previous logs become unreadable.
          setLogs(null);
          setLogsError(null);
          setLoadingLogs(false);
        }
      }
    } catch (error) {
      if (epoch.current !== requestEpoch || session.current !== sessionId || request !== listSequence.current) return;
      const failure = coreError(error);
      setListError(failure);
      if (connectionInvalidatingErrors.has(failure.code)) {
        blocked.current = true;
        setMutationBlocked(true);
        setReconnectRequired(true);
      }
      if (currentSnapshot.current) {
        currentSnapshot.current = { ...currentSnapshot.current, stale: true };
        setSnapshot(currentSnapshot.current);
      }
    } finally {
      if (epoch.current === requestEpoch && request === listSequence.current) { refreshBusy.current = false; setRefreshing(false); }
    }
  }, [selectContainer]);
  const connect = useCallback(async () => {
    if (busy.current || refreshBusy.current) return;
    pendingBulkFocus.current = null;
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
    setBulkPending(null);
    blocked.current = true;
    setMutationBlocked(true);
    setClipboardMessage(null);
    setLogsExpanded(false);
    setCheckedHandles(new Set());
    selectContainer(null);
    initialSelection.current = true;
    try {
      const result = await api.getEnvironment();
      if (epoch.current !== requestEpoch) return;
      setEnvironment(result);
      if (result.status === 'ready' && result.sessionId) {
        session.current = result.sessionId;
        setReconnectRequired(false);
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
  }, [refresh, selectContainer]);
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
    setLogsError(null);
    try {
      const result = await api.getRecentLogs(list.sessionId, container.handle);
      if (epoch.current !== requestEpoch || request !== logSequence.current || currentSnapshot.current?.generation !== list.generation) return;
      if (result.sessionId !== list.sessionId || result.generation !== list.generation || result.handle !== container.handle) throw { code: 'STALE_RESPONSE', message: '이전 로그 응답입니다. Recent Logs로 다시 조회하세요.' };
      if (selectedIdRef.current !== container.fullId) return;
      setLogs({ ...result, fetchedAt: new Date().toISOString() });
    } catch (error) {
      if (epoch.current === requestEpoch && request === logSequence.current) {
        const failure = coreError(error);
        setLogsError(failure);
        if (connectionInvalidatingErrors.has(failure.code)) {
          blocked.current = true;
          setMutationBlocked(true);
          setReconnectRequired(true);
        }
      }
    } finally {
      if (epoch.current === requestEpoch && request === logSequence.current) setLoadingLogs(false);
    }
  }, []);
  useEffect(() => {
    ++logSequence.current;
    if (selected && snapshot && !refreshing && !mutating) void loadLogs(selected, snapshot);
  }, [selected, snapshot, refreshing, mutating, loadLogs]);
  async function mutate(container: Container, action: Action, targetSession: string, generation: number) {
    const current = currentSnapshot.current;
    const currentContainer = current?.containers.find(item => item.handle === container.handle);
    const criteria = searchCriteria.current;
    const actionAllowed = currentContainer && canApply(currentContainer, action) && matchesContainer(currentContainer, criteria.query, criteria.filter);
    if (busy.current || refreshBusy.current || blocked.current || selectedIdRef.current !== container.fullId || !actionAllowed || session.current !== targetSession || current?.stale || current?.generation !== generation || !current.containers.some(item => item.handle === container.handle)) return;
    busy.current = true;
    setMutating(true);
    setOperation(null);
    setBulkOperation(null);
    setConfirmation(null);
    const requestEpoch = epoch.current;
    const target = connectionTarget(environment);
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
    if (blocked.current) setReconnectRequired(true);
    setOperation({ ...result, fullId: container.fullId, name: container.name, action, ...target });
    await refresh(targetSession);
    if (epoch.current === requestEpoch) { busy.current = false; setMutating(false); }
  }
  function requestAction(action: Action, returnFocus?: HTMLElement) {
    if (settingsOpen || logsExpanded || busy.current || refreshBusy.current || blocked.current || !selected || selectedIdRef.current !== selected.fullId || !snapshot || snapshot.stale || !environment?.mutationAllowed || !session.current || !canApply(selected, action)) return;
    if (action === 'start') void mutate(selected, action, session.current, snapshot.generation);
    else setConfirmation({ container: selected, action, sessionId: session.current, generation: snapshot.generation, ...connectionTarget(environment), returnFocus });
  }
  async function mutateBulk(containers: Container[], action: Action, targetSession: string, generation: number) {
    const current = currentSnapshot.current;
    const criteria = searchCriteria.current;
    if (containers.some(container => !matchesContainer(container, criteria.query, criteria.filter))) return;
    if (busy.current || refreshBusy.current || blocked.current || !containers.length || !containers.some(container => canApply(container, action)) || session.current !== targetSession || current?.stale || current?.generation !== generation || containers.some(container => !current.containers.some(item => item.handle === container.handle))) return;
    if (action !== 'start') pendingBulkFocus.current = { epoch: epoch.current };
    busy.current = true;
    setMutating(true);
    setBulkPending({ action, count: containers.filter(container => canApply(container, action)).length });
    setBulkOperation(null);
    setOperation(null);
    setConfirmation(null);
    const requestEpoch = epoch.current;
    const context = { action, ...connectionTarget(environment), containers };
    try {
      const result = await api.mutateContainers(targetSession, generation, containers.map(container => container.handle), action);
      if (epoch.current !== requestEpoch) return;
      if (!isBoundBulkResult(result, targetSession, generation, containers, action)) throw { code: 'INVALID_BULK_RESPONSE', message: '요청 대상과 일치하는 전체 일괄 응답을 확인하지 못했습니다.' };
      blocked.current = blocked.current || result.mutationBlocked || result.items.some(item => item.result?.mutationBlocked || item.result?.reconciliation === 'failed');
      setBulkOperation({ ...context, result, needsReconnect: blocked.current });
    } catch (error) {
      if (epoch.current !== requestEpoch) return;
      const failure = coreError(error);
      // Only these structured native rejections prove that no command was dispatched.
      const preflightRejection = ['Busy', 'StaleSession', 'NeedsValidation', 'StaleHandle', 'InvalidSelection'].includes(failure.code);
      const recoverableRejection = ['Busy', 'StaleHandle', 'InvalidSelection'].includes(failure.code);
      blocked.current = blocked.current || !recoverableRejection;
      setBulkOperation({ ...context, error: failure, uncertain: !preflightRejection, needsReconnect: blocked.current });
    } finally {
      if (epoch.current === requestEpoch) {
        setMutationBlocked(blocked.current);
        if (blocked.current) setReconnectRequired(true);
        await refresh(targetSession);
        if (epoch.current === requestEpoch) { busy.current = false; setMutating(false); setBulkPending(null); }
      }
    }
  }
  function requestBulkAction(action: Action, returnFocus?: HTMLElement) {
    if (settingsOpen || logsExpanded || busy.current || refreshBusy.current || blocked.current || !checked.length || !checked.some(container => canApply(container, action)) || !snapshot || snapshot.stale || !environment?.mutationAllowed || !session.current) return;
    if (action === 'start') void mutateBulk(checked, action, session.current, snapshot.generation);
    else setConfirmation({ containers: checked, action, sessionId: session.current, generation: snapshot.generation, ...connectionTarget(environment), returnFocus });
  }
  function changeSelection(next: (previous: Set<string>) => Set<string>) {
    if (busy.current || refreshBusy.current || !currentSnapshot.current || currentSnapshot.current.stale) return;
    setCheckedHandles(next);
  }
  async function copy(text: string, label: CopyLabel) {
    try { await navigator.clipboard.writeText(text); setClipboardMessage({ key: 'copied', label }); }
    catch { setClipboardMessage({ key: 'copyFailure' }); }
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
    if (item) { selectContainer(item.fullId); inventory.current?.querySelectorAll<HTMLButtonElement>('.container-row')[next]?.focus(); }
  }
  const ready = environment?.status === 'ready' && !!environment.sessionId;
  const connectionStatus = connecting ? t('checking') : reconnectRequired ? t('reconnectRequired') : ready ? t('connected') : t('disconnected');
  const connectionClass = connecting ? 'checking' : reconnectRequired ? 'reconnect-required' : ready ? 'connected' : '';
  const connectionError = environmentError ?? environment?.error ?? null;
  const [connectionTitle, connectionHelp] = connectionIssue(connectionError, environment?.status === 'unsupported');
  const copyFeedback = clipboardMessage ? clipboardMessage.key === 'copied' ? t('copied', { label: t(clipboardMessage.label) }) : t('copyFailure') : '';
  return <div className="app-shell">
    <div className="main-content" inert={!!confirmation || settingsOpen || logsExpanded}>
      <header className="app-header">
        <div className="brand"><span className="brand-icon" aria-hidden="true"><Boxes size={22} /></span><div><h1>Docker2U</h1><p>{t('tagline')}</p></div></div>
        <div className="header-right"><span className="platform-badge"><Monitor size={14} aria-hidden="true" />{t('platform')}</span>
          <button className="icon-button" aria-label={t('showDiagnostics')} aria-expanded={showDiagnostics} onClick={() => setShowDiagnostics(!showDiagnostics)}><Info size={18} aria-hidden="true" /></button>
          <button ref={settingsTrigger} className="icon-button" aria-label={t('settings')} title={t('settings')} aria-haspopup="dialog" onClick={() => { if (!confirmation && !logsExpanded) setSettingsOpen(true); }}><Settings size={18} aria-hidden="true" /></button>
        </div>
      </header>
      <section className="connection-bar" aria-label={t('connection')}>
        <div className="connection-label"><span className={`connection-dot ${connectionClass}`} /><div className="connection-target"><strong>{environment?.contextName ?? t('contextPending')}</strong><code title={environment?.endpoint ?? undefined}>{environment?.endpoint ?? t('endpointPending')}</code></div><span className="connection-status" role="status">{connectionStatus}</span></div>
        <div className="connection-actions"><button title={t('reconnectHint')} onClick={() => void connect()} disabled={connecting || refreshing || mutating}><Cable size={14} aria-hidden="true" />{t('reconnect')}</button><button title={t('refreshHint')} className="primary-button" disabled={!ready || refreshing || mutating} onClick={() => { if (session.current && !busy.current && !refreshBusy.current) void refresh(session.current); }}><RefreshCw size={14} className={refreshing ? 'spin' : ''} aria-hidden="true" />{t(refreshing ? 'refreshing' : 'refresh')}</button></div>
      </section>
      <p className="connection-help">{t('connectionHelp')}</p>
      {showDiagnostics && <Diagnostics environment={environment} close={() => setShowDiagnostics(false)} copy={copy} />}
      <main className="workspace">
        <aside className="inventory-panel" aria-labelledby="inventory-title">
          <div className="panel-heading"><h2 id="inventory-title">{t('containers')} <span className="count-badge">{snapshot?.containers.length ?? '—'}</span></h2><span className="muted small">{t('manual')}</span></div>
          <div className="inventory-controls"><div className="search-field"><Search size={16} aria-hidden="true" /><input ref={searchInput} aria-label={t('search')} placeholder={t('searchHint')} value={query} disabled={mutating} onChange={event => updateSearch(event.target.value, filter)} />{query && <button className="search-clear" aria-label={t('clearSearch')} title={t('clearSearch')} disabled={mutating} onClick={() => { updateSearch('', filter); searchInput.current?.focus(); }}><X size={14} aria-hidden="true" /></button>}</div><div className="filter-group" aria-label={t('filters')}>{(['all', 'running', 'stopped', 'attention'] as const).map(value => <button key={value} aria-pressed={filter === value} disabled={mutating} onClick={() => updateSearch(query, value)}>{t(value)}</button>)}</div></div>
          <BulkSelection visible={visible} checked={checked} disabled={mutating || refreshing || connecting || !snapshot || snapshot.stale} actionsDisabled={mutating || refreshing || mutationBlocked || !environment?.mutationAllowed || !snapshot || snapshot.stale} pending={bulkPending} selectAllRef={bulkSelectAll} regionRef={bulkRegion} onToggleAll={() => changeSelection(() => checked.length === visible.length ? new Set() : new Set(visible.map(container => container.handle)))} onClear={() => changeSelection(() => new Set())} onAction={requestBulkAction} />
          {snapshot?.stale && <div className="stale-notice" role="status"><AlertTriangle size={14} aria-hidden="true" /><span>{t('stale')}</span></div>}
          {listError && <div className="inline-error" role="alert"><p>{t('listFailure')}</p>{connectionInvalidatingErrors.has(listError.code) && <p>{t('validateAgain')}</p>}<ErrorDetails error={listError} /></div>}
          <ul ref={inventory} aria-label={t('containerList')} aria-busy={refreshing || mutating} className="container-list">{visible.map((container, index) => <li key={container.fullId} className="container-list-item"><input type="checkbox" className="container-checkbox" aria-label={t('selectTarget', { name: container.name })} checked={checkedHandles.has(container.handle)} disabled={mutating || refreshing || !!snapshot?.stale} onChange={() => changeSelection(previous => { const next = new Set(previous); if (next.has(container.handle)) next.delete(container.handle); else next.add(container.handle); return next; })} /><button aria-label={t('detailsFor', { name: container.name })} aria-current={selectedId === container.fullId ? 'true' : undefined} tabIndex={selectedId === container.fullId || (!visible.some(item => item.fullId === selectedId) && index === 0) ? 0 : -1} className="container-row" onClick={() => selectContainer(container.fullId)} onKeyDown={event => selectWithKeyboard(event, index)}><span className="container-row-title"><strong>{container.name}</strong><ChevronRight size={15} aria-hidden="true" /></span><span className="container-image">{container.image}</span><span className="container-statuses"><State value={container.state} /><Health value={container.health} /></span></button></li>)}</ul>
          {!visible.length && <div className="inventory-placeholder"><Boxes size={28} aria-hidden="true" /><p>{t(connecting || (refreshing && !snapshot) ? 'checkingContainers' : !ready ? 'connectForList' : !snapshot ? 'reloadList' : snapshot.containers.length === 0 ? 'emptyEngine' : 'noResults')}</p>{snapshot && snapshot.containers.length > 0 && <button className="text-button" disabled={mutating} onClick={() => updateSearch('', 'all')}>{t('resetFilters')}</button>}</div>}
        </aside>
        <section className="detail-panel" aria-label={t(selected ? 'detailTitle' : 'connectTitle')}>
          <div className="detail-context" tabIndex={0} aria-label={t('detailContext')}>
            {(operation || bulkOperation) && <div className="latest-operation" aria-label={t('latestOperation')}>{operation ? <OperationResult operation={operation} copy={copy} /> : bulkOperation && <BulkResult operation={bulkOperation} />}</div>}
            {selected && snapshot ? <ContainerSummary container={selected} snapshot={snapshot} copy={copy} mutating={mutating} mutationBlocked={mutationBlocked} mutationAllowed={!!environment?.mutationAllowed} /> : <div className="panel-heading"><h2>{t('connectTitle')}</h2></div>}
          </div>
          {connecting ? <div className="startup-panel"><div className="startup-icon"><LoaderCircle className="spin" size={30} aria-hidden="true" /></div><h3>{t('checkingLocal')}</h3><p>{t('checkingCli')}</p></div> : !ready ? <div className="startup-panel"><div className="startup-icon"><Cable size={32} aria-hidden="true" /></div><span className="eyebrow">{t('localEnvironment')}</span><h3>{t(connectionTitle)}</h3><p>{t(connectionHelp)}</p>{connectionError && <div role="alert"><ErrorDetails error={connectionError} /></div>}{!!environment?.diagnostics.length && <details className="technical-details"><summary>{t('originalDiagnostics')}</summary>{environment.diagnostics.map((message, index) => <p key={index}>{message}</p>)}</details>}<button className="primary-button" onClick={() => void connect()}><RefreshCw size={14} aria-hidden="true" />{t('reconnect')}</button></div> : selected && snapshot ? <ContainerDetail container={selected} snapshot={snapshot} logs={logs} logsError={logsError} loadingLogs={loadingLogs} refreshing={refreshing} mutating={mutating} mutationBlocked={mutationBlocked} mutationAllowed={!!environment?.mutationAllowed} loadLogs={() => void loadLogs(selected, snapshot)} clearLogs={() => { ++logSequence.current; setLogs(null); setLogsError(null); setLoadingLogs(false); }} requestAction={requestAction} copy={copy} copyFeedback={copyFeedback} logsExpanded={logsExpanded} onLogsExpandedChange={setLogsExpanded} /> : <div className="startup-panel"><div className="startup-icon"><Boxes size={32} aria-hidden="true" /></div><h3>{t(refreshing ? 'loadingContainers' : snapshot?.containers.length === 0 ? 'noContainers' : 'selectContainer')}</h3><p>{t(snapshot?.containers.length === 0 ? 'startServices' : 'selectHelp')}</p></div>}
        </section>
      </main>
      <footer className="app-footer"><span><span className="footer-dot" />{t('footer')}</span><span className="clipboard-feedback" role="status" aria-live="polite">{copyFeedback}</span><span className="footer-connection" role="status">{connectionStatus}</span></footer>
    </div>
    {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} returnFocus={settingsTrigger.current ?? undefined} />}
    {confirmation && <ConfirmDialog confirmation={confirmation} onCancel={() => setConfirmation(null)} onConfirm={() => { if (confirmation.containers) void mutateBulk(confirmation.containers, confirmation.action, confirmation.sessionId, confirmation.generation); else void mutate(confirmation.container, confirmation.action, confirmation.sessionId, confirmation.generation); }} />}
  </div>;
}
