import { connectionInvalidatingErrors } from './frontendSession';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { AlertTriangle, Cable, ChevronsUpDown, FolderClosed, Info, LoaderCircle, RefreshCw, Search, Settings, X } from 'lucide-react';
import { api, coreError } from './api';
import { frontendError, frontendErrorDescriptor, type FrontendErrorDescriptor } from './frontendErrors';
import type { Action, ConnectionTarget, Container, ContainerList, CoreError, Environment, MutationResult } from './api';
import { ConfirmDialog, ContainerDetail, ContainerSummary, Diagnostics, ErrorDetails, OperationResult, formatTime } from './components';
import type { Confirmation, CopyLabel, DetailTab } from './components';
import { BulkResult, BulkSelection, canApply, isBoundBulkResult } from './bulk';
import type { CompletedOperation } from './operationFeedbackModel';
import { useOperationFeedback } from './useOperationFeedback';
import { OperationFeedback } from './OperationFeedback';
import { useContainerDetails } from './useContainerDetails';
import { ContainerInsights } from './ContainerInsights';
import { useLiveLogs } from './useLiveLogs';
import { useContainerStats } from './useContainerStats';
import { ContainerTable } from './ContainerTable';
import { BrandMark } from './BrandMark';
import { CopyFeedback } from './CopyFeedback';
import { usePaneResize } from './usePaneResize';
import { allProjects, groupContainers, matchesContainer, parseProjectFilter, projectFilterValue, type ProjectFilter, type ContainerFilter as Filter } from './projects';
import { RefreshAge } from './RefreshAge';
import { bulkResultIssue, errorIssue, resultIssue, retainSessionIssue, type FrontendSession, type SessionIssue } from './frontendSession';

import { PreferencesProvider, usePreferences } from './preferences';
import { SettingsDialog } from './SettingsDialog';
import { useI18n } from './i18n';
import { appMessages } from './messages/app';

type FeedbackMessage = { id: number; highlightUntil: number; highlighted: boolean } & (
  { key: 'copied'; label: CopyLabel } | { key: 'copyFailure' | 'logsCleared' }
);

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
  const { language } = usePreferences();
  const pane = usePaneResize();
  const feedback = useOperationFeedback();
  const [activeTab, setActiveTab] = useState<DetailTab>('logs');
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
  const [project, setProject] = useState<ProjectFilter>(allProjects);
  const [logRestartVersion, setLogRestartVersion] = useState(0);
  const [logReplaceVersion, setLogReplaceVersion] = useState(0);
  const [mutating, setMutating] = useState(false);
  const [reconnectRequired, setReconnectRequired] = useState(false);
  const [mutationBlocked, setMutationBlocked] = useState(false);
  const [sessionIssue, setSessionIssue] = useState<SessionIssue | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [clipboardMessage, setClipboardMessage] = useState<FeedbackMessage | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [logsExpanded, setLogsExpanded] = useState(false);
  const clipboardAttempt = useRef(0);
  const settingsTrigger = useRef<HTMLButtonElement>(null);
  const reconnectTrigger = useRef<HTMLButtonElement>(null);
  const recentOperationTrigger = useRef<HTMLButtonElement>(null);
  const operationClose = useRef<HTMLButtonElement>(null);
  const operationFocus = useRef<'details' | 'trigger' | null>(null);
  const session = useRef<string | null>(null);
  const currentSnapshot = useRef<ContainerList | null>(null);
  const epoch = useRef(0);
  const listSequence = useRef(0);
  const busy = useRef(false);
  const refreshBusy = useRef(false);
  const blocked = useRef(false);
  const selectedIdRef = useRef<string | null>(null);
  const searchCriteria = useRef<{ query: string; filter: Filter; project: ProjectFilter }>({ query: '', filter: 'all', project: allProjects });
  const initialSelection = useRef(true);
  const pendingRemovedFocus = useRef<Element | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const inventory = useRef<HTMLTableSectionElement>(null);
  const bulkSelectAll = useRef<HTMLInputElement>(null);
  const bulkRegion = useRef<HTMLElement>(null);
  const pendingBulkFocus = useRef<{ epoch: number } | null>(null);
  useEffect(() => {
    if (!clipboardMessage?.highlighted) return;
    const { id, highlightUntil } = clipboardMessage;
    // Keep the last action text. Both surfaces share a highlight deadline that
    // preference changes, modal remounts, and older timers cannot restart.
    const timer = setTimeout(() => setClipboardMessage(current => current?.id === id ? { ...current, highlighted: false } : current), Math.max(0, highlightUntil - Date.now()));
    return () => clearTimeout(timer);
  }, [clipboardMessage]);
  const recordIssue = useCallback((issue: SessionIssue) => {
    setSessionIssue(previous => retainSessionIssue(previous, issue));
  }, []);
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
  const groups = groupContainers((snapshot?.containers ?? []).filter(container => matchesContainer(container, query, filter, project)));
  const visible = groups.flatMap(group => group.containers);
  const projectOptions = groupContainers(snapshot?.containers ?? []);
  const selected = visible.find(container => container.fullId === selectedId) ?? null;
  const checked = visible.filter(container => checkedHandles.has(container.handle));
  const onReadError = useCallback((stage: 'logs' | 'stats' | 'details', original: unknown, failure: CoreError, sessionId: string) => {
    if (session.current !== sessionId) return;
    const invalidates = connectionInvalidatingErrors.has(failure.code);
    if (invalidates) {
      blocked.current = true;
      setMutationBlocked(true);
      setReconnectRequired(true);
    }
    recordIssue(errorIssue(stage, original, failure, invalidates));
    return invalidates;
  }, [recordIssue]);
  const onLogError = useCallback((original: unknown, failure: CoreError, sessionId: string) => onReadError('logs', original, failure, sessionId), [onReadError]);
  const onStatsError = useCallback((original: unknown, failure: CoreError, sessionId: string) => onReadError('stats', original, failure, sessionId), [onReadError]);
  const onDetailsError = useCallback((original: unknown, failure: CoreError, sessionId: string) => onReadError('details', original, failure, sessionId), [onReadError]);
  const detailsEnabled = !connecting && !refreshing && !mutating && !reconnectRequired;
  const details = useContainerDetails({ container: selected, snapshot, active: activeTab !== 'logs', enabled: detailsEnabled, onError: onDetailsError });
  const { logs, logsError, loadingLogs, logRequestPending, liveStatus, loadLogs, clearLogs } = useLiveLogs({
    container: selected, snapshot, enabled: !connecting && !refreshing && !mutating && !reconnectRequired,
    invalidated: !!snapshot?.stale || reconnectRequired, restartVersion: logRestartVersion, replaceVersion: logReplaceVersion, onError: onLogError,
  });
  const stats = useContainerStats({ snapshot, containers: visible,
    enabled: !connecting && !refreshing && !mutating && !reconnectRequired, onError: onStatsError });
  const selectContainer = useCallback((id: string | null) => {
    if (selectedIdRef.current === id) return;
    selectedIdRef.current = id;
    setSelectedId(id);
    clearLogs();
    setLogsExpanded(false);
  }, [clearLogs]);
  function showConnections(container?: Container) {
    if (container) selectContainer(container.fullId);
    setActiveTab('connectivity');
  }
  function openOperationDetails() {
    operationFocus.current = 'details';
    setLogsExpanded(false);
    feedback.openDetails();
  }
  function closeOperationDetails() {
    operationFocus.current = 'trigger';
    feedback.closeDetails();
  }
  useEffect(() => {
    if (logsExpanded || !operationFocus.current) return;
    const target = operationFocus.current === 'details' ? operationClose.current : recentOperationTrigger.current;
    if (target) { operationFocus.current = null; target.focus(); }
  }, [logsExpanded, feedback.detailsOpen]);
  function updateSearch(nextQuery: string, nextFilter: Filter, nextProject: ProjectFilter = searchCriteria.current.project) {
    if (busy.current) return;
    pendingRemovedFocus.current = document.activeElement;
    searchCriteria.current = { query: nextQuery, filter: nextFilter, project: nextProject };
    setProject(nextProject);
    setQuery(nextQuery);
    setFilter(nextFilter);
    setCheckedHandles(new Set());
    if (!currentSnapshot.current?.containers.some(container => container.fullId === selectedIdRef.current && matchesContainer(container, nextQuery, nextFilter, nextProject))) selectContainer(null);
  }
  useLayoutEffect(() => {
    const previous = pendingRemovedFocus.current;
    pendingRemovedFocus.current = null;
    if (previous && !previous.isConnected && (document.activeElement === document.body || document.activeElement === document.documentElement)) {
      const firstRow = inventory.current?.querySelector<HTMLButtonElement>('.container-row');
      (firstRow ?? searchInput.current)?.focus();
    }
  }, [snapshot, query, filter, project]);
  const refresh = useCallback(async (sessionId: string) => {
    const requestEpoch = epoch.current;
    const request = ++listSequence.current;
    refreshBusy.current = true;
    setCheckedHandles(new Set());
    setRefreshing(true);
    try {
      const result = await api.listContainers(sessionId);
      if (epoch.current !== requestEpoch || session.current !== sessionId || request !== listSequence.current) return false;
      if (result.sessionId !== sessionId || (currentSnapshot.current && result.generation <= currentSnapshot.current.generation)) throw frontendError('staleInventory');
      pendingRemovedFocus.current = document.activeElement;
      currentSnapshot.current = result;
      setSnapshot(result);
      setListError(null);
      let criteria = searchCriteria.current;
      const projectExists = criteria.project.kind === 'all' || result.containers.some(container => matchesContainer(container, '', 'all', criteria.project));
      if (!projectExists) {
        criteria = { ...criteria, project: allProjects };
        searchCriteria.current = criteria;
        setProject(allProjects);
      }
      const matching = groupContainers(result.containers.filter(container => matchesContainer(container, criteria.query, criteria.filter, criteria.project))).flatMap(group => group.containers);
      if (initialSelection.current) { initialSelection.current = false; selectContainer(matching[0]?.fullId ?? null); }
      else {
        const retained = matching.find(container => container.fullId === selectedIdRef.current);
        if (!retained) selectContainer(null);

      }
      return !result.stale;
    } catch (error) {
      if (epoch.current !== requestEpoch || session.current !== sessionId || request !== listSequence.current) return false;
      const failure = coreError(error);
      setListError(failure);
      recordIssue(errorIssue('list', error, failure, connectionInvalidatingErrors.has(failure.code)));
      if (connectionInvalidatingErrors.has(failure.code)) {
        blocked.current = true;
        setMutationBlocked(true);
        setReconnectRequired(true);
      }
      if (currentSnapshot.current) {
        currentSnapshot.current = { ...currentSnapshot.current, stale: true };
        setSnapshot(currentSnapshot.current);
      }
      return false;
    } finally {
      if (epoch.current === requestEpoch && request === listSequence.current) { refreshBusy.current = false; setRefreshing(false); }
    }
  }, [clearLogs, selectContainer, recordIssue]);
  const connect = useCallback(async () => {
    if (busy.current || refreshBusy.current) return;
    pendingBulkFocus.current = null;
    const requestEpoch = ++epoch.current;
    session.current = null;
    currentSnapshot.current = null;
    ++listSequence.current;
    refreshBusy.current = false;
    setConnecting(true);
    setSessionIssue(previous => previous ? { ...previous, scope: 'previous' } : null);
    setEnvironment(null);
    setEnvironmentError(null);
    setSnapshot(null);
    setListError(null);
    clearLogs();
    setRefreshing(false);
    setConfirmation(null);
    blocked.current = true;
    setMutationBlocked(true);
    ++clipboardAttempt.current;
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
        setSessionIssue(null);
        setReconnectRequired(false);
        blocked.current = !result.mutationAllowed;
        setMutationBlocked(blocked.current);
        setConnecting(false);
        await refresh(result.sessionId);
      } else {
        // A completed connection attempt replaces evidence from the previous session.
        setSessionIssue(result.error ? errorIssue('connect', result.error, result.error, true) : resultIssue('connect', true));
      }
    } catch (error) {
      if (epoch.current === requestEpoch) {
        const failure = coreError(error);
        setEnvironmentError(failure);
        setSessionIssue(errorIssue('connect', error, failure, true));
      }
    } finally {
      if (epoch.current === requestEpoch) setConnecting(false);
    }
  }, [clearLogs, refresh, selectContainer]);
  useEffect(() => {
    // Defer one microtask so development StrictMode's discarded mount never opens a session.
    let active = true;
    void Promise.resolve().then(() => { if (active) void connect(); });
    return () => { active = false; ++epoch.current; };
  }, [connect]);
  async function mutate(container: Container, action: Action, targetSession: string, generation: number) {
    const current = currentSnapshot.current;
    const currentContainer = current?.containers.find(item => item.handle === container.handle);
    const criteria = searchCriteria.current;
    const actionAllowed = currentContainer && canApply(currentContainer, action) && matchesContainer(currentContainer, criteria.query, criteria.filter, criteria.project);
    if (busy.current || refreshBusy.current || blocked.current || selectedIdRef.current !== container.fullId || !actionAllowed || session.current !== targetSession || current?.stale || current?.generation !== generation || !current.containers.some(item => item.handle === container.handle)) return;
    busy.current = true;
    setMutating(true);
    const feedbackAttempt = feedback.begin({ kind: 'single', action, name: container.name, sessionId: targetSession });
    setConfirmation(null);
    const requestEpoch = epoch.current;
    const target = connectionTarget(environment);
    let result: MutationResult;
    let frontendFailure: FrontendErrorDescriptor | undefined;
    let issue: SessionIssue | null = null;
    try { result = await api.mutateContainer(targetSession, container.handle, action); }
    catch (error) {
      const failure = coreError(error);
      frontendFailure = frontendErrorDescriptor(failure);
      const uncertain = failure.code === 'IPC_FAILURE' || failure.code === 'WorkerFailed';
      result = { outcome: uncertain ? 'resultUnknown' : 'failed', message: failure.message, command: failure.command ?? '', stderr: failure.stderr ?? '', reconciliation: uncertain ? 'failed' : 'notNeeded', mutationBlocked: true };
      issue = errorIssue('singleAction', error, failure, true);
    }
    if (epoch.current !== requestEpoch) { feedback.cancel(feedbackAttempt); return; }
    blocked.current = blocked.current || result.mutationBlocked || result.reconciliation === 'failed';
    setMutationBlocked(blocked.current);
    if (blocked.current) setReconnectRequired(true);
    if (issue) recordIssue(issue);
    else if (result.outcome !== 'succeeded' || result.mutationBlocked || result.reconciliation === 'failed') recordIssue(resultIssue('singleAction', blocked.current, result));
    const completion: CompletedOperation = { kind: 'single', operation: { ...result, frontendError: frontendFailure, fullId: container.fullId, name: container.name, action, ...target } };
    const refreshed = await refresh(targetSession);
    if (epoch.current === requestEpoch) {
      busy.current = false; setMutating(false);
      feedback.finish(feedbackAttempt, completion, refreshed);
      if (refreshed && !blocked.current && result.outcome === 'succeeded' && selectedIdRef.current === container.fullId) {
        if (action === 'restart') setLogReplaceVersion(value => value + 1);
        else setLogRestartVersion(value => value + 1);
      }
    } else feedback.cancel(feedbackAttempt);
  }
  function requestAction(action: Action, returnFocus?: HTMLElement) {
    if (settingsOpen || logsExpanded || busy.current || refreshBusy.current || blocked.current || !selected || selectedIdRef.current !== selected.fullId || !snapshot || snapshot.stale || !environment?.mutationAllowed || !session.current || !canApply(selected, action)) return;
    if (action === 'start') void mutate(selected, action, session.current, snapshot.generation);
    else setConfirmation({ container: selected, action, sessionId: session.current, generation: snapshot.generation, ...connectionTarget(environment), returnFocus });
  }
  async function mutateBulk(containers: Container[], action: Action, targetSession: string, generation: number) {
    const current = currentSnapshot.current;
    const criteria = searchCriteria.current;
    if (containers.some(container => !matchesContainer(container, criteria.query, criteria.filter, criteria.project))) return;
    if (busy.current || refreshBusy.current || blocked.current || !containers.length || !containers.some(container => canApply(container, action)) || session.current !== targetSession || current?.stale || current?.generation !== generation || containers.some(container => !current.containers.some(item => item.handle === container.handle))) return;
    if (action !== 'start') pendingBulkFocus.current = { epoch: epoch.current };
    busy.current = true;
    setMutating(true);
    const feedbackAttempt = feedback.begin({ kind: 'bulk', action, count: containers.length, sessionId: targetSession });
    setConfirmation(null);
    const requestEpoch = epoch.current;
    const context = { action, ...connectionTarget(environment), containers };
    const selectedAtStart = selectedIdRef.current;
    let selectedSucceeded = false;
    let completion: CompletedOperation | undefined;
    try {
      const result = await api.mutateContainers(targetSession, generation, containers.map(container => container.handle), action);
      if (epoch.current !== requestEpoch) return;
      if (!isBoundBulkResult(result, targetSession, generation, containers, action)) throw frontendError('invalidBulkResponse');
      selectedSucceeded = result.items.some(item => item.fullId === selectedAtStart && item.outcome === 'succeeded');
      blocked.current = blocked.current || result.mutationBlocked || result.items.some(item => item.result?.mutationBlocked || item.result?.reconciliation === 'failed');
      const issue = bulkResultIssue(result, blocked.current);
      if (issue) recordIssue(issue);
      completion = { kind: 'bulk', operation: { ...context, result, needsReconnect: blocked.current } };
    } catch (error) {
      if (epoch.current !== requestEpoch) return;
      const failure = coreError(error);
      // Only these structured native rejections prove that no command was dispatched.
      const preflightRejection = ['Busy', 'StaleSession', 'NeedsValidation', 'StaleHandle', 'InvalidSelection'].includes(failure.code);
      const recoverableRejection = ['Busy', 'StaleHandle', 'InvalidSelection'].includes(failure.code);
      blocked.current = blocked.current || !recoverableRejection;
      recordIssue(errorIssue('bulkAction', error, failure, !recoverableRejection));
      completion = { kind: 'bulk', operation: { ...context, error: failure, uncertain: !preflightRejection, needsReconnect: blocked.current } };
    } finally {
      if (epoch.current === requestEpoch) {
        setMutationBlocked(blocked.current);
        if (blocked.current) setReconnectRequired(true);
        const refreshed = await refresh(targetSession);
        if (epoch.current === requestEpoch) {
          busy.current = false; setMutating(false);
          if (completion) feedback.finish(feedbackAttempt, completion, refreshed);
          if (refreshed && !blocked.current && selectedSucceeded && selectedIdRef.current === selectedAtStart) {
            if (action === 'restart') setLogReplaceVersion(value => value + 1);
            else setLogRestartVersion(value => value + 1);
          }
        } else feedback.cancel(feedbackAttempt);
      } else feedback.cancel(feedbackAttempt);
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
    const id = ++clipboardAttempt.current;
    try {
      await navigator.clipboard.writeText(text);
      if (clipboardAttempt.current === id) setClipboardMessage({ id, key: 'copied', label, highlightUntil: Date.now() + 2_000, highlighted: true });
    } catch {
      if (clipboardAttempt.current === id) setClipboardMessage({ id, key: 'copyFailure', highlightUntil: Date.now() + 2_000, highlighted: true });
    }
  }
  function clearDisplayedLogs() {
    const id = ++clipboardAttempt.current;
    clearLogs();
    setClipboardMessage({ id, key: 'logsCleared', highlightUntil: Date.now() + 2_000, highlighted: true });
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
  const frontendSession: FrontendSession = {
    currentStatus: connecting ? 'checking' : reconnectRequired ? 'reconnectRequired' : ready ? 'connected' : 'disconnected',
    effectiveMutationBlocked: connecting || !ready || !environment?.mutationAllowed || !snapshot || snapshot.stale || refreshing || mutating || mutationBlocked,
    reconnectRequired,
    inventoryStale: snapshot?.stale ?? null, inventoryRefreshedAt: snapshot?.refreshedAt ?? null,
    issue: sessionIssue,
  };
  const connectionError = environmentError ?? environment?.error ?? null;
  const [connectionTitle, connectionHelp] = connectionIssue(connectionError, environment?.status === 'unsupported');
  const copyFeedback = clipboardMessage ? clipboardMessage.key === 'copied' ? t('copied', { label: t(clipboardMessage.label) }) : t(clipboardMessage.key) : '';
  const copyFeedbackTone = clipboardMessage?.key === 'logsCleared' ? 'cleared' : clipboardMessage?.key === 'copyFailure' ? 'error' : 'success';
  return <div className="app-shell">
    <div className="main-content" inert={!!confirmation || settingsOpen || logsExpanded}>
      <header className="app-header">
        <div className="brand"><BrandMark /><h1>Docker2U</h1></div>
        <section className="connection-bar" aria-label={t('connection')}>
          <div className="connection-label"><span className={`connection-dot ${connectionClass}`} aria-hidden="true" /><div className="connection-target"><strong title={environment?.endpoint ?? undefined}>{environment?.contextName ?? t('contextPending')}</strong></div><span className="connection-status" role="status">{connectionStatus}</span></div>
          <button ref={reconnectTrigger} className="text-button" title={t('reconnectHint')} onClick={() => void connect()} disabled={connecting || refreshing || mutating}><Cable size={14} aria-hidden="true" />{t('reconnect')}</button>
        </section>
        <div className="header-right">
          <button className="icon-button" title={t('showDiagnostics')} aria-label={t('showDiagnostics')} aria-expanded={showDiagnostics} onClick={() => setShowDiagnostics(!showDiagnostics)}><Info size={17} aria-hidden="true" /></button>
          <button ref={settingsTrigger} className="icon-button" aria-label={t('settings')} title={t('settings')} aria-haspopup="dialog" onClick={() => { if (!confirmation && !logsExpanded) setSettingsOpen(true); }}><Settings size={17} aria-hidden="true" /></button>
        </div>
      </header>
      {showDiagnostics && <><p className="connection-help">{t('connectionHelp')}</p><Diagnostics environment={environment} frontendSession={frontendSession} close={() => setShowDiagnostics(false)} copy={copy} /></>}
      <main ref={pane.workspaceRef} className={`workspace${pane.dragging ? ' resizing' : ''}`} style={pane.workspaceStyle}>
        <aside id="inventory-pane" className="inventory-panel" aria-labelledby="inventory-title">
          <div className="panel-heading"><h2 id="inventory-title">{t('containers')} <span className="count-badge">{snapshot?.containers.length ?? '—'}</span></h2><RefreshAge refreshedAt={snapshot?.refreshedAt} /></div>
          <div className="inventory-controls">
            <div className="search-field"><Search size={16} aria-hidden="true" /><input ref={searchInput} aria-label={t('search')} placeholder={t('searchHint')} value={query} disabled={mutating} onChange={event => updateSearch(event.target.value, filter)} />{query && <button className="search-clear" aria-label={t('clearSearch')} title={t('clearSearch')} disabled={mutating} onClick={() => { updateSearch('', filter); searchInput.current?.focus(); }}><X size={14} aria-hidden="true" /></button>}</div>
            <label className="project-filter">
              <span className="project-select-control" data-active={project.kind !== 'all'}>
                <FolderClosed className="project-select-icon" size={14} aria-hidden="true" />
                <select aria-label={t('projectFilter')} title={project.kind === 'all' ? t('allProjects') : project.kind === 'none' ? t('noProject') : project.name} value={projectFilterValue(project)} disabled={mutating} onChange={event => updateSearch(query, filter, parseProjectFilter(event.target.value))}>
                  <option value="all">{t('allProjects')}</option>
                  {projectOptions.map(group => <option key={JSON.stringify(group.name)} value={group.name === null ? 'none' : projectFilterValue({ kind: 'project', name: group.name })}>{group.name ?? t('noProject')}</option>)}
                </select>
                <ChevronsUpDown className="project-select-chevron" size={13} aria-hidden="true" />
              </span>
            </label>
            <div className="filter-group" aria-label={t('filters')}>{(['all', 'running', 'stopped', 'attention'] as const).map(value => <button key={value} aria-pressed={filter === value} disabled={mutating} onClick={() => updateSearch(query, value)}>{t(value)}</button>)}</div>
            <button title={t('refreshHint')} className="inventory-refresh" disabled={!ready || refreshing || mutating} onClick={() => { if (session.current && !busy.current && !refreshBusy.current) void refresh(session.current).then(refreshed => { if (refreshed) setLogRestartVersion(value => value + 1); }); }}><RefreshCw size={14} className={refreshing ? 'spin' : ''} aria-hidden="true" />{t(refreshing ? 'refreshing' : 'refresh')}</button>
          </div>
          <div className="inventory-body">
          <BulkSelection visible={visible} checked={checked} disabled={mutating || refreshing || connecting || !snapshot || snapshot.stale} actionsDisabled={mutating || refreshing || mutationBlocked || !environment?.mutationAllowed || !snapshot || snapshot.stale} selectAllRef={bulkSelectAll} regionRef={bulkRegion} onToggleAll={() => changeSelection(() => checked.length === visible.length ? new Set() : new Set(visible.map(container => container.handle)))} onClear={() => changeSelection(() => new Set())} onAction={requestBulkAction} />
          {snapshot?.stale && <div className="stale-notice" role="status"><AlertTriangle size={14} aria-hidden="true" /><span>{t('stale')}</span></div>}
          {listError && <div className="inline-error" role="alert"><p>{t('listFailure')}</p>{connectionInvalidatingErrors.has(listError.code) && <p>{t('validateAgain')}</p>}<ErrorDetails error={listError} /></div>}
          {stats.error && <p className="stats-notice" role="status">{t('statsFailure')}</p>}
          <ContainerTable groups={groups} selectedId={selectedId} checkedHandles={checkedHandles}
            checkboxDisabled={mutating || refreshing || !!snapshot?.stale} sampleFor={stats.sampleFor}
            inventoryRef={inventory} onSelect={container => selectContainer(container.fullId)} onShowConnections={showConnections}
            onToggle={container => changeSelection(previous => { const next = new Set(previous); if (next.has(container.handle)) next.delete(container.handle); else next.add(container.handle); return next; })}
            onRowKeyDown={selectWithKeyboard} busy={refreshing || mutating} />
          {!visible.length && <div className="inventory-placeholder"><BrandMark size={48} /><p>{t(connecting || (refreshing && !snapshot) ? 'checkingContainers' : !ready ? 'connectForList' : !snapshot ? 'reloadList' : snapshot.containers.length === 0 ? 'emptyEngine' : 'noResults')}</p>{snapshot && snapshot.containers.length > 0 && <button className="text-button" disabled={mutating} onClick={() => updateSearch('', 'all', allProjects)}>{t('resetFilters')}</button>}</div>}
          </div>
        </aside>
        <button type="button" role="separator" className="pane-resizer" aria-label={t('resizeLogs')} title={t('resizeLogsHint')} aria-orientation="horizontal" aria-controls="inventory-pane detail-pane" {...pane.separatorProps}><span aria-hidden="true" /></button>
        <section id="detail-pane" className="detail-panel" aria-label={t(selected ? 'detailTitle' : 'connectTitle')}>
          <div className="detail-context" tabIndex={0} aria-label={t('detailContext')}>
            {feedback.detailsOpen && feedback.completed && <div id="latest-operation-details" className="latest-operation operation-details-dismissable" aria-label={t('latestOperation')} onKeyDown={event => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); closeOperationDetails(); } }}>
              <div className="operation-details-heading"><p>{t('operationTime')} · <time dateTime={feedback.completed.completedAt}>{formatTime(feedback.completed.completedAt, language)}</time></p><button ref={operationClose} className="icon-button" aria-label={t('closeOperationDetails')} onClick={closeOperationDetails}><X size={15} aria-hidden="true" /></button></div>
              {feedback.completed.result.kind === 'single' ? <OperationResult disclosure={false} operation={feedback.completed.result.operation} copy={copy} /> : <BulkResult disclosure={false} operation={feedback.completed.result.operation} />}
              {!feedback.completed.refreshed && <p className="operation-warning">{t('operationRefreshFailed')}</p>}
            </div>}
            {selected && snapshot ? <ContainerSummary container={selected} snapshot={snapshot} copy={copy} mutationBlocked={mutationBlocked} mutationAllowed={!!environment?.mutationAllowed} resourceSample={stats.sampleFor(selected)} onShowConnections={() => showConnections()} /> : <div className="panel-heading"><h2>{t('connectTitle')}</h2></div>}
          </div>
          {connecting ? <div className="startup-panel"><div className="startup-icon"><LoaderCircle className="spin" size={30} aria-hidden="true" /></div><h3>{t('checkingLocal')}</h3><p>{t('checkingCli')}</p></div> : !ready ? <div className="startup-panel"><div className="startup-icon"><Cable size={32} aria-hidden="true" /></div><span className="eyebrow">{t('localEnvironment')}</span><h3>{t(connectionTitle)}</h3><p>{t(connectionHelp)}</p>{connectionError && <div role="alert"><ErrorDetails error={connectionError} /></div>}{!!environment?.diagnostics.length && <details className="technical-details"><summary>{t('originalDiagnostics')}</summary>{environment.diagnostics.map((message, index) => <p key={index}>{message}</p>)}</details>}<button className="primary-button" onClick={() => void connect()}><RefreshCw size={14} aria-hidden="true" />{t('reconnect')}</button></div> : selected && snapshot ? <ContainerDetail activeTab={activeTab} onTabChange={setActiveTab} insights={activeTab !== 'logs' ? <ContainerInsights tab={activeTab} {...details} disabled={!detailsEnabled || !!snapshot.stale} copy={copy} /> : undefined} operationFeedback={<OperationFeedback model={feedback} detailsId="latest-operation-details" onOpenDetails={openOperationDetails} />} container={selected} snapshot={snapshot} logs={logs} logsError={logsError} loadingLogs={loadingLogs} logRequestPending={logRequestPending} refreshing={refreshing} mutating={mutating} mutationBlocked={mutationBlocked} mutationAllowed={!!environment?.mutationAllowed} liveStatus={liveStatus} loadLogs={loadLogs} clearLogs={clearDisplayedLogs} requestAction={requestAction} copy={copy} copyFeedback={copyFeedback} copyFeedbackTone={copyFeedbackTone} copyFeedbackId={clipboardMessage?.id} copyFeedbackHighlighted={clipboardMessage?.highlighted} copyFeedbackHighlightUntil={clipboardMessage?.highlightUntil} logsExpanded={logsExpanded} onLogsExpandedChange={setLogsExpanded} /> : <div className="startup-panel"><div className="startup-icon"><BrandMark size={56} /></div><h3>{t(refreshing ? 'loadingContainers' : snapshot?.containers.length === 0 ? 'noContainers' : 'selectContainer')}</h3><p>{t(snapshot?.containers.length === 0 ? 'startServices' : 'selectHelp')}</p></div>}
        </section>
      </main>
      <footer className="app-footer"><span><span className="footer-dot" />{t('footer')}</span><OperationFeedback model={feedback} detailsId="latest-operation-details" recentButtonRef={recentOperationTrigger} onOpenDetails={openOperationDetails} announce={!logsExpanded} /><CopyFeedback className="clipboard-feedback" message={copyFeedback} tone={copyFeedbackTone} notificationId={clipboardMessage?.id} highlighted={clipboardMessage?.highlighted} highlightUntil={clipboardMessage?.highlightUntil} /></footer>
    </div>
    {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} returnFocus={settingsTrigger.current ?? undefined} />}
    {confirmation && <ConfirmDialog confirmation={confirmation} blocked={reconnectRequired} reconnectFocus={reconnectTrigger} onCancel={() => setConfirmation(null)} onConfirm={() => { if (confirmation.containers) void mutateBulk(confirmation.containers, confirmation.action, confirmation.sessionId, confirmation.generation); else void mutate(confirmation.container, confirmation.action, confirmation.sessionId, confirmation.generation); }} />}
  </div>;
}
