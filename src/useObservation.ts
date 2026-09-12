import { useCallback, useEffect, useRef, useState } from 'react';
import { coreError, type Container, type ContainerList, type CoreError } from './api';
import { observationApi, type ObservationRead, type ResourcePoint } from './observationApi';
import type { ProjectFilter } from './projects';
import type { ResourceSample } from './useContainerStats';

export function mergeObservation(previous: ObservationRead | null, next: ObservationRead, now = Date.now()): ObservationRead {
  const same = previous?.sessionId === next.sessionId;
  const since = now - 30 * 60_000;
  const resources = new Map((same ? previous.resources : []).map(item => [item.sequence, item]));
  const events = new Map((same ? previous.events : []).map(item => [item.sequence, item]));
  for (const item of next.resources) resources.set(item.sequence, item);
  for (const item of next.events) events.set(item.sequence, item);
  const perSource = new Map<string, number>();
  const points = [...resources.values()].filter(item => Date.parse(item.sampledAt) >= since).sort((a, b) => b.sequence - a.sequence)
    .filter(item => { const count = (perSource.get(item.fullId) ?? 0) + 1; perSource.set(item.fullId, count); return count <= 360; }).slice(0, 100_000).reverse();
  return { ...next, resources: points, events: [...events.values()].filter(item => Date.parse(item.observedAt) >= since).sort((a, b) => a.sequence - b.sequence).slice(-10_000) };
}
export function formatBytes(value: number | null) {
  if (value === null || !Number.isFinite(value)) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index++; }
  return `${value.toFixed(index ? 1 : 0)} ${units[index]}`;
}
export function pointSample(point: ResourcePoint, container: Container, now = Date.now()): ResourceSample {
  return { handle: container.handle, fullId: container.fullId, cpuPercent: point.cpuPercent,
    memoryUsage: `${formatBytes(point.memoryUsageBytes)} / ${formatBytes(point.memoryLimitBytes)}`,
    memoryPercent: point.memoryUsageBytes !== null && point.memoryLimitBytes ? point.memoryUsageBytes / point.memoryLimitBytes * 100 : null,
    available: point.available, sampledAt: point.sampledAt, stale: !point.available || now - Date.parse(point.sampledAt) > 15_000 };
}
/** Core owns collection; this timer only reads already collected observations. */
export function useObservation({ sessionId, scope, enabled, onInventory, onError }: {
  sessionId: string | null; scope: ProjectFilter; enabled: boolean;
  onInventory: (snapshot: ContainerList) => void;
  onError: (error: unknown, failure: CoreError, sessionId: string) => void;
}) {
  const [view, setView] = useState<ObservationRead | null>(null);
  const [error, setError] = useState<CoreError | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [retryingEvents, setRetryingEvents] = useState(false);
  const [active, setActive] = useState(false);
  const latest = useRef({ sessionId, onInventory, onError }); latest.current = { sessionId, onInventory, onError };
  const cursor = useRef(0);
  const refresh = useRef<() => Promise<void>>(async () => {});
  const scopeKey = JSON.stringify(scope);
  useEffect(() => {
    if (!enabled || !sessionId || !observationApi.available()) { setActive(false); return; }
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight: Promise<void> | null = null;
    let started = false;
    cursor.current = 0;
    const accept = (result: ObservationRead) => {
      if (!live || latest.current.sessionId !== sessionId) return;
      if (result.sessionId !== sessionId) throw { code: 'InvalidObservationResponse', message: 'Observation does not match the current session.' };
      if (result.sequence < cursor.current) return;
      cursor.current = result.sequence;
      setView(previous => mergeObservation(previous, result));
      setActive(true); setError(null);
      if (result.inventory) latest.current.onInventory(result.inventory);
      for (const failure of [result.inventoryError, result.statsError, result.eventError]) if (failure) latest.current.onError(failure, failure, sessionId);
    };
    async function read() {
      if (!live) return;
      if (inFlight) return inFlight;
      clearTimeout(timer);
      inFlight = (async () => {
        try {
          const result = started ? await observationApi.read(sessionId!, cursor.current) : await observationApi.configure(sessionId!, JSON.parse(scopeKey) as ProjectFilter);
          started = true; accept(result);
        } catch (original) {
          if (!live) return;
          const failure = coreError(original); setError(failure);
          latest.current.onError(original, failure, sessionId!);
        } finally {
          inFlight = null;
          if (live) { setRestoring(false); if (document.visibilityState !== 'hidden') timer = setTimeout(() => void read(), 1_000); }
        }
      })();
      return inFlight;
    }
    refresh.current = read;
    function visibility() {
      if (document.visibilityState === 'hidden') { clearTimeout(timer); return; }
      setRestoring(true); void read();
    }
    document.addEventListener('visibilitychange', visibility);
    void read();
    return () => { live = false; clearTimeout(timer); document.removeEventListener('visibilitychange', visibility); };
  }, [sessionId, enabled, scopeKey]);
  const current = view?.sessionId === sessionId ? view : null;
  const samples = new Map<string, ResourcePoint>();
  for (const item of current?.resources ?? []) samples.set(item.fullId, item);
  const sampleFor = (container: Container) => {
    const sample = samples.get(container.fullId);
    return sample && container.state === 'running' ? pointSample(sample, container) : undefined;
  };
  const readNow = useCallback(() => refresh.current(), []);
  const retryEvents = useCallback(async () => {
    const input = latest.current; if (!input.sessionId) return;
    setRetryingEvents(true);
    try {
      const result = await observationApi.retryEvents(input.sessionId);
      if (latest.current.sessionId !== input.sessionId || result.sequence < cursor.current) return;
      cursor.current = result.sequence;
      setView(previous => mergeObservation(previous, result));
      if (result.inventory) input.onInventory(result.inventory);
    } catch (original) { input.onError(original, coreError(original), input.sessionId); }
    finally { setRetryingEvents(false); }
  }, []);
  return { view: current, active, error, restoring, sampleFor, readNow, retryEvents, retryingEvents };
}
