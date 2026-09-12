import { useCallback, useEffect, useRef, useState } from 'react';
import { coreError, type CoreError, type Environment } from './api';
import { composeApi, type ComposeAction, type ComposeOperation, type ComposePreparation, type ComposeProject, type ComposeServicePreview } from './composeApi';

export type ComposeModal = { kind: 'editor'; project: ComposeProject | null; name?: string }
  | { kind: 'prepare'; project: ComposeProject; action: ComposeAction }
  | { kind: 'progress' } | { kind: 'forget'; project: ComposeProject } | null;
interface Options {
  environment: Environment | null;
  enabled: boolean;
  refresh: (sessionId: string) => Promise<boolean>;
  onError: (error: CoreError, sessionId: string) => void;
}
const invalid = (): CoreError => ({ code: 'MalformedOutput', message: 'Compose response does not match the current request.' });
export function useComposeProjects(options: Options) {
  const available = composeApi.available();
  const sessionId = options.enabled ? options.environment?.sessionId ?? null : null;
  const latest = useRef(options); latest.current = options;
  const session = useRef(sessionId); session.current = sessionId;
  const mounted = useRef(true);
  const sequence = useRef(0);
  const startingRef = useRef(false);
  const [projects, setProjects] = useState<ComposeProject[]>([]);
  const [registryError, setRegistryError] = useState<CoreError | null>(null);
  const [issues, setIssues] = useState<Map<string, CoreError>>(new Map());
  const [modal, setModal] = useState<ComposeModal>(null);
  const [preparation, setPreparation] = useState<ComposePreparation | null>(null);
  const [engine, setEngine] = useState<Pick<Environment, 'contextName' | 'endpoint' | 'engineId'>>({ contextName: null, endpoint: null, engineId: null });
  const [preparing, setPreparing] = useState(false);
  const [starting, setStarting] = useState(false);
  const [actionError, setActionError] = useState<CoreError | null>(null);
  const [operation, setOperation] = useState<ComposeOperation | null>(null);
  const [recentOperations, setRecentOperations] = useState<ComposeOperation[]>([]);
  const [activeOperation, setActiveOperation] = useState<ComposeOperation | null>(null);
  const activeOperationRef = useRef(activeOperation); activeOperationRef.current = activeOperation;
  const listRequest = useRef(0);
  const registryRequest = useRef(0);
  const operationRef = useRef(operation); operationRef.current = operation;
  const [services, setServices] = useState<ComposeServicePreview[]>([]);
  const serviceCache = useRef(new Map<string, ComposeServicePreview[]>());
  const [text, setText] = useState('');
  const [truncated, setTruncated] = useState(false);
  const [readError, setReadError] = useState<CoreError | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [pollVersion, setPollVersion] = useState(0);
  const [removing, setRemoving] = useState(false);
  const preparationSession = useRef<string | null>(null);
  const requestId = useRef('');
  const busy = starting || refreshing || (!!activeOperation && activeOperation.sessionId === sessionId && activeOperation.phase !== 'finished');
  const busyRef = useRef(busy); busyRef.current = busy;
  const previousSession = !!operation && operation.sessionId !== sessionId;
  const report = useCallback((error: unknown, targetSession: string, project?: string) => {
    const failure = coreError(error);
    if (!mounted.current || session.current !== targetSession) return failure;
    if (project) setIssues(previous => new Map(previous).set(project, failure));
    latest.current.onError(failure, targetSession);
    return failure;
  }, []);
  const reload = useCallback(async () => {
    if (!available || !mounted.current) return;
    const attempt = ++registryRequest.current;
    try { const result = await composeApi.list(); if (mounted.current && attempt === registryRequest.current) { setProjects(result); setRegistryError(null); } }
    catch (error) { if (mounted.current && attempt === registryRequest.current) setRegistryError(coreError(error)); }
  }, [available]);
  useEffect(() => { mounted.current = true; void reload(); return () => { mounted.current = false; ++sequence.current; }; }, [reload]);
  useEffect(() => {
    ++sequence.current;
    preparationSession.current = null;
    startingRef.current = false;
    setStarting(false); setPreparing(false); setPreparation(null); setActionError(null); setCancelling(false); setRefreshing(false);
    setModal(current => current?.kind === 'prepare' ? null : current);
    setIssues(new Map()); setActiveOperation(null); activeOperationRef.current = null;
  }, [sessionId]);
  const close = useCallback(() => {
    // Closing a view never cancels a Core-owned operation.
    ++sequence.current;
    setModal(null); setPreparing(false); setActionError(null);
  }, []);
  const saved = useCallback((project: ComposeProject) => {
    ++registryRequest.current;
    setProjects(previous => [...previous.filter(item => item.id !== project.id), project].sort((a, b) => a.name.localeCompare(b.name)));
    setIssues(previous => { const next = new Map(previous); next.delete(project.name); return next; });
    setModal(null);
  }, []);
  const prepare = useCallback(async (project: ComposeProject, action: ComposeAction) => {
    const targetSession = session.current;
    if (!targetSession || busyRef.current || startingRef.current) return;
    const attempt = ++sequence.current;
    setModal({ kind: 'prepare', project, action }); setPreparation(null); setActionError(null); setPreparing(true);
    const currentEnvironment = latest.current.environment;
    setEngine({ contextName: currentEnvironment?.contextName ?? null, endpoint: currentEnvironment?.endpoint ?? null, engineId: currentEnvironment?.engineId ?? null });
    try {
      const result = await composeApi.prepare(targetSession, project.id, project.revision, action);
      if (!mounted.current || attempt !== sequence.current || session.current !== targetSession) return;
      if (result.project.id !== project.id || result.project.revision !== project.revision || result.project.name !== project.name || result.action !== action || !result.prepareId) throw invalid();
      preparationSession.current = targetSession;
      requestId.current = crypto.randomUUID();
      setPreparation(result);
      setIssues(previous => { const next = new Map(previous); next.delete(project.name); return next; });
    } catch (error) {
      if (attempt === sequence.current && session.current === targetSession) setActionError(report(error, targetSession, project.name));
    } finally { if (mounted.current && attempt === sequence.current) setPreparing(false); }
  }, [report]);
  const acceptOperation = useCallback((result: ComposeOperation, expectedSession: string, project: ComposeProject, action: ComposeAction) => {
    if (result.sessionId !== expectedSession || result.projectId !== project.id || result.projectName !== project.name || result.action !== action || !result.id) throw invalid();
    ++listRequest.current;
    setOperation(result); operationRef.current = result;
    setActiveOperation(result.phase === 'finished' ? null : result); activeOperationRef.current = result.phase === 'finished' ? null : result;
    setRecentOperations(previous => [result, ...previous.filter(item => item.id !== result.id)].slice(0, 10));
    setText(''); setTruncated(false); setReadError(null); setRefreshFailed(false); setModal({ kind: 'progress' });
  }, []);
  const start = useCallback(async () => {
    const targetSession = session.current;
    if (!targetSession || !preparation || preparationSession.current !== targetSession || startingRef.current || busyRef.current) return;
    startingRef.current = true; busyRef.current = true; setStarting(true); setActionError(null);
    const attempt = sequence.current;
    try {
      const result = await composeApi.start(targetSession, preparation.prepareId, requestId.current);
      if (!mounted.current || session.current !== targetSession) return;
      // A close while start is pending hides the dialog, not the resulting job.
      const closed = attempt !== sequence.current;
      acceptOperation(result, targetSession, preparation.project, preparation.action);
      setServices(preparation.services); serviceCache.current.set(result.id, preparation.services);
      if (closed) setModal(null);
    } catch (error) {
      if (mounted.current && session.current === targetSession) {
        // A lost start reply is ambiguous. Recover the already registered job;
        // an explicit subsequent start uses the same idempotency key.
        try {
          const jobs = await composeApi.operations(targetSession);
          if (!mounted.current || session.current !== targetSession) return;
          const job = jobs.find(item => item.sessionId === targetSession && item.projectId === preparation.project.id && item.action === preparation.action && item.phase !== 'finished');
          if (job) { acceptOperation(job, targetSession, preparation.project, preparation.action); setServices(preparation.services); serviceCache.current.set(job.id, preparation.services); if (attempt !== sequence.current) setModal(null); }
          else setActionError(report(error, targetSession, preparation.project.name));
        } catch (recoveryError) { if (mounted.current && session.current === targetSession) setActionError(report(recoveryError, targetSession, preparation.project.name)); }
      }
    } finally {
      if (mounted.current && session.current === targetSession) { startingRef.current = false; setStarting(false); busyRef.current = !!activeOperationRef.current && activeOperationRef.current.sessionId === targetSession && activeOperationRef.current.phase !== 'finished'; }
    }
  }, [preparation, acceptOperation, report]);
  const finishedRefresh = useRef(new Set<string>());
  const refreshCompleted = useCallback(async (target: ComposeOperation) => {
    if (finishedRefresh.current.has(target.id)) return;
    finishedRefresh.current.add(target.id); setRefreshing(true);
    try {
      const refreshed = await latest.current.refresh(target.sessionId);
      if (mounted.current && session.current === target.sessionId) setRefreshFailed(!refreshed);
    } catch { if (mounted.current && session.current === target.sessionId) setRefreshFailed(true); }
    finally { if (mounted.current && session.current === target.sessionId) setRefreshing(false); }
  }, []);
  useEffect(() => {
    if (!available || !sessionId) return;
    let live = true; let timer: ReturnType<typeof setTimeout> | undefined;
    async function list() {
      const attempt = ++listRequest.current;
      try {
        // Core returns its bounded journal oldest first; the UI opens the newest job.
        const jobs = (await composeApi.operations(sessionId!)).slice().reverse();
        if (!live || session.current !== sessionId || attempt !== listRequest.current) return;
        if (jobs.some(item => !item.sessionId || !item.id)) throw invalid();
        setRecentOperations(previous => [...jobs, ...previous.filter(item => !jobs.some(job => job.id === item.id))].slice(0, 10));
        const active = activeOperationRef.current;
        const current = active && jobs.find(item => item.id === active.id);
        if (current?.phase === 'finished' && operationRef.current?.id !== current.id) {
          setActiveOperation(null); activeOperationRef.current = null;
          // The selected operation drains its output before refreshing. A job
          // viewed in the background still reconciles the visible inventory.
          if (operationRef.current?.id !== current.id) await refreshCompleted(current);
        } else if (!active) {
          const running = jobs.find(item => item.sessionId === sessionId && item.phase !== 'finished');
          if (running) { setActiveOperation(running); activeOperationRef.current = running; }
        }
        if (!operationRef.current && jobs[0]) { setOperation(jobs[0]); operationRef.current = jobs[0]; }
      } catch (error) { if (live && session.current === sessionId && attempt === listRequest.current) setReadError(report(error, sessionId!)); }
      finally { if (live && activeOperationRef.current?.sessionId === sessionId) timer = setTimeout(() => void list(), 750); }
    }
    void list();
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [available, sessionId, activeOperation?.id, report, refreshCompleted]);
  useEffect(() => {
    const id = operation?.id;
    const operationSession = operation?.sessionId;
    if (!id || !sessionId || !operationSession) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cursor = 0;
    let replay = '';
    setReadError(null);
    async function poll() {
      try {
        const page = await composeApi.read(operationSession!, id!, cursor);
        if (!active || session.current !== sessionId) return;
        const current = operationRef.current;
        if (current?.id !== id || page.operation.id !== id || page.operation.sessionId !== operationSession || page.operation.projectId !== current?.projectId || page.operation.projectName !== current?.projectName || page.operation.action !== current?.action || page.nextSequence < cursor || page.oldestSequence > page.nextSequence + 1) throw invalid();
        cursor = page.nextSequence;
        setOperation(page.operation); operationRef.current = page.operation;
        setRecentOperations(previous => previous.map(item => item.id === page.operation.id ? page.operation : item));
        replay += page.text;
        if (replay.length > 2_000_000) setTruncated(true);
        replay = replay.slice(-2_000_000); setText(replay);
        setTruncated(previous => previous || page.truncated);
        setReadError(null);
        if (page.operation.phase !== 'finished' || page.text.length > 0) {
          // Terminal output is paged too. Drain to an empty page before the
          // final inventory refresh so the tail is never silently omitted.
          timer = setTimeout(() => void poll(), page.operation.phase === 'finished' ? 0 : 500);
        } else {
          if (activeOperationRef.current?.id === page.operation.id) { setActiveOperation(null); activeOperationRef.current = null; }
          if (operationSession === sessionId) await refreshCompleted(page.operation);
        }
      } catch (error) {
        if (active && session.current === sessionId && operationRef.current?.id === id) setReadError(operationSession === sessionId ? report(error, sessionId!, operationRef.current?.projectName) : coreError(error));
      }
    }
    void poll();
    return () => { active = false; if (timer) clearTimeout(timer); };
  }, [operation?.id, operation?.sessionId, sessionId, pollVersion, report, refreshCompleted]);
  const cancel = useCallback(async () => {
    const target = operationRef.current;
    if (!target || target.sessionId !== session.current || target.phase === 'finished' || target.cancelRequested || cancelling) return;
    setCancelling(true);
    try {
      const result = await composeApi.cancel(target.sessionId, target.id);
      if (!mounted.current || session.current !== target.sessionId || operationRef.current?.id !== target.id) return;
      if (result.id !== target.id || result.sessionId !== target.sessionId || result.projectId !== target.projectId) throw invalid();
      setOperation(result); operationRef.current = result; setReadError(null); setPollVersion(value => value + 1);
    } catch (error) { if (session.current === target.sessionId) setReadError(report(error, target.sessionId, target.projectName)); }
    finally { if (mounted.current && session.current === target.sessionId) setCancelling(false); }
  }, [cancelling, report]);
  const remove = useCallback(async (project: ComposeProject): Promise<boolean> => {
    if (busyRef.current || removing) return false;
    setRemoving(true); setActionError(null);
    try {
      await composeApi.remove(project.id, project.revision);
      if (!mounted.current) return false;
      ++registryRequest.current;
      setProjects(previous => previous.filter(item => item.id !== project.id)); setModal(null);
      return true;
    } catch (error) { if (mounted.current) setActionError(coreError(error)); return false; }
    finally { if (mounted.current) setRemoving(false); }
  }, [removing]);
  return { available, projects, registryError, issues, reload, modal, close, saved, prepare, start, preparation, engine, preparing, starting, actionError,
    operation, feedbackOperation: activeOperation ?? operation, recentOperations, text, truncated, readError, previousSession, services, cancelling, cancel, refreshing, refreshFailed, busy, busyRef, removing, remove,
    openEditor: (project: ComposeProject | null = null, name?: string) => { if (!busyRef.current) { setActionError(null); setModal({ kind: 'editor', project, name }); } },
    openForget: (project: ComposeProject) => { if (!busyRef.current) { setActionError(null); setModal({ kind: 'forget', project }); } },
    openProgress: () => {
      const active = activeOperationRef.current;
      if (active && active.id !== operationRef.current?.id) { setOperation(active); operationRef.current = active; setServices(serviceCache.current.get(active.id) ?? []); setText(''); setTruncated(false); setReadError(null); }
      if (operationRef.current) setModal({ kind: 'progress' });
    },
    selectOperation: (id: string) => {
      const target = recentOperations.find(item => item.id === id);
      if (!target || target.id === operationRef.current?.id) return;
      setOperation(target); operationRef.current = target; setServices(serviceCache.current.get(target.id) ?? []); setText(''); setTruncated(false); setReadError(null); setRefreshFailed(false);
    },
    retryRead: () => setPollVersion(value => value + 1),
  };
}
