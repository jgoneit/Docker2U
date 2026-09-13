import { connectionInvalidatingErrors } from './frontendSession';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AlertTriangle, Cable, Info, LoaderCircle, Plus, RefreshCw, Search, Settings, Terminal, X } from 'lucide-react';
import { api, coreError } from './api';
import { frontendError, frontendErrorDescriptor, type FrontendErrorDescriptor } from './frontendErrors';
import type { Action, ConnectionTarget, Container, ContainerList, CoreError, Environment, MutationResult } from './api';
import { ConfirmDialog, ContainerDetail, ContainerInformation, ContainerSummary, Diagnostics, ErrorDetails, OperationResult, formatTime } from './components';
import type { Confirmation, CopyLabel, DetailTab } from './components';
import { BulkResult, BulkSelection, canApply, isBoundBulkResult } from './bulk';
import type { CompletedOperation } from './operationFeedbackModel';
import { useOperationFeedback } from './useOperationFeedback';
import { OperationFeedback } from './OperationFeedback';
import { useContainerDetails } from './useContainerDetails';
import { ContainerInsights } from './ContainerInsights';
import { useLiveLogs } from './useLiveLogs';
import { useContainerStats } from './useContainerStats';
import { useObservation } from './useObservation';
import { observationApi, type ObservationHold } from './observationApi';
import { useProjectLogCollection, ProjectLogs, createProjectLogViewCache } from './ProjectLogs';
import { ObservationHistory } from './ObservationHistory';
import { StoragePanel } from './StoragePanel';
import { useMountInventory } from './useMountInventory';
import { createStandaloneLogViewCache } from './standaloneLogViewCache';
import { observationMessages } from './messages/observation';
import { ContainerTable, type NavigationTarget } from './ContainerTable';
import { BrandMark } from './BrandMark';
import { CopyFeedback } from './CopyFeedback';
import { usePaneResize } from './usePaneResize';
import { allProjects, groupContainers, projectTreeGroups, matchesContainer, projectName, type ProjectFilter, type ContainerFilter as Filter } from './projects';
import { RefreshAge } from './RefreshAge';
import { bulkResultIssue, errorIssue, resultIssue, retainSessionIssue, type FrontendSession, type SessionIssue } from './frontendSession';

import { PreferencesProvider, usePreferences } from './preferences';
import { SettingsDialog } from './SettingsDialog';
import { useI18n } from './i18n';
import { appMessages } from './messages/app';
import { composeMessages } from './messages/compose';
import { useComposeProjects } from './useComposeProjects';
import { ComposeEditorDialog, ComposeForgetDialog, ComposePrepareDialog, ComposeProgressDialog, ComposeProjectControls } from './ComposeDialogs';

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
  const ot = useI18n(observationMessages);
  const ct = useI18n(composeMessages);
  const { language } = usePreferences();
  const pane = usePaneResize();
  const feedback = useOperationFeedback();
  const [tabs, setTabs] = useState<Record<string, DetailTab>>({});
  const logViewCache = useRef(createProjectLogViewCache()).current;
  const standaloneLogViewCache = useRef(createStandaloneLogViewCache()).current;
  const [environment, setEnvironment] = useState<Environment | null>(null);
  const [connecting, setConnecting] = useState(true);
  const [environmentError, setEnvironmentError] = useState<CoreError | null>(null);
  const [snapshot, setSnapshot] = useState<ContainerList | null>(null);
  const [listError, setListError] = useState<CoreError | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedTarget, setSelectedTarget] = useState<NavigationTarget>(null);
  const selectionRef = useRef<NavigationTarget>(null);
  const [checkedHandles, setCheckedHandles] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const projectView = selectedTarget?.kind === 'project';
  const targetKey = selectedTarget ? JSON.stringify(selectedTarget) : '';
  const activeTab = tabs[targetKey] ?? 'logs';
  const projectTab = activeTab === 'history' || activeTab === 'storage' ? activeTab : 'logs';
  const [storageHighlight, setStorageHighlight] = useState<{ fullId: string; key: string } | null>(null);
  const pendingDetailFocus = useRef<{ sessionId: string; fullId: string; tab: DetailTab } | null>(null);
  const setActiveTab = useCallback((tab: DetailTab) => {
    if (selectionRef.current) { const key = JSON.stringify(selectionRef.current); setTabs(previous => ({ ...previous, [key]: tab })); }
  }, []);
  const setProjectTab = setActiveTab;
  const [preparingAction, setPreparingAction] = useState(false);
  const observationHold = useRef<ObservationHold | null>(null);
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
  const inventory = useRef<HTMLDivElement>(null);
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
  const composeRefresh = useRef<(sessionId: string) => Promise<boolean>>(async () => false);
  const composeError = useRef<(error: CoreError, sessionId: string) => void>(() => {});
  const compose = useComposeProjects({ environment, enabled: !connecting && !reconnectRequired,
    refresh: sessionId => composeRefresh.current(sessionId), onError: (error, sessionId) => composeError.current(error, sessionId) });
  const groups = projectTreeGroups(snapshot?.containers ?? [], compose.projects, query, filter, compose.issues);
  if (selectedTarget?.kind === 'project' && !query && filter === 'all' && !groups.some(group => group.name === selectedTarget.name)) groups.push({ name: selectedTarget.name, containers: [] });
  const visible = groups.flatMap(group => group.containers);
  const selected = selectedTarget?.kind === 'container' ? snapshot?.containers.find(container => container.fullId === selectedTarget.fullId) ?? null : null;
  const observedProject = selectedTarget?.kind === 'project' ? selectedTarget.name : selected ? projectName(selected) : null;
  const registeredProject = compose.projects.find(item => item.name === observedProject) ?? null;
  const project: ProjectFilter = observedProject ? { kind: 'project', name: observedProject } : { kind: 'none' };
  const projectContainers = (snapshot?.containers ?? []).filter(container => matchesContainer(container, '', 'all', project));
  const targetHidden = selectedTarget?.kind === 'container' ? !visible.some(item => item.fullId === selectedTarget.fullId)
    : selectedTarget?.kind === 'project' && !groups.some(group => group.name === selectedTarget.name);
  const nativeObservation = observationApi.available();
  const checked = visible.filter(container => checkedHandles.has(container.handle));
  const onReadError = useCallback((stage: 'logs' | 'stats' | 'details', original: unknown, failure: CoreError, sessionId: string) => {
    if (session.current !== sessionId) return;
    const invalidates = connectionInvalidatingErrors.has(failure.code) || failure.code === 'NeedsValidation';
    if (invalidates) {
      blocked.current = true;
      setMutationBlocked(true);
      setReconnectRequired(true);
    }
    recordIssue(errorIssue(stage, original, failure, invalidates));
    return invalidates;
  }, [recordIssue]);
  composeError.current = (error, sessionId) => onReadError('details', error, error, sessionId);
  const onLogError = useCallback((original: unknown, failure: CoreError, sessionId: string) => onReadError('logs', original, failure, sessionId), [onReadError]);
  const onStatsError = useCallback((original: unknown, failure: CoreError, sessionId: string) => onReadError('stats', original, failure, sessionId), [onReadError]);
  const onDetailsError = useCallback((original: unknown, failure: CoreError, sessionId: string) => onReadError('details', original, failure, sessionId), [onReadError]);
  const detailsEnabled = !connecting && !refreshing && !mutating && !reconnectRequired;
  const mounts = useMountInventory({ snapshot, active: activeTab === 'storage', enabled: detailsEnabled, onError: onDetailsError });
  const details = useContainerDetails({ container: selected, snapshot, active: activeTab === 'diagnostics' || activeTab === 'connectivity', enabled: detailsEnabled, onError: onDetailsError });
  const { logs, logsError, loadingLogs, logRequestPending, liveStatus, loadLogs, clearLogs } = useLiveLogs({
    container: nativeObservation && observedProject ? null : selected, snapshot, enabled: !connecting && !refreshing && !mutating && !reconnectRequired,
    invalidated: !!snapshot?.stale || reconnectRequired, restartVersion: logRestartVersion, replaceVersion: logReplaceVersion, onError: onLogError,
  });
  const legacyStats = useContainerStats({ snapshot, containers: visible,
    enabled: !nativeObservation && !connecting && !refreshing && !mutating && !reconnectRequired, onError: onStatsError });
  const selectTarget = useCallback((target: NavigationTarget) => {
    if (JSON.stringify(selectionRef.current) === JSON.stringify(target)) return;
    selectionRef.current = target;
    selectedIdRef.current = target?.kind === 'container' ? target.fullId : null;
    setSelectedTarget(target);
    clearLogs();
    setLogsExpanded(false);
  }, [clearLogs]);
  const selectContainer = useCallback((id: string | null) => selectTarget(id ? { kind: 'container', fullId: id } : null), [selectTarget]);
  const openProject = useCallback((name: string | null) => { if (name !== null) selectTarget({ kind: 'project', name }); }, [selectTarget]);
  useEffect(() => {
    if (!connecting && snapshot && !snapshot.containers.length && !selectionRef.current && compose.projects[0]) openProject(compose.projects[0].name);
  }, [connecting, snapshot, compose.projects, openProject]);
  const reconcileTarget = useCallback((next: ContainerList, previous: ContainerList | null) => {
    const target = selectionRef.current;
    if (target?.kind !== 'container' || next.containers.some(item => item.fullId === target.fullId)) return;
    const removed = previous?.containers.find(item => item.fullId === target.fullId);
    const name = removed ? projectName(removed) : null;
    selectTarget(name ? { kind: 'project', name } : null);
  }, [selectTarget]);
  const acceptObservationInventory = useCallback((result: ContainerList) => {
    if (result.sessionId !== session.current || (currentSnapshot.current && result.generation < currentSnapshot.current.generation)) return;
    const previous = currentSnapshot.current;
    if (previous && result.generation === previous.generation && JSON.stringify(result.containers) !== JSON.stringify(previous.containers)) throw frontendError('staleInventory');
    setCheckedHandles(handles => {
      const ids = new Set(previous?.containers.filter(item => handles.has(item.handle)).map(item => item.fullId));
      return new Set(result.containers.filter(item => ids.has(item.fullId) && matchesContainer(item, searchCriteria.current.query, searchCriteria.current.filter)).map(item => item.handle));
    });
    pendingRemovedFocus.current = document.activeElement;
    currentSnapshot.current = result; setSnapshot(result); setListError(null);
    reconcileTarget(result, previous);
  }, [reconcileTarget]);
  const observation = useObservation({ sessionId: environment?.sessionId ?? null, scope: allProjects,
    enabled: !connecting && !reconnectRequired, onInventory: acceptObservationInventory, onError: onStatsError });
  const stats = nativeObservation ? { sampleFor: observation.sampleFor, error: observation.view?.statsError ?? observation.error } : legacyStats;
  const projectLogs = useProjectLogCollection(environment?.sessionId ?? null, observedProject, !connecting && !reconnectRequired, onLogError);
  async function releaseObservationHold() {
    const hold = observationHold.current; observationHold.current = null;
    if (hold) try { await observationApi.release(hold.sessionId, hold.holdId); } catch (original) { onStatsError(original, coreError(original), hold.sessionId); }
  }
  function closeConfirmation() { setConfirmation(null); void releaseObservationHold(); }
  async function prepareConfirmation(containers: Container[], action: 'stop' | 'restart', returnFocus?: HTMLElement, bulk = false) {
    if (!session.current || preparingAction || compose.busyRef.current) return;
    const targetSession = session.current;
    setPreparingAction(true);
    try {
      const hold = await observationApi.hold(targetSession);
      if (session.current !== targetSession || blocked.current) { await observationApi.release(hold.sessionId, hold.holdId); return; }
      observationHold.current = hold;
      acceptObservationInventory(hold.inventory);
      const ids = new Set(containers.map(item => item.fullId));
      const current = hold.inventory.containers.filter(item => ids.has(item.fullId));
      if (hold.inventory.stale || !current.some(item => canApply(item, action))) { await releaseObservationHold(); return; }
      const common = { action, sessionId: targetSession, generation: hold.inventory.generation, ...connectionTarget(environment), returnFocus };
      if (bulk) setConfirmation({ ...common, containers: current });
      else if (current[0] && current[0].fullId === selectedIdRef.current) setConfirmation({ ...common, container: current[0] });
      else await releaseObservationHold();
    } catch (original) { onStatsError(original, coreError(original), targetSession); await releaseObservationHold(); }
    finally { setPreparingAction(false); }
  }
  async function startObserved(containers: Container[], bulk = false) {
    if (!session.current || preparingAction || compose.busyRef.current) return;
    const targetSession = session.current;
    setPreparingAction(true);
    try {
      const hold = await observationApi.hold(targetSession);
      if (session.current !== targetSession || blocked.current) { await observationApi.release(hold.sessionId, hold.holdId); return; }
      observationHold.current = hold;
      acceptObservationInventory(hold.inventory);
      const ids = new Set(containers.map(item => item.fullId));
      const current = hold.inventory.containers.filter(item => ids.has(item.fullId));
      if (bulk) await mutateBulk(current, 'start', targetSession, hold.inventory.generation);
      else if (current[0]) await mutate(current[0], 'start', targetSession, hold.inventory.generation);
    } catch (original) { onStatsError(original, coreError(original), targetSession); }
    finally { await releaseObservationHold(); setPreparingAction(false); }
  }
  function inspectContainer(fullId: string, tab: 'logs' | 'diagnostics' | 'storage', mountKey?: string) {
    const current = currentSnapshot.current;
    if (!current || current.sessionId !== session.current || current.stale || reconnectRequired
      || !current.containers.some(item => item.fullId === fullId)) return;
    if (compose.modal?.kind === 'progress') {
      if (compose.previousSession || compose.operation?.sessionId !== current.sessionId) return;
      compose.close();
    }
    selectContainer(fullId);
    setActiveTab(tab);
    setStorageHighlight(tab === 'storage' && mountKey ? { fullId, key: mountKey } : null);
    pendingDetailFocus.current = { sessionId: current.sessionId, fullId, tab };
  }
  useEffect(() => {
    const pending = pendingDetailFocus.current;
    if (!pending) return;
    if (pending.sessionId !== session.current || selectedTarget?.kind !== 'container'
      || selectedTarget.fullId !== pending.fullId) { pendingDetailFocus.current = null; return; }
    if (compose.modal || activeTab !== pending.tab) return;
    const tab = document.querySelector<HTMLButtonElement>(`.container-detail [data-detail-tab="${pending.tab}"]`);
    if (tab) { pendingDetailFocus.current = null; tab.focus(); }
  }, [selectedTarget, activeTab, compose.modal, snapshot?.sessionId]);
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
  function updateSearch(nextQuery: string, nextFilter: Filter) {
    if (busy.current) return;
    pendingRemovedFocus.current = document.activeElement;
    searchCriteria.current = { query: nextQuery, filter: nextFilter, project: allProjects };
    setQuery(nextQuery); setFilter(nextFilter);
    setCheckedHandles(previous => new Set(currentSnapshot.current?.containers.filter(item => previous.has(item.handle) && matchesContainer(item, nextQuery, nextFilter)).map(item => item.handle)));
  }
  useLayoutEffect(() => {
    const previous = pendingRemovedFocus.current;
    pendingRemovedFocus.current = null;
    if (previous && !previous.isConnected && (document.activeElement === document.body || document.activeElement === document.documentElement)) {
      const firstRow = inventory.current?.querySelector<HTMLElement>('[role="treeitem"]');
      (firstRow ?? searchInput.current)?.focus();
    }
  }, [snapshot, query, filter]);
  const refresh = useCallback(async (sessionId: string) => {
    const requestEpoch = epoch.current;
    const request = ++listSequence.current;
    refreshBusy.current = true;
    setRefreshing(true);
    try {
      const result = await api.listContainers(sessionId);
      if (epoch.current !== requestEpoch || session.current !== sessionId || request !== listSequence.current) return false;
      if (result.sessionId !== sessionId || (currentSnapshot.current && (result.generation < currentSnapshot.current.generation || (result.generation === currentSnapshot.current.generation && JSON.stringify(result.containers) !== JSON.stringify(currentSnapshot.current.containers))))) throw frontendError('staleInventory');
      pendingRemovedFocus.current = document.activeElement;
      const previous = currentSnapshot.current;
      setCheckedHandles(handles => { const ids = new Set(previous?.containers.filter(item => handles.has(item.handle)).map(item => item.fullId)); return new Set(result.containers.filter(item => ids.has(item.fullId) && matchesContainer(item, searchCriteria.current.query, searchCriteria.current.filter)).map(item => item.handle)); });
      currentSnapshot.current = result;
      setSnapshot(result);
      setListError(null);
      const criteria = searchCriteria.current;
      const matching = groupContainers(result.containers.filter(container => matchesContainer(container, criteria.query, criteria.filter, criteria.project))).flatMap(group => group.containers);
      if (initialSelection.current) { initialSelection.current = false; selectContainer(matching[0]?.fullId ?? null); }
      else reconcileTarget(result, previous);
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
  }, [clearLogs, selectContainer, recordIssue, reconcileTarget]);
  composeRefresh.current = refresh;
  const connect = useCallback(async () => {
    if (busy.current || refreshBusy.current) return;
    pendingBulkFocus.current = null;
    const requestEpoch = ++epoch.current;
    session.current = null;
    logViewCache.clear();
    standaloneLogViewCache.clear();
    currentSnapshot.current = null;
    ++listSequence.current;
    refreshBusy.current = false;
    setConnecting(true);
    setSessionIssue(previous => previous ? { ...previous, scope: 'previous' } : null);
    setEnvironment(null);
    setEnvironmentError(null);
    setSnapshot(null);
    setTabs({});
    setListError(null);
    clearLogs();
    setRefreshing(false);
    setConfirmation(null);
    observationHold.current = null;
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
  }, [clearLogs, refresh, selectContainer, logViewCache, standaloneLogViewCache]);
  useEffect(() => {
    // Defer one microtask so development StrictMode's discarded mount never opens a session.
    let active = true;
    void Promise.resolve().then(() => { if (active) void connect(); });
    return () => { active = false; ++epoch.current; };
  }, [connect]);
  async function mutate(container: Container, action: Action, targetSession: string, generation: number) {
    const current = currentSnapshot.current;
    const currentContainer = current?.containers.find(item => item.handle === container.handle);
    const actionAllowed = currentContainer && canApply(currentContainer, action);
    if (compose.busyRef.current || busy.current || refreshBusy.current || blocked.current || selectedIdRef.current !== container.fullId || !actionAllowed || session.current !== targetSession || current?.stale || current?.generation !== generation || !current.containers.some(item => item.handle === container.handle)) return;
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
    await releaseObservationHold();
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
    if (compose.busyRef.current || compose.modal || settingsOpen || logsExpanded || preparingAction || observation.restoring || busy.current || refreshBusy.current || blocked.current || !selected || selectedIdRef.current !== selected.fullId || !snapshot || snapshot.stale || !environment?.mutationAllowed || !session.current || !canApply(selected, action)) return;
    if (action === 'start') { if (nativeObservation) void startObserved([selected]); else void mutate(selected, action, session.current, snapshot.generation); }
    else if (nativeObservation) void prepareConfirmation([selected], action, returnFocus);
    else setConfirmation({ container: selected, action, sessionId: session.current, generation: snapshot.generation, ...connectionTarget(environment), returnFocus });
  }
  async function mutateBulk(containers: Container[], action: Action, targetSession: string, generation: number) {
    const current = currentSnapshot.current;
    const criteria = searchCriteria.current;
    if (containers.some(container => !matchesContainer(container, criteria.query, criteria.filter, criteria.project))) return;
    if (compose.busyRef.current || busy.current || refreshBusy.current || blocked.current || !containers.length || !containers.some(container => canApply(container, action)) || session.current !== targetSession || current?.stale || current?.generation !== generation || containers.some(container => !current.containers.some(item => item.handle === container.handle))) return;
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
        // A completed bulk attempt consumes its action selection; ordinary refresh does not.
        setCheckedHandles(new Set());
        const refreshed = await refresh(targetSession);
        await releaseObservationHold();
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
    if (compose.busyRef.current || compose.modal || settingsOpen || logsExpanded || preparingAction || observation.restoring || busy.current || refreshBusy.current || blocked.current || !checked.length || !checked.some(container => canApply(container, action)) || !snapshot || snapshot.stale || !environment?.mutationAllowed || !session.current) return;
    if (action === 'start') { if (nativeObservation) void startObserved(checked, true); else void mutateBulk(checked, action, session.current, snapshot.generation); }
    else if (nativeObservation) void prepareConfirmation(checked, action, returnFocus, true);
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
  function beginDisplayedLogsClear() {
    const id = ++clipboardAttempt.current;
    return () => {
      if (clipboardAttempt.current === id) setClipboardMessage({ id, key: 'logsCleared', highlightUntil: Date.now() + 2_000, highlighted: true });
    };
  }
  function clearDisplayedLogs() {
    const completed = beginDisplayedLogsClear();
    clearLogs();
    completed();
  }
  const ready = environment?.status === 'ready' && !!environment.sessionId;
  const connectionStatus = connecting ? t('checking') : reconnectRequired ? t('reconnectRequired') : ready ? t('connected') : t('disconnected');
  const connectionClass = connecting ? 'checking' : reconnectRequired ? 'reconnect-required' : ready ? 'connected' : '';
  const frontendSession: FrontendSession = {
    currentStatus: connecting ? 'checking' : reconnectRequired ? 'reconnectRequired' : ready ? 'connected' : 'disconnected',
    effectiveMutationBlocked: compose.busy || preparingAction || observation.restoring || connecting || !ready || !environment?.mutationAllowed || !snapshot || snapshot.stale || refreshing || mutating || mutationBlocked,
    reconnectRequired,
    inventoryStale: snapshot?.stale ?? null, inventoryRefreshedAt: snapshot?.refreshedAt ?? null,
    issue: sessionIssue,
  };
  const connectionError = environmentError ?? environment?.error ?? null;
  const [connectionTitle, connectionHelp] = connectionIssue(connectionError, environment?.status === 'unsupported');
  const copyFeedback = clipboardMessage ? clipboardMessage.key === 'copied' ? t('copied', { label: t(clipboardMessage.label) }) : t(clipboardMessage.key) : '';
  const copyFeedbackTone = clipboardMessage?.key === 'logsCleared' ? 'cleared' : clipboardMessage?.key === 'copyFailure' ? 'error' : 'success';
  const projectCopyProps = { copy, onClearStarted: beginDisplayedLogsClear, copyFeedback, copyFeedbackTone, copyFeedbackId: clipboardMessage?.id,
    copyFeedbackHighlighted: clipboardMessage?.highlighted, copyFeedbackHighlightUntil: clipboardMessage?.highlightUntil } as const;
  const storagePanel = snapshot && selectedTarget && <StoragePanel {...mounts} containers={snapshot.containers}
    target={selectedTarget} disabled={!detailsEnabled || snapshot.stale}
    highlightMountKey={selectedTarget.kind === 'container' && storageHighlight?.fullId === selectedTarget.fullId ? storageHighlight.key : null}
    onNavigate={(fullId, key) => inspectContainer(fullId, 'storage', key)} copy={text => copy(text, 'path')} />;
  return <div className="app-shell">
    <div className="main-content" inert={!!confirmation || settingsOpen || logsExpanded || !!compose.modal}>
      <header className="app-header">
        <div className="brand"><BrandMark /><h1>Docker2U</h1></div>
        <section className="connection-bar" aria-label={t('connection')}>
          <div className="connection-label"><span className={`connection-dot ${connectionClass}`} aria-hidden="true" /><div className="connection-target"><strong title={environment?.endpoint ?? undefined}>{environment?.contextName ?? t('contextPending')}</strong></div><span className="connection-status" role="status">{connectionStatus}</span></div>
          <button ref={reconnectTrigger} className="text-button" title={t('reconnectHint')} onClick={() => void connect()} disabled={preparingAction || connecting || refreshing || mutating}><Cable size={14} aria-hidden="true" />{t('reconnect')}</button>
        </section>
        <div className="header-right">
          {compose.available && <button className="text-button" aria-haspopup="dialog" disabled={compose.busy || preparingAction || mutating} onClick={() => compose.openEditor()}><Plus size={15} aria-hidden="true" />{ct('add')}</button>}
          <button className="icon-button" title={t('showDiagnostics')} aria-label={t('showDiagnostics')} aria-expanded={showDiagnostics} onClick={() => setShowDiagnostics(!showDiagnostics)}><Info size={17} aria-hidden="true" /></button>
          <button ref={settingsTrigger} className="icon-button" aria-label={t('settings')} title={t('settings')} aria-haspopup="dialog" onClick={() => { if (!confirmation && !logsExpanded) setSettingsOpen(true); }}><Settings size={17} aria-hidden="true" /></button>
        </div>
      </header>
      {showDiagnostics && <><p className="connection-help">{t('connectionHelp')}</p><Diagnostics environment={environment} frontendSession={frontendSession} close={() => setShowDiagnostics(false)} copy={copy} /></>}
      <main ref={pane.workspaceRef} className={`workspace${pane.dragging ? ' resizing' : ''}`} style={pane.workspaceStyle}>
        <aside id="inventory-pane" className="inventory-panel" aria-labelledby="inventory-title">
          <div className="panel-heading"><h2 id="inventory-title">{t('containers')} <span className="count-badge">{snapshot?.containers.length ?? '—'}</span></h2><RefreshAge refreshedAt={snapshot?.refreshedAt} /></div>
          <div className="inventory-controls">
            <div className="search-field"><Search size={16} aria-hidden="true" /><input ref={searchInput} aria-label={t('search')} placeholder={t('searchHint')} value={query} disabled={mutating || preparingAction} onChange={event => updateSearch(event.target.value, filter)} />{query && <button className="search-clear" aria-label={t('clearSearch')} title={t('clearSearch')} disabled={mutating || preparingAction} onClick={() => { updateSearch('', filter); searchInput.current?.focus(); }}><X size={14} aria-hidden="true" /></button>}</div>
            <div className="filter-group" aria-label={t('filters')}>{(['all', 'running', 'stopped', 'attention'] as const).map(value => <button key={value} aria-pressed={filter === value} disabled={mutating || preparingAction} onClick={() => updateSearch(query, value)}>{t(value)}</button>)}</div>
            <button title={t('refreshHint')} className="inventory-refresh" disabled={preparingAction || !ready || refreshing || mutating} onClick={() => { if (session.current && !busy.current && !refreshBusy.current) void refresh(session.current).then(refreshed => { if (refreshed) setLogRestartVersion(value => value + 1); }); }}><RefreshCw size={14} className={refreshing ? 'spin' : ''} aria-hidden="true" />{t(refreshing ? 'refreshing' : 'refresh')}</button>
          </div>
          <div className="inventory-body">
          <BulkSelection visible={visible} checked={checked} disabled={mutating || refreshing || connecting || !snapshot || snapshot.stale} actionsDisabled={compose.busy || preparingAction || observation.restoring || mutating || refreshing || mutationBlocked || !environment?.mutationAllowed || !snapshot || snapshot.stale} selectAllRef={bulkSelectAll} regionRef={bulkRegion} onToggleAll={() => changeSelection(() => checked.length === visible.length ? new Set() : new Set(visible.map(container => container.handle)))} onClear={() => changeSelection(() => new Set())} onAction={requestBulkAction} />
          {snapshot?.stale && <div className="stale-notice" role="status"><AlertTriangle size={14} aria-hidden="true" /><span>{t('stale')}</span></div>}
          {listError && <div className="inline-error" role="alert"><p>{t('listFailure')}</p>{connectionInvalidatingErrors.has(listError.code) && <p>{t('validateAgain')}</p>}<ErrorDetails error={listError} /></div>}
          {compose.registryError && <div className="inline-error" role="alert"><p>{ct('registryFailed')}</p><ErrorDetails error={compose.registryError} /><button onClick={() => void compose.reload()}>{ct('retry')}</button></div>}
          {stats.error && <p className="stats-notice" role="status">{t('statsFailure')}</p>}
          <ContainerTable groups={groups} selectedTarget={selectedTarget} checkedHandles={checkedHandles}
            checkboxDisabled={mutating || refreshing || !!snapshot?.stale} sampleFor={stats.sampleFor}
            onProjectView={openProject} inventoryRef={inventory} onSelect={container => selectContainer(container.fullId)} onShowConnections={showConnections}
            onToggle={container => changeSelection(previous => { const next = new Set(previous); if (next.has(container.handle)) next.delete(container.handle); else next.add(container.handle); return next; })}
            busy={preparingAction || refreshing || mutating} />
          {!groups.length && <div className="inventory-placeholder"><BrandMark size={48} /><p>{t(connecting || (refreshing && !snapshot) ? 'checkingContainers' : !ready ? 'connectForList' : !snapshot ? 'reloadList' : snapshot.containers.length === 0 ? 'emptyEngine' : 'noResults')}</p>{snapshot && snapshot.containers.length > 0 && <button className="text-button" disabled={mutating || preparingAction} onClick={() => updateSearch('', 'all')}>{t('resetFilters')}</button>}</div>}
          </div>
        </aside>
        <button type="button" role="separator" className="pane-resizer" aria-label={t('resizeLogs')} title={t('resizeLogsHint')} aria-controls="inventory-pane detail-pane" {...pane.separatorProps}><span aria-hidden="true" /></button>
        <section id="detail-pane" className="detail-panel" aria-label={t(selected ? 'detailTitle' : 'connectTitle')}>
          <div className="detail-context" tabIndex={0} aria-label={t('detailContext')}>
            {feedback.detailsOpen && feedback.completed && <div id="latest-operation-details" className="latest-operation operation-details-dismissable" aria-label={t('latestOperation')} onKeyDown={event => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); closeOperationDetails(); } }}>
              <div className="operation-details-heading"><p>{t('operationTime')} · <time dateTime={feedback.completed.completedAt}>{formatTime(feedback.completed.completedAt, language)}</time></p><button ref={operationClose} className="icon-button" aria-label={t('closeOperationDetails')} onClick={closeOperationDetails}><X size={15} aria-hidden="true" /></button></div>
              {feedback.completed.result.kind === 'single' ? <OperationResult disclosure={false} operation={feedback.completed.result.operation} copy={copy} /> : <BulkResult disclosure={false} operation={feedback.completed.result.operation} />}
              {!feedback.completed.refreshed && <p className="operation-warning">{t('operationRefreshFailed')}</p>}
            </div>}
            {selected && snapshot ? <ContainerSummary container={selected} snapshot={snapshot} mutationBlocked={compose.busy || mutationBlocked || preparingAction || observation.restoring} mutationAllowed={!!environment?.mutationAllowed} resourceSample={stats.sampleFor(selected)} /> : <div className="panel-heading"><h2>{projectView ? `${ot('project')} · ${observedProject ?? ot('noProject')}` : t('connectTitle')}</h2></div>}
            {compose.available && projectView && observedProject && <ComposeProjectControls project={registeredProject} name={observedProject} count={projectContainers.length} disabled={compose.busy || preparingAction || mutating || mutationBlocked || !ready || !environment?.mutationAllowed || !!snapshot?.stale} editDisabled={compose.busy || preparingAction || mutating} onPrepare={action => { if (registeredProject) void compose.prepare(registeredProject, action); }} onEdit={() => compose.openEditor(registeredProject, observedProject)} />}
            {targetHidden && <p className="selection-hidden-notice" role="status">{t('selectionHidden')}</p>}
          </div>
          {connecting ? <div className="startup-panel"><div className="startup-icon"><LoaderCircle className="spin" size={30} aria-hidden="true" /></div><h3>{t('checkingLocal')}</h3><p>{t('checkingCli')}</p></div> : !ready ? <div className="startup-panel"><div className="startup-icon"><Cable size={32} aria-hidden="true" /></div><span className="eyebrow">{t('localEnvironment')}</span><h3>{t(connectionTitle)}</h3><p>{t(connectionHelp)}</p>{connectionError && <div role="alert"><ErrorDetails error={connectionError} /></div>}{!!environment?.diagnostics.length && <details className="technical-details"><summary>{t('originalDiagnostics')}</summary>{environment.diagnostics.map((message, index) => <p key={index}>{message}</p>)}</details>}<button className="primary-button" onClick={() => void connect()}><RefreshCw size={14} aria-hidden="true" />{t('reconnect')}</button></div> : projectView && snapshot ? <div className={`project-detail${projectTab === 'logs' ? ' project-log-detail' : ''}`}><div className="detail-tabs project-tabs" role="tablist" aria-label={ot('project')}>{(['logs', 'storage', 'history'] as const).map(tab => <button key={tab} role="tab" id={`project-${tab}-tab`} aria-controls={`project-${tab}-panel`} tabIndex={projectTab === tab ? 0 : -1} aria-selected={projectTab === tab} onKeyDown={event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const projectTabs = ['logs', 'storage', 'history'] as const; const index = projectTabs.indexOf(tab); const next = event.key === 'Home' ? 'logs' : event.key === 'End' ? 'history' : projectTabs[(index + (event.key === 'ArrowRight' ? 1 : 2)) % 3]!; setProjectTab(next); document.getElementById(`project-${next}-tab`)?.focus(); } }} onClick={() => setProjectTab(tab)}>{ot(tab)}</button>)}</div><div id="project-storage-panel" className="detail-tab-panel" role="tabpanel" aria-labelledby="project-storage-tab" hidden={projectTab !== 'storage'}>{projectTab === 'storage' && storagePanel}</div><div id="project-history-panel" className="detail-tab-panel" role="tabpanel" aria-labelledby="project-history-tab" hidden={projectTab !== 'history'}><ObservationHistory onRetry={reconnectRequired ? undefined : () => void observation.retryEvents()} retrying={observation.retryingEvents} observation={observation.view} scope={project} containers={projectContainers} /></div><div id="project-logs-panel" className="detail-tab-panel project-log-panel" role="tabpanel" aria-labelledby="project-logs-tab" hidden={projectTab !== 'logs'}>{observedProject ? <ProjectLogs {...projectCopyProps} viewCache={logViewCache} key={`${snapshot.sessionId}/${observedProject}`} sessionId={snapshot.sessionId} project={observedProject} containers={projectContainers} visible={projectTab === 'logs'} initialPage={projectLogs.page} configure={projectLogs.configure} retry={projectLogs.retry} retrying={projectLogs.retrying} error={projectLogs.error} onError={onLogError} /> : <p className="observation-hint">{ot('allProjectsHint')}</p>}</div></div> : selected && snapshot ? <ContainerDetail logViewCache={standaloneLogViewCache} activeTab={activeTab} onTabChange={setActiveTab} historyEnabled={true} logContent={nativeObservation && observedProject ? <ProjectLogs {...projectCopyProps} viewCache={logViewCache} key={`${snapshot.sessionId}/${observedProject}/${selected.fullId}`} sessionId={snapshot.sessionId} project={observedProject} containers={projectContainers} fullId={selected.fullId} initialPage={projectLogs.page} configure={projectLogs.configure} retry={projectLogs.retry} retrying={projectLogs.retrying} error={projectLogs.error} visible={activeTab === 'logs'} onError={onLogError} /> : undefined} insights={activeTab === 'storage' ? storagePanel : activeTab === 'history' ? <ObservationHistory onRetry={reconnectRequired ? undefined : () => void observation.retryEvents()} retrying={observation.retryingEvents} observation={observation.view} scope={project} containers={projectContainers} fullId={selected.fullId} /> : activeTab !== 'logs' ? <>{activeTab === 'connectivity' && <ContainerInformation container={selected} snapshot={snapshot} copy={copy} resourceSample={stats.sampleFor(selected)} />}<ContainerInsights tab={activeTab} {...details} disabled={!detailsEnabled || !!snapshot.stale} copy={copy} /></> : undefined} operationFeedback={<OperationFeedback model={feedback} detailsId="latest-operation-details" onOpenDetails={openOperationDetails} />} container={selected} snapshot={snapshot} logs={logs} logsError={logsError} loadingLogs={loadingLogs} logRequestPending={logRequestPending} refreshing={refreshing} mutating={mutating} mutationBlocked={compose.busy || mutationBlocked || preparingAction || observation.restoring} mutationAllowed={!!environment?.mutationAllowed} liveStatus={liveStatus} loadLogs={loadLogs} clearLogs={clearDisplayedLogs} requestAction={requestAction} copy={copy} copyFeedback={copyFeedback} copyFeedbackTone={copyFeedbackTone} copyFeedbackId={clipboardMessage?.id} copyFeedbackHighlighted={clipboardMessage?.highlighted} copyFeedbackHighlightUntil={clipboardMessage?.highlightUntil} logsExpanded={logsExpanded} onLogsExpandedChange={setLogsExpanded} /> : <div className="startup-panel"><div className="startup-icon"><BrandMark size={56} /></div><h3>{t(refreshing ? 'loadingContainers' : snapshot?.containers.length === 0 ? 'noContainers' : 'selectContainer')}</h3><p>{t(snapshot?.containers.length === 0 ? 'startServices' : 'selectHelp')}</p></div>}
        </section>
      </main>
      <footer className="app-footer"><span><span className="footer-dot" />{t('footer')}</span>{compose.operation && <button className="compose-statusbar" data-active={compose.busy || undefined} aria-label={ct('recent')} title={ct('progress')} onClick={compose.openProgress}>{compose.busy ? <LoaderCircle size={13} className="spin" aria-hidden="true" /> : <Terminal size={13} aria-hidden="true" />}<span>{compose.feedbackOperation?.projectName} · {ct(compose.feedbackOperation?.sessionId !== environment?.sessionId ? 'previousSession' : compose.feedbackOperation?.outcome ?? (compose.feedbackOperation?.phase === 'reconciling' ? 'reconciling' : 'running'))}</span></button>}<OperationFeedback model={feedback} detailsId="latest-operation-details" recentButtonRef={recentOperationTrigger} onOpenDetails={openOperationDetails} announce={!logsExpanded} /><CopyFeedback className="clipboard-feedback" message={copyFeedback} tone={copyFeedbackTone} notificationId={clipboardMessage?.id} highlighted={clipboardMessage?.highlighted} highlightUntil={clipboardMessage?.highlightUntil} /></footer>
    </div>
    {compose.modal?.kind === 'editor' && <ComposeEditorDialog key={compose.modal.project?.id ?? 'new'} project={compose.modal.project} initialName={compose.modal.name} engine={connectionTarget(environment)} sessionId={!connecting && !reconnectRequired ? environment?.sessionId ?? null : null} onClose={compose.close} onRegistryChanged={() => void compose.reload()} onSaved={project => { compose.saved(project); openProject(project.name); }} onForget={compose.modal.project ? () => { if (compose.modal?.kind === 'editor' && compose.modal.project) compose.openForget(compose.modal.project); } : undefined} onError={(error, sessionId) => composeError.current(error, sessionId)} />}
    {compose.modal?.kind === 'prepare' && <ComposePrepareDialog project={compose.modal.project} action={compose.modal.action} preparation={compose.preparation} engine={compose.engine} loading={compose.preparing} starting={compose.starting} error={compose.actionError} onClose={compose.close} onRetry={() => { if (compose.modal?.kind === 'prepare') void compose.prepare(compose.modal.project, compose.modal.action); }} onStart={() => void compose.start()} />}
    {compose.modal?.kind === 'progress' && compose.operation && <ComposeProgressDialog operation={compose.operation} recentOperations={compose.recentOperations} onSelectOperation={compose.selectOperation} text={compose.text} truncated={compose.truncated} readError={compose.readError} previousSession={compose.previousSession} services={compose.services} containers={snapshot?.containers ?? []} observedAt={snapshot?.refreshedAt ?? null} stale={!snapshot || snapshot.stale || reconnectRequired || snapshot.sessionId !== compose.operation.sessionId} onInspect={inspectContainer} cancelling={compose.cancelling} refreshFailed={compose.refreshFailed} onClose={compose.close} onCancel={() => void compose.cancel()} onRetry={compose.retryRead} />}
    {compose.modal?.kind === 'forget' && <ComposeForgetDialog project={compose.modal.project} busy={compose.removing} error={compose.actionError} onClose={compose.close} onConfirm={() => { if (compose.modal?.kind !== 'forget') return; const target = compose.modal.project; void compose.remove(target).then(removed => { if (removed && selectionRef.current?.kind === 'project' && selectionRef.current.name === target.name && !currentSnapshot.current?.containers.some(item => projectName(item) === target.name)) selectTarget(null); }); }} />}
    {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} returnFocus={settingsTrigger.current ?? undefined} />}
    {confirmation && <ConfirmDialog confirmation={confirmation} blocked={reconnectRequired} reconnectFocus={reconnectTrigger} onCancel={closeConfirmation} onConfirm={() => { if (confirmation.containers) void mutateBulk(confirmation.containers, confirmation.action, confirmation.sessionId, confirmation.generation).finally(releaseObservationHold); else void mutate(confirmation.container, confirmation.action, confirmation.sessionId, confirmation.generation).finally(releaseObservationHold); }} />}
  </div>;
}
