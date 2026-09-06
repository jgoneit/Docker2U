import { useEffect, useRef } from 'react';
import type { KeyboardEvent, MouseEvent } from 'react';
import { AlertTriangle, Boxes, CheckCircle2, Copy, FileText, LoaderCircle, Play, RefreshCw, Square, X } from 'lucide-react';
import type { Action, Container, ContainerList, CoreError, Environment, MutationResult, RecentLogs } from './api';
import { diagnosticsText } from './api';

export const stateLabels: Record<string, string> = { created: 'Created', running: 'Running', paused: 'Paused', restarting: 'Restarting', removing: 'Removing', exited: 'Stopped', dead: 'Error', unknown: 'Unknown' };
export const actionLabels: Record<Action, string> = { start: 'Start', stop: 'Stop', restart: 'Restart' };
export const readableStates = new Set(['created', 'running', 'paused', 'restarting', 'exited', 'dead']);
export type Operation = MutationResult & { fullId: string; name: string; action: Action; profile: string };
export type Confirmation = { action: 'stop' | 'restart'; sessionId: string; generation: number; profile: string; endpoint: string; returnFocus?: HTMLElement }
  & ({ container: Container; containers?: never } | { containers: Container[]; container?: never });
export type CopyText = (text: string, label: string) => Promise<void>;

export function formatTime(value?: string) {
  if (!value) return '아직 갱신하지 않음';
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? value : parsed.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
export function Health({ value }: { value: string | null }) {
  const label = !value || value === 'none' ? 'Healthcheck 없음' : value === 'healthy' ? 'Healthy' : value === 'unhealthy' ? 'Unhealthy' : value === 'starting' ? 'Health starting' : 'Health unknown';
  return <span className={`health health-${value ?? 'none'}`}>{label}</span>;
}
export function State({ value }: { value: string }) {
  return <span className={`state state-${value}`}><span className="state-dot" />{stateLabels[value] ?? 'Unknown'}</span>;
}
export function ErrorDetails({ error }: { error: CoreError }) {
  return <details className="technical-details"><summary>진단 상세 · {error.code}</summary>{error.command && <pre>{error.command}</pre>}{error.stderr && <pre>{error.stderr}</pre>}</details>;
}
export function ConfirmDialog({ confirmation, onCancel, onConfirm }: { confirmation: Confirmation; onCancel: () => void; onConfirm: () => void }) {
  const dialog = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const targets = confirmation.containers?.filter(container => container.state === 'running');
  const excluded = confirmation.containers?.filter(container => container.state !== 'running');
  useEffect(() => {
    const previousFocus = confirmation.returnFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    cancel.current?.focus();
    return () => previousFocus?.focus();
  }, [confirmation.returnFocus]);
  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') { event.preventDefault(); onCancel(); }
    if (event.key !== 'Tab') return;
    const elements = dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
    const first = elements?.[0];
    const last = elements?.[elements.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
  return <div className="modal-backdrop">
    <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-description" className="confirm-dialog" onKeyDown={keyDown}>
      <div className="dialog-icon"><AlertTriangle size={24} aria-hidden="true" /></div>
      <h2 id="confirm-title">{actionLabels[confirmation.action]} {targets ? `${targets.length}개 Container` : confirmation.container?.name}?</h2>
      <p id="confirm-description">{confirmation.action === 'stop' ? '서비스가 중단됩니다. 종료 대기 시간이 지나면 강제로 종료될 수 있습니다.' : '서비스가 잠시 중단됩니다. 진행 중인 요청에 영향을 줄 수 있습니다.'}</p>
      <dl className="confirm-target">{confirmation.container && <><dt>Container</dt><dd>{confirmation.container.name}</dd><dt>ID</dt><dd>{confirmation.container.shortId}</dd></>}<dt>Context</dt><dd>{confirmation.profile}</dd><dt>Endpoint</dt><dd>{confirmation.endpoint}</dd></dl>
      {targets && <div className="confirm-bulk-targets"><h3>실행 대상 · {targets.length}개</h3><ul>{targets.map(container => <li key={container.handle}><strong>{container.name}</strong><code>{container.fullId}</code></li>)}</ul><h3>제외 대상 · {excluded?.length ?? 0}개</h3>{excluded?.length ? <ul>{excluded.map(container => <li key={container.handle}><strong>{container.name}</strong><code>{container.fullId}</code><p>{stateLabels[container.state] ?? 'Unknown'} 상태 · Running에서만 {actionLabels[confirmation.action]} 가능</p></li>)}</ul> : <p>제외되는 대상이 없습니다.</p>}</div>}
      <div className="dialog-actions"><button ref={cancel} onClick={onCancel}>취소</button><button className="danger-button" onClick={onConfirm}>{actionLabels[confirmation.action]} 확인</button></div>
    </div>
  </div>;
}
export function Diagnostics({ environment, close, copy }: { environment: Environment | null; close: () => void; copy: CopyText }) {
  return <section className="diagnostics-panel" aria-label="환경 진단 상세">
    <div className="section-heading"><h2>환경 진단</h2><button className="icon-button" aria-label="환경 진단 닫기" onClick={close}><X size={16} aria-hidden="true" /></button></div>
    {environment ? <><dl className="diagnostics-grid">{[['Context', environment.profile], ['Endpoint', environment.endpoint], ['Docker CLI', environment.dockerPath], ['Colima CLI', environment.colimaPath], ['Client', environment.clientVersion], ['Colima', environment.runtimeVersion], ['Server / API', `${environment.serverVersion ?? '—'} / ${environment.apiVersion ?? '—'}`], ['Engine', environment.engineId], ['OS / Architecture', `${environment.osType ?? '—'} / ${environment.architecture ?? '—'}`]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value ?? '확인되지 않음'}</dd></div>)}</dl><button onClick={() => void copy(diagnosticsText(environment), '진단 정보')}><Copy size={14} aria-hidden="true" />Copy diagnostics</button><p className="muted small">버전·경로·연결 정보만 복사합니다. 로그와 환경 변수는 포함하지 않습니다.</p></> : <p className="muted">환경 진단 결과가 아직 없습니다.</p>}
  </section>;
}
export function ContainerDetail({ container, snapshot, logs, logsError, loadingLogs, refreshing, mutating, mutationBlocked, mutationAllowed, operation, loadLogs, clearLogs, requestAction, copy }: {
  container: Container; snapshot: ContainerList; logs: RecentLogs | null; logsError: CoreError | null;
  loadingLogs: boolean; refreshing: boolean; mutating: boolean; mutationBlocked: boolean; mutationAllowed: boolean;
  operation: Operation | null; loadLogs: () => void; clearLogs: () => void; requestAction: (action: Action, returnFocus?: HTMLElement) => void; copy: CopyText;
}) {
  const actionsDisabled = !mutationAllowed || mutationBlocked || snapshot.stale || refreshing || mutating;
  function requestConfirmation(event: MouseEvent<HTMLButtonElement>, action: 'stop' | 'restart') {
    // Preserve the trigger even if WebKit leaves focus elsewhere or inert later clears it.
    event.currentTarget.focus();
    requestAction(action, event.currentTarget);
  }
  return <div className="container-detail">
    <div className="detail-title"><div className="container-icon"><Boxes size={25} aria-hidden="true" /></div><div><span className="eyebrow">CONTAINER</span><h3>{container.name}</h3><p>{container.image}</p></div></div>
    <div className="status-grid"><div><span className="field-label">STATE</span><State value={container.state} /></div><div><span className="field-label">HEALTH</span><Health value={container.health} /></div><div><span className="field-label">LAST UPDATED</span><span className="updated-time">{formatTime(snapshot.refreshedAt)}{snapshot.stale && <span className="stale-tag">Stale</span>}</span></div></div>
    <dl className="container-facts"><div><dt>Container ID</dt><dd><code title={container.fullId}>{container.shortId}</code><button className="icon-button" aria-label="Full ID 복사" onClick={() => void copy(container.fullId, 'Full ID')}><Copy size={13} aria-hidden="true" /></button></dd></div><div><dt>Ports</dt><dd>{container.ports.length ? container.ports.join(' · ') : '게시된 포트 없음'}</dd></div></dl>
    <section className="logs-panel" aria-labelledby="logs-title">
      <div className="section-heading"><h3 id="logs-title"><FileText size={16} aria-hidden="true" />최근 로그</h3><div className="compact-actions"><button disabled={snapshot.stale || loadingLogs || refreshing || mutating || !readableStates.has(container.state)} onClick={loadLogs}><RefreshCw size={13} className={loadingLogs ? 'spin' : ''} aria-hidden="true" />Recent Logs</button><button disabled={!logs?.text} onClick={() => { if (logs) void copy(logs.text, '표시된 로그'); }} aria-label="표시된 로그 복사"><Copy size={13} aria-hidden="true" /></button><button disabled={!logs} onClick={clearLogs} aria-label="로그 화면 비우기"><X size={13} aria-hidden="true" /></button></div></div>
      <div className="log-meta"><span>최근 300줄 · 최대 2 MiB · Snapshot</span><span>로그에 민감정보가 포함될 수 있습니다.</span></div>
      {logs?.truncated && <p className="truncation-notice" role="status">로그 앞부분이 잘렸습니다. 마지막 2 MiB만 표시·복사합니다.</p>}
      {logsError ? <div className="log-error" role="alert"><p>최근 로그를 읽지 못했습니다.</p><p>{logsError.message}</p><ErrorDetails error={logsError} /></div> : <pre className={`log-content ${!logs?.text ? 'log-placeholder' : ''}`} aria-label="최근 로그 내용" aria-busy={loadingLogs}>{loadingLogs ? '최근 로그를 불러오는 중…' : logs?.text || (snapshot.stale ? '목록을 갱신한 뒤 로그를 조회하세요.' : !readableStates.has(container.state) ? '현재 상태에서는 로그를 조회할 수 없습니다.' : logs ? '최근 로그가 없습니다.' : 'Recent Logs를 눌러 로그를 조회하세요.')}</pre>}
    </section>
    <section className="recovery-panel" aria-labelledby="recovery-title"><div><h3 id="recovery-title">서비스 복구</h3><p>현재 상태를 확인한 뒤 필요한 작업을 실행하세요.</p></div><div className="recovery-actions"><button className="primary-button" disabled={actionsDisabled || !['created', 'exited'].includes(container.state)} onClick={() => requestAction('start')}><Play size={14} aria-hidden="true" />Start</button><button disabled={actionsDisabled || container.state !== 'running'} onClick={event => requestConfirmation(event, 'stop')}><Square size={13} aria-hidden="true" />Stop</button><button disabled={actionsDisabled || container.state !== 'running'} onClick={event => requestConfirmation(event, 'restart')}><RefreshCw size={14} aria-hidden="true" />Restart</button></div></section>
    {mutating && <p className="operation-notice" role="status"><LoaderCircle size={16} className="spin" aria-hidden="true" />작업 실행 및 상태 재조회 중입니다.</p>}
    {mutationBlocked && <div className="operation-warning" role="alert">추가 복구 작업이 차단되었습니다. Reconnect로 환경을 다시 검증하세요.</div>}
    {snapshot.stale && <p className="operation-warning">최신 상태를 확인할 수 없어 복구 작업을 잠시 사용할 수 없습니다. Refresh를 실행하세요.</p>}
    {operation && <section className={`operation-result outcome-${operation.outcome}`} aria-label="최근 작업 결과">
      <h3>{operation.outcome === 'succeeded' ? <CheckCircle2 size={16} aria-hidden="true" /> : <AlertTriangle size={16} aria-hidden="true" />}{operation.outcome === 'succeeded' ? 'Succeeded' : operation.outcome === 'failed' ? 'Failed' : 'ResultUnknown · 결과 불확실'}</h3>
      <p>{operation.action} · {operation.name} · {operation.profile}</p><p>{operation.message}</p>
      {operation.outcome === 'resultUnknown' && <p>명령 결과를 확정할 수 없습니다. 자동 재시도하지 않았습니다. 현재 상태가 같더라도 성공을 의미하지 않습니다.</p>}
      {operation.reconciliation !== 'notNeeded' && <p>{operation.reconciliation === 'succeeded' ? `대상 상태 재조회 완료${operation.observedState ? ` · ${stateLabels[operation.observedState] ?? operation.observedState}` : ''}. 원래 작업 결과는 유지됩니다.` : '대상 상태 재조회 실패. Reconnect가 필요합니다.'}</p>}
      {(operation.command || operation.stderr) && <details className="technical-details"><summary>실행 상세 · Equivalent command</summary>{operation.command && <><pre>{operation.command}</pre><button onClick={() => void copy(operation.command, 'Equivalent command')}><Copy size={13} aria-hidden="true" />명령 복사</button></>}{operation.exitCode != null && <p>Exit code: {operation.exitCode}</p>}{operation.durationMs != null && <p>경과 시간: {operation.durationMs} ms</p>}{operation.stderr && <pre>{operation.stderr}</pre>}</details>}
    </section>}
  </div>;
}
