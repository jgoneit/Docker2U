import { connectionInvalidatingErrors } from './frontendSession';
import { useEffect, useRef, useState } from 'react';
import { api, coreError, type Container, type ContainerList, type ContainerStatsItem, type CoreError } from './api';

export type ResourceSample = ContainerStatsItem & { sampledAt: string; stale: boolean };
type Input = {
  snapshot: ContainerList | null; containers: Container[]; enabled: boolean;
  onError: (original: unknown, failure: CoreError, sessionId: string) => void;
};
export function useContainerStats({ snapshot, containers, enabled, onError }: Input) {
  const [foreground, setForeground] = useState(() => document.visibilityState !== 'hidden');
  const [view, setView] = useState<{ sessionId: string; generation: number; key: string; samples: Map<string, ResourceSample> }>({ sessionId: '', generation: 0, key: '', samples: new Map() });
  const [error, setError] = useState<{ sessionId: string; failure: CoreError } | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);
  const running = containers.filter(container => container.state === 'running');
  const key = JSON.stringify([snapshot?.sessionId, snapshot?.generation, running.map(item => [item.handle, item.fullId]).sort()]);
  const allowed = enabled && foreground && !!snapshot && !snapshot.stale;
  const latest = useRef({ key, allowed, snapshot, running, onError });
  latest.current = { key, allowed, snapshot, running, onError };
  useEffect(() => {
    const visibility = () => setForeground(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', visibility);
    return () => document.removeEventListener('visibilitychange', visibility);
  }, []);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const current = () => active && latest.current.key === key && latest.current.allowed;
    function collect() {
      if (!current()) return;
      if (inFlight.current) { void inFlight.current.then(() => { if (current()) collect(); }); return; }
      const input = latest.current;
      const list = input.snapshot!;
      if (!input.running.length) { setError(null); return; }
      const work = (async () => {
        try {
          const result = await api.getContainerStats(list.sessionId, list.generation, input.running.map(item => item.handle));
          if (!current()) return;
          const expected = new Map(input.running.map(item => [item.handle, item.fullId]));
          const seen = new Set<string>();
          if (result.sessionId !== list.sessionId || result.generation !== list.generation || !Number.isFinite(Date.parse(result.sampledAt))
            || result.items.length !== expected.size || result.items.some(item => {
              const invalid = expected.get(item.handle) !== item.fullId || seen.has(item.handle)
                || (item.available && (item.cpuPercent === null || !Number.isFinite(item.cpuPercent) || item.cpuPercent < 0
                  || typeof item.memoryUsage !== 'string' || !item.memoryUsage.includes(' / ')));
              seen.add(item.handle); return invalid;
            })) throw { code: 'InvalidStatsResponse', message: 'Statistics do not match the requested containers' };
          setView(previous => {
            const samples = previous.sessionId === list.sessionId ? new Map(previous.samples) : new Map<string, ResourceSample>();
            for (const item of result.items) {
              const prior = samples.get(item.fullId);
              // Only observed values enter the cache. An unavailable first reply
              // must not become an old sample when collection pauses or fails.
              if (item.available) samples.set(item.fullId, { ...item, sampledAt: result.sampledAt, stale: false });
              else if (prior?.available) samples.set(item.fullId, { ...prior, handle: item.handle, stale: true });
            }
            const validIds = new Set(list.containers.map(item => item.fullId));
            for (const id of samples.keys()) if (!validIds.has(id)) samples.delete(id);
            return { sessionId: list.sessionId, generation: list.generation, key, samples };
          });
          setError(result.error ? { sessionId: list.sessionId, failure: result.error } : null);
          if (result.error) input.onError(result.error, result.error, list.sessionId);
        } catch (original) {
          const failure = coreError(original);
          // A late same-session Engine failure still blocks new actions; view errors stay scoped.
          if (latest.current.snapshot?.sessionId === list.sessionId && connectionInvalidatingErrors.has(failure.code)) input.onError(original, failure, list.sessionId);
          if (!current()) return;
          setError({ sessionId: list.sessionId, failure });
          setView(previous => ({ ...previous, samples: new Map([...previous.samples].map(([id, sample]) => [id, { ...sample, stale: true }])) }));
          if (!connectionInvalidatingErrors.has(failure.code)) input.onError(original, failure, list.sessionId);
        }
      })();
      inFlight.current = work;
      void work.then(() => {
        if (inFlight.current === work) inFlight.current = null;
        if (current()) timer = setTimeout(collect, 5_000);
      });
    }
    collect();
    return () => { active = false; clearTimeout(timer); };
  }, [key, allowed]);
  function sampleFor(container: Container): ResourceSample | undefined {
    if (container.state !== 'running' || !snapshot || view.sessionId !== snapshot.sessionId) return undefined;
    const sample = view.samples.get(container.fullId);
    return sample ? { ...sample, stale: sample.stale || !allowed || view.generation !== snapshot.generation || view.key !== key } : undefined;
  }
  return { sampleFor, error: snapshot?.sessionId === error?.sessionId ? error?.failure ?? null : null };
}
