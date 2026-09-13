import { useCallback, useEffect, useRef, useState } from 'react';
import { coreError, type ContainerList, type CoreError } from './api';
import { connectionInvalidatingErrors } from './frontendSession';
import { mountApi, validateMountInventory, type MountInventory } from './mountApi';

export interface MountInventoryInput {
  snapshot: ContainerList | null;
  active: boolean;
  enabled: boolean;
  onError: (original: unknown, failure: CoreError, sessionId: string) => void;
}
export interface MountInventoryState {
  inventory: MountInventory | null;
  error: CoreError | null;
  loading: boolean;
  stale: boolean;
  reload: () => void;
}
type View = Omit<MountInventoryState, 'reload'> & { key: string; settled: boolean };
const empty = (key = ''): View => ({ key, inventory: null, error: null, loading: false, stale: false, settled: false });

/** Keep mounted at app level: one lazy session-only cache shared across storage tabs. */
export function useMountInventory({ snapshot, active, enabled, onError }: MountInventoryInput): MountInventoryState {
  const ids = [...new Set(snapshot?.containers.map(item => item.fullId) ?? [])].sort();
  const key = JSON.stringify([snapshot?.sessionId, ids]);
  const allowed = !!snapshot && !snapshot.stale && enabled;
  const [view, setView] = useState<View>(() => empty());
  const [revision, setRevision] = useState(0);
  const viewRef = useRef(view);
  const inFlight = useRef<Promise<void> | null>(null);
  const mounted = useRef(true);
  const forceRefresh = useRef(false);
  const latest = useRef({ key, ids, snapshot, active, allowed, onError });
  latest.current = { key, ids, snapshot, active, allowed, onError };
  const update = (next: View) => { viewRef.current = next; if (mounted.current) setView(next); };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    let waiting = true;
    if (viewRef.current.key !== key) {
      const previous = viewRef.current.inventory?.sessionId === snapshot?.sessionId ? viewRef.current.inventory : null;
      update({ ...empty(key), inventory: previous, stale: previous !== null });
    }
    if (!allowed) {
      update({ ...viewRef.current, loading: false });
      return;
    }
    if (!active) return;
    async function collect() {
      if (inFlight.current) await inFlight.current;
      if (!waiting || !mounted.current || latest.current.key !== key || !latest.current.allowed || !latest.current.active) return;
      if (viewRef.current.key === key && viewRef.current.settled) return;
      const input = latest.current;
      const sessionId = input.snapshot!.sessionId;
      const prior = viewRef.current.inventory;
      const refresh = forceRefresh.current;
      forceRefresh.current = false;
      update({ key, inventory: prior, error: null, loading: true, stale: prior !== null, settled: false });
      const current = () => mounted.current && latest.current.key === key && latest.current.allowed;
      const work = (async () => {
        try {
          const response = await mountApi.getInventory(sessionId, refresh);
          if (!current()) return;
          const result = validateMountInventory(response, sessionId, input.ids);
          update({ key, inventory: result, error: null, loading: false, stale: false, settled: true });
        } catch (original) {
          const failure = coreError(original);
          const invalidates = connectionInvalidatingErrors.has(failure.code) || failure.code === 'NeedsValidation';
          if (mounted.current && latest.current.snapshot?.sessionId === sessionId && invalidates) latest.current.onError(original, failure, sessionId);
          if (!current()) return;
          update({ key, inventory: prior, error: failure, loading: false, stale: prior !== null, settled: true });
          if (!invalidates) latest.current.onError(original, failure, sessionId);
        }
      })();
      inFlight.current = work;
      await work;
      if (inFlight.current === work) inFlight.current = null;
    }
    void collect();
    return () => { waiting = false; };
  }, [key, allowed, active, revision]);

  const reload = useCallback(() => {
    const input = latest.current;
    if (!input.allowed || !input.active || inFlight.current) return;
    forceRefresh.current = true;
    update({ ...viewRef.current, stale: viewRef.current.inventory !== null, settled: false });
    setRevision(value => value + 1);
  }, []);
  const inventory = view.inventory?.sessionId === snapshot?.sessionId ? view.inventory : null;
  const sameKey = view.key === key;
  return { inventory, error: sameKey ? view.error : null, loading: sameKey && allowed && view.loading,
    stale: inventory !== null && (!sameKey || view.stale || !allowed), reload };
}
