import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent, MouseEvent, RefObject } from 'react';
import { AlertTriangle, Boxes, CheckCircle2, Copy, LoaderCircle, Play, RefreshCw, Square, X } from 'lucide-react';
import type { Action, ConnectionTarget, Container, ContainerList, CoreError, Environment, MutationResult } from './api';
import { diagnosticsText } from './api';
import { displayErrorMessage, type FrontendErrorDescriptor } from './frontendErrors';
import { LogPanel } from './LogPanel';
import type { LogSnapshot } from './logSnapshot';
import type { FrontendSession, SessionIssue } from './frontendSession';
import { translate, useI18n } from './i18n';
import { componentMessages } from './messages/components';
import { usePreferences, type Language } from './preferences';
import { formatDisplayTime, parseTimestamp } from './time';

export function stateLabel(state: string, language: Language) {
  const key = (['created', 'running', 'paused', 'restarting', 'removing', 'exited', 'dead'] as const).find(key => key === state) ?? 'unknown';
  return translate(componentMessages, language, key);
}
export function actionLabel(action: Action, language: Language) { return translate(componentMessages, language, action); }
// Retained for consumers that explicitly require the Docker/English labels.
export const stateLabels: Record<string, string> = { created: 'Created', running: 'Running', paused: 'Paused', restarting: 'Restarting', removing: 'Removing', exited: 'Stopped', dead: 'Error', unknown: 'Unknown' };
export const actionLabels: Record<Action, string> = { start: 'Start', stop: 'Stop', restart: 'Restart' };
export const readableStates = new Set(['created', 'running', 'paused', 'restarting', 'exited', 'dead']);
export type Operation = MutationResult & ConnectionTarget & { fullId: string; name: string; action: Action; frontendError?: FrontendErrorDescriptor };
export type Confirmation = ConnectionTarget & { action: 'stop' | 'restart'; sessionId: string; generation: number; returnFocus?: HTMLElement }
  & ({ container: Container; containers?: never } | { containers: Container[]; container?: never });
export type CopyLabel = 'logs' | 'fullId' | 'diagnostics' | 'command';
export type CopyText = (text: string, label: CopyLabel) => Promise<void>;

export function formatTime(value?: string, language: Language = 'ko') {
  if (!value) return translate(componentMessages, language, 'notUpdated');
  const parsed = parseTimestamp(value);
  return parsed ? formatDisplayTime(parsed, language) : value;
}
export function Health({ value }: { value: string | null }) {
  const t = useI18n(componentMessages);
  const key = !value || value === 'none' ? 'noHealth' : value === 'healthy' ? 'healthy' : value === 'unhealthy' ? 'unhealthy' : value === 'starting' ? 'healthStarting' : 'healthUnknown';
  return <span className={`health health-${value ?? 'none'}`}>{t(key)}</span>;
}
export function State({ value }: { value: string }) {
  const { language } = usePreferences();
  return <span className={`state state-${value}`}><span className="state-dot" />{stateLabel(value, language)}</span>;
}
export function ErrorDetails({ error }: { error: CoreError }) {
  const t = useI18n(componentMessages);
  const { language } = usePreferences();
  return <details className="technical-details"><summary>{t('diagnosticDetails', { code: error.code })}</summary><pre tabIndex={0}>{displayErrorMessage(error, language)}</pre>{error.command && <pre tabIndex={0}>{error.command}</pre>}{error.stderr && <pre tabIndex={0}>{error.stderr}</pre>}</details>;
}
export function ConnectionFacts({ target }: { target: ConnectionTarget }) {
  const t = useI18n(componentMessages);
  return <dl className="connection-facts"><dt>{t('context')}</dt><dd>{target.contextName ?? t('unverified')}</dd><dt>{t('endpoint')}</dt><dd>{target.endpoint ?? t('unverified')}</dd><dt>{t('engine')}</dt><dd>{target.engineId ?? t('unverified')}</dd></dl>;
}
export function ConfirmDialog({ confirmation, blocked = false, reconnectFocus, onCancel, onConfirm }: {
  confirmation: Confirmation; blocked?: boolean; reconnectFocus?: RefObject<HTMLButtonElement | null>; onCancel: () => void; onConfirm: () => void;
}) {
  const t = useI18n(componentMessages);
  const { language } = usePreferences();
  const dialog = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const execute = useRef<HTMLButtonElement>(null);
  const restoreOnClose = useRef(true);
  const recoveryFocus = useRef({ blocked, reconnectFocus });
  recoveryFocus.current = { blocked, reconnectFocus };
  const targets = confirmation.containers?.filter(container => container.state === 'running');
  const excluded = confirmation.containers?.filter(container => container.state !== 'running');
  useEffect(() => {
    const previousFocus = confirmation.returnFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    cancel.current?.focus();
    return () => {
      if (!restoreOnClose.current) return;
      const recovery = recoveryFocus.current;
      (recovery.blocked ? recovery.reconnectFocus?.current ?? previousFocus : previousFocus)?.focus();
    };
  }, [confirmation.returnFocus]);
  useEffect(() => {
    // Disabling the focused execute button can leave focus on the WebView body.
    if (blocked && (document.activeElement === execute.current || !dialog.current?.contains(document.activeElement))) cancel.current?.focus();
  }, [blocked]);
  function cancelConfirmation() { restoreOnClose.current = true; onCancel(); }
  function confirm() {
    if (blocked) return;
    // Confirmed bulk actions restore focus after the operation and final refresh.
    restoreOnClose.current = !confirmation.containers;
    onConfirm();
  }
  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') { event.preventDefault(); cancelConfirmation(); }
    if (event.key !== 'Tab') return;
    const elements = dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
    const first = elements?.[0];
    const last = elements?.[elements.length - 1];
    if (event.shiftKey && (document.activeElement === first || !dialog.current?.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || !dialog.current?.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
  }
  return <div className="modal-backdrop">
    <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby={blocked ? 'confirm-description confirm-blocked' : 'confirm-description'} className="confirm-dialog" onKeyDown={keyDown}>
      <div className="dialog-icon"><AlertTriangle size={24} aria-hidden="true" /></div>
      <h2 id="confirm-title">{t('confirmTitle', { action: t(confirmation.action), target: targets ? t('containers', { count: targets.length }) : confirmation.container?.name ?? '' })}</h2>
      <p id="confirm-description">{t(confirmation.action === 'stop' ? 'stopWarning' : 'restartWarning')}</p>
      {blocked && <p id="confirm-blocked" className="confirm-blocked" role="alert">{t('confirmBlocked')}</p>}
      <div className="confirm-target">{confirmation.container && <dl className="connection-facts"><dt>{t('container')}</dt><dd>{confirmation.container.name}</dd><dt>ID</dt><dd>{confirmation.container.shortId}</dd></dl>}<ConnectionFacts target={confirmation} /></div>
      {targets && <div className="confirm-bulk-targets"><h3>{t('included', { count: targets.length })}</h3><ul>{targets.map(container => <li key={container.handle}><strong>{container.name}</strong><code>{container.fullId}</code></li>)}</ul><h3>{t('excluded', { count: excluded?.length ?? 0 })}</h3>{excluded?.length ? <ul>{excluded.map(container => <li key={container.handle}><strong>{container.name}</strong><code>{container.fullId}</code><p>{t('runningOnly', { state: stateLabel(container.state, language), action: t(confirmation.action) })}</p></li>)}</ul> : <p>{t('noExcluded')}</p>}</div>}
      <div className="dialog-actions"><button ref={cancel} onClick={cancelConfirmation}>{t('cancel')}</button><button ref={execute} className={`action-button action-${confirmation.action}`} disabled={blocked} onClick={confirm}>{t('confirm', { action: t(confirmation.action) })}</button></div>
    </div>
  </div>;
}
function DiagnosticIssue({ issue }: { issue: SessionIssue }) {
  const t = useI18n(componentMessages);
  const { language } = usePreferences();
  const stageKeys = { connect: 'stageConnect', list: 'stageList', logs: 'stageLogs', singleAction: 'stageSingleAction', bulkAction: 'stageBulkAction' } as const;
  const originKeys = { frontendError: 'originFrontendError', nativeError: 'originNativeError', exception: 'originException', nativeResult: 'originNativeResult' } as const;
  return <div className="diagnostic-issue">
    <h3>{t(issue.requiresReconnect ? 'reconnectCause' : 'latestIssue')}</h3>
    {issue.scope === 'previous' && <p className="muted small">{t('previousIssue')}</p>}
    {issue.scope === 'current' && <p className="muted small">{t(issue.requiresReconnect ? 'issueReconnectHelp' : 'issueRefreshHelp')}</p>}
    <dl className="diagnostics-grid">
      <div><dt>{t('issueStage')}</dt><dd>{t(stageKeys[issue.stage])}</dd></div>
      <div><dt>{t('issueOrigin')}</dt><dd>{t(originKeys[issue.origin])}</dd></div>
      <div><dt>{t('issueCode')}</dt><dd>{issue.code ?? t('noErrorCode')}</dd></div>
      <div><dt>{t('issueTime')}</dt><dd><time dateTime={issue.occurredAt}>{formatTime(issue.occurredAt, language)}</time></dd></div>
      {issue.outcome && <div><dt>{t('issueOutcome')}</dt><dd>{t(issue.outcome)}</dd></div>}
      {issue.reconciliation && <div><dt>{t('issueReconciliation')}</dt><dd>{t(issue.reconciliation === 'notNeeded' ? 'notNeeded' : issue.reconciliation)}</dd></div>}
    </dl>
  </div>;
}
export function Diagnostics({ environment, frontendSession, close, copy }: { environment: Environment | null; frontendSession?: FrontendSession; close: () => void; copy: CopyText }) {
  const t = useI18n(componentMessages);
  const { language } = usePreferences();
  return <section className="diagnostics-panel" aria-label={t('diagnosticsRegion')}>
    <div className="section-heading"><h2>{t('diagnostics')}</h2><button className="icon-button" aria-label={t('closeDiagnostics')} onClick={close}><X size={16} aria-hidden="true" /></button></div>
    {frontendSession && <div className="diagnostic-session"><h3>{t('currentSession')}</h3><dl className="diagnostics-grid">
      <div><dt>{t('connectionStatus')}</dt><dd>{t(frontendSession.currentStatus)}</dd></div>
      <div><dt>{t('effectiveBlocked')}</dt><dd>{t(frontendSession.effectiveMutationBlocked ? 'actionsBlocked' : 'actionsAllowed')}</dd></div>
      <div><dt>{t('reconnectNeeded')}</dt><dd>{t(frontendSession.reconnectRequired ? 'yes' : 'no')}</dd></div>
      <div><dt>{t('inventoryValidity')}</dt><dd>{t(frontendSession.inventoryStale === null ? 'noInventory' : frontendSession.inventoryStale ? 'staleInventory' : 'acceptedInventory')}</dd></div>
      <div><dt>{t('updated')}</dt><dd>{frontendSession.inventoryRefreshedAt ? <time dateTime={frontendSession.inventoryRefreshedAt}>{formatTime(frontendSession.inventoryRefreshedAt, language)}</time> : t('notUpdated')}</dd></div>
    </dl>{frontendSession.issue && <DiagnosticIssue issue={frontendSession.issue} />}</div>}
    {environment ? <div className="diagnostic-environment"><h3>{t('environmentSnapshot')}</h3><dl className="diagnostics-grid">{[[t('context'), environment.contextName], [t('endpoint'), environment.endpoint], [t('dockerCli'), environment.dockerPath], [t('dockerConfig'), environment.dockerConfigPath], [t('client'), environment.clientVersion], [t('serverApi'), `${environment.serverVersion ?? '—'} / ${environment.apiVersion ?? '—'}`], [t('engine'), environment.engineId], [t('osArch'), `${environment.osType ?? '—'} / ${environment.architecture ?? '—'}`]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value ?? t('unverified')}</dd></div>)}</dl>
      {environment.diagnostics.length > 0 && <details className="technical-details"><summary>{t('nativeDiagnostics')}</summary>{environment.diagnostics.map((message, index) => <pre key={index}>{message}</pre>)}</details>}
      {environment.error && <div role="alert"><p>{t('diagnosticsFailed')}</p><ErrorDetails error={environment.error} /></div>}
      </div> : <p className="muted">{t('noDiagnostics')}</p>}
    {(environment || frontendSession) && <><button onClick={() => void copy(diagnosticsText(environment, frontendSession), 'diagnostics')}><Copy size={14} aria-hidden="true" />{t('diagnosticsCopy')}</button><p className="muted small">{t('copyAllowlist')}</p></>}
  </section>;
}
export function ContainerSummary({ container, snapshot, copy, mutating, mutationBlocked, mutationAllowed }: {
  container: Container; snapshot: ContainerList; copy: CopyText; mutating: boolean; mutationBlocked: boolean; mutationAllowed: boolean;
}) {
  const t = useI18n(componentMessages);
  const { language } = usePreferences();
  return <div className="container-summary">
    <div className="detail-title"><div className="container-icon"><Boxes size={25} aria-hidden="true" /></div><div><span className="eyebrow">{t('container')}</span><h3>{container.name}</h3><p>{container.image}</p></div></div>
    <div className="status-grid"><div><span className="field-label">{t('state')}</span><State value={container.state} /></div><div><span className="field-label">{t('health')}</span><Health value={container.health} /></div><div><span className="field-label">{t('updated')}</span><span className="updated-time">{formatTime(snapshot.refreshedAt, language)}{snapshot.stale && <span className="stale-tag">{t('stale')}</span>}</span></div></div>
    <dl className="container-facts"><div><dt>{t('containerId')}</dt><dd><code title={container.fullId}>{container.shortId}</code><button className="icon-button" aria-label={t('copyFullId')} onClick={() => void copy(container.fullId, 'fullId')}><Copy size={13} aria-hidden="true" /></button></dd></div><div><dt>{t('ports')}</dt><dd>{container.ports.length ? container.ports.join(' · ') : t('noPorts')}</dd></div></dl>
    {mutating && <p className="operation-notice" role="status"><LoaderCircle size={16} className="spin" aria-hidden="true" />{t('operating')}</p>}
    {mutationBlocked && mutationAllowed && <div className="operation-warning" role="alert">{t('blocked')}</div>}
    {snapshot.stale && <p className="operation-warning">{t('staleActions')}</p>}
  </div>;
}
export function ContainerDetail({ container, snapshot, logs, logsError, loadingLogs, logRequestPending = false, refreshing, mutating, mutationBlocked, mutationAllowed, loadLogs, clearLogs, requestAction, copy, copyFeedback, logsExpanded, onLogsExpandedChange }: {
  container: Container; snapshot: ContainerList; logs: LogSnapshot | null; logsError: CoreError | null;
  loadingLogs: boolean; logRequestPending?: boolean; refreshing: boolean; mutating: boolean; mutationBlocked: boolean; mutationAllowed: boolean;
  loadLogs: () => void; clearLogs: () => void; requestAction: (action: Action, returnFocus?: HTMLElement) => void; copy: CopyText;
  copyFeedback?: string; logsExpanded?: boolean; onLogsExpandedChange?: (expanded: boolean) => void;
}) {
  const t = useI18n(componentMessages);
  const [localExpanded, setLocalExpanded] = useState(false);
  const expanded = logsExpanded ?? localExpanded;
  const setExpanded = onLogsExpandedChange ?? setLocalExpanded;
  useEffect(() => { setLocalExpanded(false); }, [container.handle, snapshot.sessionId]);
  const actionsDisabled = !mutationAllowed || mutationBlocked || snapshot.stale || refreshing || mutating;
  function requestConfirmation(event: MouseEvent<HTMLButtonElement>, action: 'stop' | 'restart') {
    event.currentTarget.focus();
    requestAction(action, event.currentTarget);
  }
  return <div className="container-detail">
    <section className="recovery-panel" aria-labelledby="recovery-title"><div><h3 id="recovery-title">{t('recovery')}</h3><p>{t('recoveryHint')}</p></div><div className="recovery-actions"><button className="action-button action-start" disabled={actionsDisabled || !['created', 'exited'].includes(container.state)} onClick={() => requestAction('start')}><Play size={14} aria-hidden="true" />{t('start')}</button><button className="action-button action-stop" disabled={actionsDisabled || container.state !== 'running'} onClick={event => requestConfirmation(event, 'stop')}><Square size={13} aria-hidden="true" />{t('stop')}</button><button className="action-button action-restart" disabled={actionsDisabled || container.state !== 'running'} onClick={event => requestConfirmation(event, 'restart')}><RefreshCw size={14} aria-hidden="true" />{t('restart')}</button></div></section>
    <LogPanel container={container} snapshot={snapshot} logs={logs} logsError={logsError} loadingLogs={loadingLogs} logRequestPending={logRequestPending} refreshing={refreshing} mutating={mutating} loadLogs={loadLogs} clearLogs={clearLogs} copy={copy} copyFeedback={copyFeedback} expanded={expanded} onExpandedChange={setExpanded} />
  </div>;
}

// Warnings remain visible; only definitive outcomes use the compact disclosure.
export function ResultDisclosure({ identity, children }: { identity: object; children: React.ReactNode }) {
  const t = useI18n(componentMessages);
  const id = useId();
  const [open, setOpen] = useState(false);
  useEffect(() => { setOpen(false); }, [identity]);
  return <><button className="result-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>{t(open ? 'hideResult' : 'showResult')}</button><div id={id} hidden={!open}>{children}</div></>;
}
export function OperationResult({ operation, copy }: { operation: Operation; copy: CopyText }) {
  const t = useI18n(componentMessages);
  const { language } = usePreferences();
  const warning = operation.outcome === 'resultUnknown' || operation.mutationBlocked || operation.reconciliation === 'failed';
  const content = <>
    <p>{t(operation.outcome === 'succeeded' ? 'succeededMessage' : operation.outcome === 'failed' ? 'failedMessage' : 'unknownMessage')}</p>
    {operation.reconciliation !== 'notNeeded' && <p>{operation.reconciliation === 'succeeded' ? t('reconciled', { state: operation.observedState ? ` · ${stateLabel(operation.observedState, language)}` : '' }) : t('resultReconcileFailed')}</p>}
    {operation.mutationBlocked && operation.reconciliation !== 'failed' && <p>{t('resultBlocked')}</p>}
    <details className="technical-details operation-details"><summary>{t('executionDetails')}</summary><ConnectionFacts target={operation} /><pre tabIndex={0}>{displayErrorMessage(operation, language, operation.frontendError)}</pre>
      {operation.command && <><pre tabIndex={0}>{operation.command}</pre><button onClick={() => void copy(operation.command, 'command')}><Copy size={13} aria-hidden="true" />{t('copyCommand')}</button></>}
      {operation.exitCode != null && <p>{t('exitCode', { code: operation.exitCode })}</p>}{operation.durationMs != null && <p>{t('duration', { duration: operation.durationMs })}</p>}{operation.stderr && <pre tabIndex={0}>{operation.stderr}</pre>}
    </details>
  </>;
  return <section className={`operation-result outcome-${warning ? 'resultUnknown' : operation.outcome}`} aria-label={t('operationRegion')}>
    <h3 className="operation-summary">{warning || operation.outcome !== 'succeeded' ? <AlertTriangle size={16} aria-hidden="true" /> : <CheckCircle2 size={16} aria-hidden="true" />}{t(operation.outcome)} · {actionLabel(operation.action, language)} · {operation.name}</h3>
    {warning ? content : <ResultDisclosure identity={operation}>{content}</ResultDisclosure>}
  </section>;
}
