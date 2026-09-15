import { useCallback, useEffect, useRef, useState } from 'react';
import { coreError, type Container, type ContainerList } from './api';
import { imageExportApi, validImageExportOperation, validImageExportSource, type ImageExportDestination, type ImageExportOperation, type ImageExportPreview } from './imageExportApi';

const invalidReply = () => ({ code: 'InvalidImageExportResponse', message: 'The image export response did not match the requested operation.' });
const rejectedStarts = new Set(['InvalidRequestId', 'ImageExportPreparationExpired', 'ImageExportDestinationUnavailable', 'ImageExportBusy', 'StaleSession', 'RequestConflict']);
type StartAttempt = { sessionId: string; requestId: string; prepareId: string; destinationToken: string; source: ImageExportPreview; path: string };
export function useImageExports({ sessionId, enabled }: { sessionId: string | null; enabled: boolean }) {
  const available = imageExportApi.available();
  const [modal, setModal] = useState<'review' | 'progress' | null>(null);
  const [preview, setPreview] = useState<ImageExportPreview | null>(null);
  const [destination, setDestination] = useState<ImageExportDestination | null>(null);
  const [loading, setLoading] = useState(false);
  const [picking, setPicking] = useState(false);
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<ReturnType<typeof coreError> | null>(null);
  const [readError, setReadError] = useState<ReturnType<typeof coreError> | null>(null);
  const [operation, setOperation] = useState<ImageExportOperation | null>(null);
  const [recent, setRecent] = useState<ImageExportOperation[]>([]);
  const [unresolved, setUnresolved] = useState<StartAttempt | null>(null);
  const [failedStart, setFailedStart] = useState<StartAttempt | null>(null);
  const [retryVersion, setRetryVersion] = useState(0);
  const mounted = useRef(true), sequence = useRef(0), currentSession = useRef(sessionId), enabledRef = useRef(enabled);
  const operationRef = useRef(operation), recentRef = useRef(recent), unresolvedRef = useRef(unresolved);
  const busyRef = useRef(false), actionRef = useRef(false), modalRef = useRef(modal);
  currentSession.current = sessionId; enabledRef.current = enabled; operationRef.current = operation; recentRef.current = recent; modalRef.current = modal; unresolvedRef.current = unresolved;
  const active = recent.find(item => item.phase !== 'finished') ?? null;
  busyRef.current = starting || !!unresolved || !!active;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; ++sequence.current; }; }, []);

  const accept = useCallback((value: ImageExportOperation, select = false) => {
    if (!validImageExportOperation(value)) throw invalidReply();
    const previous = recentRef.current.find(item => item.requestId === value.requestId);
    if (previous && (previous.id !== value.id || previous.sessionId !== value.sessionId || previous.containerId !== value.containerId || previous.imageId !== value.imageId || previous.path !== value.path || previous.engineId !== value.engineId || previous.engineEndpoint !== value.engineEndpoint)) throw invalidReply();
    // A late start/cancel reply cannot undo a newer terminal read or phase.
    const ranks = { queued: 0, exporting: 1, publishing: 2, finished: 3 };
    const accepted = previous && (previous.phase === 'finished' || (value.phase !== 'finished' && (ranks[previous.phase] > ranks[value.phase] || previous.bytesWritten > value.bytesWritten || previous.elapsedMs > value.elapsedMs))) ? previous : value;
    const next = [accepted, ...recentRef.current.filter(item => item.requestId !== accepted.requestId)].slice(0, 10);
    recentRef.current = next; setRecent(next);
    if (select || operationRef.current?.requestId === accepted.requestId) { operationRef.current = accepted; setOperation(accepted); }
    return accepted;
  }, []);
  useEffect(() => {
    ++sequence.current; actionRef.current = false; setPreview(null); setDestination(null); setLoading(false); setPicking(false); setError(null);
    setModal(value => value === 'review' ? null : value);
  }, [sessionId, enabled]);
  useEffect(() => {
    if (!available || !enabled || !sessionId) return;
    let stale = false;
    void imageExportApi.list(sessionId).then(values => {
      if (stale || !mounted.current || currentSession.current !== sessionId) return;
      if (!Array.isArray(values) || values.some(value => !validImageExportOperation(value))) throw invalidReply();
      const pending = unresolvedRef.current;
      const recovered = pending ? values.find(value => value.requestId === pending.requestId) : undefined;
      if (pending && recovered && !matches(recovered, pending)) throw invalidReply();
      for (const value of [...values].reverse()) accept(value);
      if (!operationRef.current && values.length) { const latest = values[0]!; operationRef.current = latest; setOperation(latest); }
      if (pending) {
        if (recovered) {
          accept(recovered, true); unresolvedRef.current = null; setUnresolved(null); setReadError(null);
        } else if (pending.sessionId !== sessionId) {
          // Reconnect retires the prior session before this authoritative list.
          setFailedStart(pending); unresolvedRef.current = null; setUnresolved(null);
          setReadError({ code: 'ImageExportNotStarted', message: 'The previous session ended without registering this export request.' });
        }
      }
    }).catch(original => { if (!stale && mounted.current) setReadError(coreError(original)); });
    return () => { stale = true; };
  }, [sessionId, enabled, available, accept, unresolved?.requestId]);

  async function prepare(container: Container, snapshot: ContainerList) {
    if (!available || !enabledRef.current || currentSession.current !== snapshot.sessionId || snapshot.stale || busyRef.current || actionRef.current) return;
    const attempt = ++sequence.current; actionRef.current = true; modalRef.current = 'review'; setModal('review'); setPreview(null); setDestination(null); setError(null); setFailedStart(null); setLoading(true);
    try {
      const value = await imageExportApi.prepare(snapshot.sessionId, snapshot.generation, container.handle);
      if (!mounted.current || sequence.current !== attempt || currentSession.current !== snapshot.sessionId) return;
      if (!validImageExportSource(value) || value.sessionId !== snapshot.sessionId || value.containerId !== container.fullId || !value.prepareId || typeof value.expiresAt !== 'string') throw invalidReply();
      setPreview(value);
    } catch (original) { if (mounted.current && sequence.current === attempt) setError(coreError(original)); }
    finally { if (mounted.current && sequence.current === attempt) { actionRef.current = false; setLoading(false); } }
  }
  async function pick() {
    if (!preview || actionRef.current || busyRef.current || !enabledRef.current || preview.sessionId !== currentSession.current) return;
    const attempt = ++sequence.current; actionRef.current = true; setPicking(true); setError(null);
    try {
      const value = await imageExportApi.pick(preview.sessionId, preview.prepareId);
      if (!mounted.current || sequence.current !== attempt || currentSession.current !== preview.sessionId) return;
      if (value !== null && (!value.destinationToken || typeof value.path !== 'string' || !value.path.toLowerCase().endsWith('.tar'))) throw invalidReply();
      if (value) setDestination(value);
    } catch (original) { if (mounted.current && sequence.current === attempt) setError(coreError(original)); }
    finally { if (mounted.current && sequence.current === attempt) { actionRef.current = false; setPicking(false); } }
  }
  function matches(value: ImageExportOperation, attempt: StartAttempt) {
    return validImageExportOperation(value) && value.requestId === attempt.requestId && value.sessionId === attempt.sessionId && value.containerId === attempt.source.containerId && value.imageId === attempt.source.imageId && value.path === attempt.path && value.engineId === attempt.source.engineId && value.engineEndpoint === attempt.source.engineEndpoint;
  }
  async function start() {
    if (!preview || !destination || actionRef.current || busyRef.current || !enabledRef.current || preview.sessionId !== currentSession.current) return;
    const attempt: StartAttempt = { sessionId: preview.sessionId, prepareId: preview.prepareId, destinationToken: destination.destinationToken, requestId: crypto.randomUUID(), source: preview, path: destination.path };
    actionRef.current = true; busyRef.current = true; setStarting(true); setFailedStart(null); setError(null); setReadError(null);
    try {
      const value = await imageExportApi.start(attempt.sessionId, attempt.prepareId, attempt.destinationToken, attempt.requestId);
      if (!mounted.current) return;
      if (!matches(value, attempt)) throw invalidReply();
      accept(value, true); if (modalRef.current) setModal('progress');
    } catch (original) {
      if (!mounted.current) return;
      const reported = coreError(original);
      if (rejectedStarts.has(reported.code)) { setFailedStart(attempt); setError(reported); setReadError(reported); return; }
      // Never resubmit a transport-ambiguous start with a new request ID.
      setUnresolved(attempt); unresolvedRef.current = attempt; setReadError(reported); if (modalRef.current) setModal('progress');
    } finally { if (mounted.current) { actionRef.current = false; setStarting(false); } }
  }
  const polling = active ?? (operation?.phase !== 'finished' ? operation : null);
  useEffect(() => {
    if (!polling && !unresolved) return;
    let stopped = false; let timer: ReturnType<typeof setTimeout>;
    async function read() {
      const target = unresolved ?? polling!;
      try {
        const value = await imageExportApi.read(target.sessionId, target.requestId);
        if (stopped || !mounted.current) return;
        if (value.sessionId !== target.sessionId || value.requestId !== target.requestId || (unresolved && !matches(value, unresolved))) throw invalidReply();
        accept(value, !!unresolved); setReadError(null);
        if (unresolved) { unresolvedRef.current = null; setUnresolved(null); }
        if (value.phase === 'finished') return;
      } catch (original) { if (!stopped && mounted.current) setReadError(coreError(original)); }
      if (!stopped) timer = setTimeout(() => void read(), 700);
    }
    void read();
    return () => { stopped = true; clearTimeout(timer); };
  }, [polling?.requestId, unresolved, accept, retryVersion]);
  async function cancel() {
    const target = operationRef.current;
    if (!target || target.phase === 'finished' || cancelling || !enabledRef.current || target.sessionId !== currentSession.current) return;
    setCancelling(true);
    try {
      const value = await imageExportApi.cancel(target.sessionId, target.requestId);
      if (!mounted.current) return;
      if (value.requestId !== target.requestId || value.sessionId !== target.sessionId) throw invalidReply();
      accept(value); setReadError(null);
    } catch (original) { if (mounted.current) setReadError(coreError(original)); }
    finally { if (mounted.current) setCancelling(false); }
  }
  function close() { ++sequence.current; actionRef.current = false; modalRef.current = null; setModal(null); setLoading(false); setPicking(false); }
  function openProgress() {
    const value = recentRef.current.find(item => item.phase !== 'finished') ?? operationRef.current ?? recentRef.current[0];
    if (value) { operationRef.current = value; setOperation(value); }
    if (value || unresolvedRef.current || failedStart) { modalRef.current = 'progress'; setModal('progress'); }
  }
  function selectOperation(value: ImageExportOperation) { setFailedStart(null); operationRef.current = value; setOperation(value); }
  return { available, modal, preview, destination, loading, picking, starting, cancelling, error, readError, operation, recent, unresolved, failedStart,
    busy: starting || !!unresolved || !!active, busyRef, modalRef, prepare, pick, start, cancel, close, openProgress, selectOperation,
    retry: () => setRetryVersion(value => value + 1), feedbackOperation: active ?? operation ?? recent[0] ?? null };
}
