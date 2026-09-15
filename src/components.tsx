import { ResourceMetadata, ResourceUsage } from './ResourceUsage';
import './summaryLayout.css';
import './detailTabs.css';
import type { ResourceSample } from './useContainerStats';
import type { LiveLogStatus } from './useLiveLogs';
import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent, MouseEvent, ReactNode, RefObject } from 'react';
import { AlertTriangle, CheckCircle2, Copy, Play, RefreshCw, Square, X } from 'lucide-react';
import type { Action, ConnectionTarget, Container, ContainerList, CoreError, Environment, MutationResult } from './api';
import { diagnosticsText } from './api';
import { displayErrorMessage, type FrontendErrorDescriptor } from './frontendErrors';
import { LogPanel } from './LogPanel';
import type { StandaloneLogViewCache } from './standaloneLogViewCache';
import type { CopyFeedbackTone } from './CopyFeedback';
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
export type CopyLabel = 'logs' | 'fullId' | 'diagnostics' | 'command' | 'address' | 'healthOutput' | 'path';
export type DetailTab = 'logs' | 'diagnostics' | 'connectivity' | 'storage' | 'history';
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
  const stageKeys = { connect: 'stageConnect', list: 'stageList', logs: 'stageLogs', stats: 'stageStats', details: 'stageDetails', singleAction: 'stageSingleAction', bulkAction: 'stageBulkAction' } as const;
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
export function ContainerSummary({ container, snapshot, mutationBlocked, mutationAllowed, resourceSample }: {
  container: Container; snapshot: ContainerList; mutationBlocked: boolean; mutationAllowed: boolean; resourceSample?: ResourceSample;
}) {
  const t = useI18n(componentMessages);
  return <div className="container-summary">
    <div className="summary-overview"><div className="summary-identity"><h3 title={container.name}>{container.name}</h3><div className="summary-status"><State value={container.state} />{container.health && container.health !== 'none' && <span role="group" aria-label={t('health')} title={t('health')}><Health value={container.health} /></span>}{snapshot.stale && <span className="stale-tag">{t('stale')}</span>}{resourceSample?.stale && <span className="resource-stale" role="status">{t('resourceStale')}</span>}</div></div></div>
    {mutationBlocked && mutationAllowed && <div className="operation-warning" role="alert">{t('blocked')}</div>}
    {snapshot.stale && <p className="operation-warning">{t('staleActions')}</p>}
  </div>;
}
export function ContainerInformation({ container, snapshot, copy, resourceSample }: {
  container: Container; snapshot: ContainerList; copy: CopyText; resourceSample?: ResourceSample;
}) {
  const t = useI18n(componentMessages);
  const { language } = usePreferences();
  return <section className="container-information" aria-label={t('containerInfo')}>
    <h3>{t('containerInfo')}</h3>
    <ResourceUsage sample={resourceSample} />
    <dl className="summary-facts">
      <div><dt>{t('image')}</dt><dd>{container.image}</dd></div>
      <div><dt>{t('containerId')}</dt><dd><code>{container.fullId}</code><button className="icon-button" aria-label={t('copyFullId')} onClick={() => void copy(container.fullId, 'fullId')}><Copy size={13} aria-hidden="true" /></button></dd></div>
      <div><dt>{t('project')}</dt><dd>{container.composeProject || t('noProject')}</dd></div>
      <div><dt>{t('service')}</dt><dd>{container.composeService || '—'}</dd></div>
      {(!container.health || container.health === 'none') && <div><dt>{t('health')}</dt><dd><Health value={container.health} /></dd></div>}
      <div><dt>{t('updated')}</dt><dd><time dateTime={snapshot.refreshedAt}>{formatTime(snapshot.refreshedAt, language)}</time></dd></div>
    </dl>
    <ResourceMetadata sample={resourceSample} />
  </section>;
}
export function ContainerDetail({ container, snapshot, logs, logsError, loadingLogs, logRequestPending = false, refreshing, mutating, mutationBlocked, mutationAllowed, loadLogs, clearLogs, requestAction, copy, copyFeedback, copyFeedbackTone, copyFeedbackId, copyFeedbackHighlighted, copyFeedbackHighlightUntil, logsExpanded, onLogsExpandedChange, liveStatus, activeTab = 'logs', onTabChange, insights, operationFeedback, logContent, historyEnabled = false, logViewCache, exportAction }: {
  container: Container; snapshot: ContainerList; logs: LogSnapshot | null; logsError: CoreError | null;
  loadingLogs: boolean; logRequestPending?: boolean; refreshing: boolean; mutating: boolean; mutationBlocked: boolean; mutationAllowed: boolean;
  loadLogs: () => void; clearLogs: () => void; requestAction: (action: Action, returnFocus?: HTMLElement) => void; copy: CopyText;
  liveStatus?: LiveLogStatus; copyFeedback?: string; copyFeedbackTone?: CopyFeedbackTone; copyFeedbackId?: number; copyFeedbackHighlighted?: boolean; copyFeedbackHighlightUntil?: number; logsExpanded?: boolean; onLogsExpandedChange?: (expanded: boolean) => void;
  exportAction?: ReactNode; historyEnabled?: boolean; logContent?: ReactNode; logViewCache?: StandaloneLogViewCache; activeTab?: DetailTab; onTabChange?: (tab: DetailTab) => void; insights?: ReactNode; operationFeedback?: ReactNode;
}) {
  const t = useI18n(componentMessages);
  const tabId = useId();
  const tabs: DetailTab[] = historyEnabled ? ['logs', 'diagnostics', 'connectivity', 'storage', 'history'] : ['logs', 'diagnostics', 'connectivity', 'storage'];
  const tabLabels = { logs: 'tabLogs', diagnostics: 'tabDiagnostics', connectivity: 'tabConnectivity', storage: 'tabStorage', history: 'tabHistory' } as const;
  function tabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  }
  const [localExpanded, setLocalExpanded] = useState(false);
  const expanded = logsExpanded ?? localExpanded;
  const setExpanded = onLogsExpandedChange ?? setLocalExpanded;
  useEffect(() => { setLocalExpanded(false); }, [container.handle, snapshot.sessionId]);
  const actionsDisabled = !mutationAllowed || mutationBlocked || snapshot.stale || refreshing || mutating;
  function requestConfirmation(event: MouseEvent<HTMLButtonElement>, action: 'stop' | 'restart') {
    event.currentTarget.focus();
    requestAction(action, event.currentTarget);
  }
  return <div className={`container-detail${logContent && activeTab === 'logs' ? ' project-log-detail' : ''}`}>
    <section className="recovery-panel detail-toolbar" aria-label={t('recovery')}>
      <div className="detail-tabs" role="tablist" aria-label={t('detailTabs')}>{tabs.map((tab, index) => <button key={tab} data-detail-tab={tab} type="button" role="tab" id={`${tabId}-${tab}-tab`} aria-selected={activeTab === tab} aria-controls={`${tabId}-${tab}-panel`} tabIndex={activeTab === tab ? 0 : -1} onClick={() => onTabChange?.(tab)} onKeyDown={event => tabKeyDown(event, index)}>{t(tabLabels[tab])}</button>)}</div>
      <div className="recovery-actions"><button className="action-button action-start" disabled={actionsDisabled || !['created', 'exited'].includes(container.state)} onClick={() => requestAction('start')}><Play size={14} aria-hidden="true" />{t('start')}</button><button className="action-button action-stop" disabled={actionsDisabled || container.state !== 'running'} onClick={event => requestConfirmation(event, 'stop')}><Square size={13} aria-hidden="true" />{t('stop')}</button><button className="action-button action-restart" disabled={actionsDisabled || container.state !== 'running'} onClick={event => requestConfirmation(event, 'restart')}><RefreshCw size={14} aria-hidden="true" />{t('restart')}</button>{exportAction}</div>
    </section>
    <div className={`detail-tab-panel${logContent ? ' project-log-panel' : ''}`} id={`${tabId}-logs-panel`} role="tabpanel" aria-labelledby={`${tabId}-logs-tab`} hidden={activeTab !== 'logs'}>
      {logContent ?? <LogPanel viewCache={logViewCache} visible={activeTab === 'logs'} operationFeedback={operationFeedback} liveStatus={liveStatus} container={container} snapshot={snapshot} logs={logs} logsError={logsError} loadingLogs={loadingLogs} logRequestPending={logRequestPending} refreshing={refreshing} mutating={mutating} loadLogs={loadLogs} clearLogs={clearLogs} copy={copy} copyFeedback={copyFeedback} copyFeedbackTone={copyFeedbackTone} copyFeedbackId={copyFeedbackId} copyFeedbackHighlighted={copyFeedbackHighlighted} copyFeedbackHighlightUntil={copyFeedbackHighlightUntil} expanded={expanded} onExpandedChange={setExpanded} />}
    </div>
    {tabs.filter(tab => tab !== 'logs').map(tab => <div key={tab} className="detail-tab-panel" id={`${tabId}-${tab}-panel`} role="tabpanel" aria-labelledby={`${tabId}-${tab}-tab`} hidden={activeTab !== tab}>{activeTab === tab && insights}</div>)}
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
export function OperationResult({ operation, copy, disclosure = true }: { operation: Operation; copy: CopyText; disclosure?: boolean }) {
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
    {warning || !disclosure ? content : <ResultDisclosure identity={operation}>{content}</ResultDisclosure>}
  </section>;
}
