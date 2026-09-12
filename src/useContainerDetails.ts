import { useCallback, useEffect, useRef, useState } from 'react';
import { api, coreError, type Container, type ContainerList, type CoreError } from './api';
import type { ContainerDetails } from './containerDetailsTypes';
import { connectionInvalidatingErrors } from './frontendSession';

export interface ContainerDetailsInput {
  container: Container | null;
  snapshot: ContainerList | null;
  active: boolean;
  enabled: boolean;
  onError: (original: unknown, failure: CoreError, sessionId: string) => void;
}
export interface ContainerDetailsState {
  details: ContainerDetails | null;
  error: CoreError | null;
  loading: boolean;
  stale: boolean;
  reload: () => void;
}
type View = Omit<ContainerDetailsState, 'reload'> & { key: string; settled: boolean };
const emptyView = (key = ''): View => ({ key, details: null, error: null, loading: false, stale: false, settled: false });

/** One lazy snapshot shared by both detail tabs; no background polling. */
export function useContainerDetails({ container, snapshot, active, enabled, onError }: ContainerDetailsInput): ContainerDetailsState {
  const [view, setView] = useState<View>(() => emptyView());
  const [revision, setRevision] = useState(0);
  const viewRef = useRef(view);
  const inFlight = useRef<Promise<void> | null>(null);
  const key = JSON.stringify([snapshot?.sessionId, snapshot?.generation, container?.handle, container?.fullId]);
  const valid = !!container && !!snapshot && !snapshot.stale
    && snapshot.containers.some(item => item.handle === container.handle && item.fullId === container.fullId);
  const allowed = valid && enabled;
  const latest = useRef({ key, snapshot, container, allowed, active, onError });
  latest.current = { key, snapshot, container, allowed, active, onError };
  const update = (next: View) => { viewRef.current = next; setView(next); };

  useEffect(() => {
    let live = true;
    const current = () => live && latest.current.key === key && latest.current.allowed;
    if (viewRef.current.key !== key) {
      const prior = viewRef.current.details;
      const sameIdentity = prior?.sessionId === snapshot?.sessionId && prior?.fullId === container?.fullId;
      update({ ...emptyView(key), details: sameIdentity ? prior : null, stale: sameIdentity });
    }
    if (!allowed) {
      if (viewRef.current.key === key) update({ ...viewRef.current, loading: false, stale: true, settled: false });
      return;
    }
    if (!active) return;
    async function collect() {
      // A selection change can wait for the old read, but never overlaps it.
      if (inFlight.current) await inFlight.current;
      if (!current() || !latest.current.active) return;
      if (viewRef.current.key === key && viewRef.current.settled && (!viewRef.current.stale || viewRef.current.error)) return;
      const input = latest.current;
      const list = input.snapshot!;
      const target = input.container!;
      const prior = viewRef.current.key === key ? viewRef.current.details : null;
      update({ key, details: prior, error: null, loading: true, stale: prior !== null, settled: false });
      const work = (async () => {
        try {
          const result = await api.getContainerDetails(list.sessionId, list.generation, target.handle);
          if (!current()) return;
          if (result.sessionId !== list.sessionId || result.generation !== list.generation
            || result.handle !== target.handle || result.fullId !== target.fullId
            || !Number.isFinite(Date.parse(result.observedAt))) {
            throw { code: 'InvalidDetailsResponse', message: 'Container details do not match the selected container.' };
          }
          update({ key, details: result, error: null, loading: false, stale: false, settled: true });
        } catch (original) {
          const failure = coreError(original);
          // A late Engine failure still gates the current session even if its panel closed.
          const invalidates = connectionInvalidatingErrors.has(failure.code);
          if (latest.current.snapshot?.sessionId === list.sessionId && invalidates) latest.current.onError(original, failure, list.sessionId);
          if (!current()) return;
          update({ key, details: prior, error: failure, loading: false, stale: prior !== null, settled: true });
          if (!invalidates) latest.current.onError(original, failure, list.sessionId);
        }
      })();
      inFlight.current = work;
      await work;
      if (inFlight.current === work) inFlight.current = null;
    }
    void collect();
    return () => { live = false; };
  }, [key, active, allowed, revision]);

  const reload = useCallback(() => {
    const input = latest.current;
    if (!input.allowed || !input.active || inFlight.current) return;
    const prior = viewRef.current.key === input.key ? viewRef.current : emptyView(input.key);
    update({ ...prior, stale: true, settled: false });
    setRevision(value => value + 1);
  }, []);
  const preserved = view.details?.sessionId === snapshot?.sessionId && view.details?.fullId === container?.fullId ? view.details : null;
  const currentView = view.key === key ? view : { ...emptyView(key), details: preserved, stale: preserved !== null };
  return { details: currentView.details, error: currentView.error,
    loading: currentView.loading && allowed,
    stale: currentView.details !== null && (currentView.stale || !allowed), reload };
}
