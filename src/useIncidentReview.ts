import { useCallback, useEffect, useRef, useState } from 'react';
import { coreError, type CoreError } from './api';
import { projectLogApi, type ObservationEvent, type ObservationRead, type ProjectLogPage, type ProjectLogQuery, type ResourcePoint } from './observationApi';

export type IncidentTab = 'terminal' | 'diagnostics' | 'connectivity' | 'storage';
export type IncidentWindow = 1 | 2 | 5;
export const INCIDENT_PAGE_SIZE = 160;
const QUERY_TIMEOUT_MS = 10_000;
export interface IncidentReviewState {
  sessionId: string;
  event: ObservationEvent;
  windowMinutes: IncidentWindow;
  resourcePoints: ResourcePoint[];
  resourceTruncated: boolean;
  capturedAt: string;
  page: ProjectLogPage | null;
  throughSequence: number | null;
  loading: boolean;
  error: CoreError | null;
  logScroll: number;
}
export interface IncidentReview {
  state: IncidentReviewState | null;
  select: (event: ObservationEvent) => void;
  close: () => void;
  setWindow: (minutes: IncidentWindow) => void;
  refresh: () => void;
  page: (offset: number) => void;
  setLogScroll: (top: number) => void;
}
export function incidentWindow(event: ObservationEvent, minutes: IncidentWindow) {
  const anchor = Date.parse(event.occurredAt);
  return { timeFrom: new Date(anchor - minutes * 60_000).toISOString(), timeTo: new Date(anchor + minutes * 60_000).toISOString() };
}
function resourceSnapshot(observation: ObservationRead | null, event: ObservationEvent) {
  const anchor = Date.parse(event.occurredAt);
  return (observation?.resources ?? []).filter(point => point.fullId === event.fullId && Math.abs(Date.parse(point.sampledAt) - anchor) <= 5 * 60_000)
    .map(point => ({ ...point })).sort((a, b) => Date.parse(a.sampledAt) - Date.parse(b.sampledAt) || a.sequence - b.sequence);
}
export function nearestIncidentRow(page: ProjectLogPage, occurredAt: string) {
  const anchor = Date.parse(occurredAt);
  let nearest = 0, distance = Infinity;
  page.rows.forEach((row, index) => {
    const next = Math.abs(Date.parse(row.timestamp ?? row.receivedAt) - anchor);
    if (next < distance) { nearest = index; distance = next; }
  });
  return nearest;
}
/** Owned by App so an incident remains frozen while its current details are open. */
export function useIncidentReview(sessionId: string | null, observation: ObservationRead | null,
  onError?: (original: unknown, failure: CoreError, sessionId: string) => void): IncidentReview {
  const [state, setState] = useState<IncidentReviewState | null>(null);
  const current = useRef(state);
  const input = useRef({ sessionId, observation, onError }); input.current = { sessionId, observation, onError };
  const generation = useRef(0);
  const publish = useCallback((next: IncidentReviewState | null) => { current.current = next; setState(next); }, []);
  const close = useCallback(() => { ++generation.current; publish(null); }, [publish]);
  useEffect(() => { close(); return () => { ++generation.current; }; }, [sessionId, close]);
  const query = useCallback(async (selection: IncidentReviewState, anchor: boolean,
    direction?: 'previous' | 'next', retained = selection) => {
    const request = ++generation.current;
    // A refresh is tentative until the complete read succeeds. Its new
    // watermark and resource snapshot must not replace the frozen view early.
    publish({ ...retained, loading: true, error: null });
    let active = true;
    const valid = () => active && generation.current === request && input.current.sessionId === selection.sessionId;
    const read = async (position: Partial<ProjectLogQuery>) => {
      const result = await projectLogApi.query(selection.sessionId, selection.event.composeProject!, {
        sourceIds: [selection.event.fullId!], keyword: '', offset: null, limit: INCIDENT_PAGE_SIZE,
        throughSequence: selection.throughSequence, ...incidentWindow(selection.event, selection.windowMinutes), ...position,
      });
      if (!valid()) throw { code: 'IncidentQueryCancelled', message: 'The incident selection changed.' };
      if (result.sessionId !== selection.sessionId || result.project !== selection.event.composeProject
        || result.rows.some(row => row.fullId !== selection.event.fullId || row.sourceId !== selection.event.fullId)) {
        throw { code: 'InvalidProjectLogsResponse', message: 'Incident logs do not match the selected container and session.' };
      }
      return result;
    };
    const load = async () => {
      if (!direction || !selection.page?.rows.length) return read(anchor ? { anchorTime: selection.event.occurredAt } : {});
      const boundary = direction === 'next' ? selection.page.rows.at(-1)! : selection.page.rows[0]!;
      const anchored = await read({ anchorRowId: boundary.rowId, offset: 0 });
      if (anchored.anchorLost || anchored.rows[0]?.rowId !== boundary.rowId) {
        throw { code: 'IncidentLogAnchorLost', message: 'The page boundary was removed at the retention limit. Refresh the incident to continue.' };
      }
      if (direction === 'next') {
        // The shared boundary makes forward paging immune to earlier evictions.
        return anchored.rows.length === 1 ? anchored : { ...anchored, offset: anchored.offset + 1, rows: anchored.rows.slice(1) };
      }
      if (anchored.offset === 0) return anchored;
      const preceding = await read({ offset: Math.max(0, anchored.offset - (INCIDENT_PAGE_SIZE - 1)) });
      const boundaryIndex = preceding.rows.findIndex(row => row.rowId === boundary.rowId);
      if (boundaryIndex < 0 || (boundaryIndex === 0 && preceding.offset > 0)) {
        throw { code: 'IncidentLogPageChanged', message: 'Retained logs changed while paging. Refresh the incident to continue.' };
      }
      // Pruning between reads may shorten this page, but the validated boundary
      // guarantees a contiguous preceding interval without skipping retained rows.
      return boundaryIndex === 0 ? preceding : { ...preceding, rows: preceding.rows.slice(0, boundaryIndex) };
    };
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        load(),
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject({ code: 'IncidentQueryTimeout', message: 'The incident log query timed out.' }), QUERY_TIMEOUT_MS); }),
      ]);
      if (!valid()) return;
      if (retained !== selection && result.error) throw result.error;
      publish({ ...selection, page: result, throughSequence: selection.throughSequence ?? result.maxSequence,
        loading: false, error: result.error, logScroll: anchor ? nearestIncidentRow(result, selection.event.occurredAt) * 24 : 0 });
    } catch (original) {
      if (!valid()) return;
      const failure = coreError(original);
      const keptPage = failure.code === 'IncidentLogAnchorLost' && retained.page ? { ...retained.page, anchorLost: true } : retained.page;
      publish({ ...retained, page: keptPage, loading: false, error: failure, logScroll: current.current?.logScroll ?? retained.logScroll });
      input.current.onError?.(original, failure, selection.sessionId);
    } finally { active = false; clearTimeout(timeout); }
  }, [publish]);
  const select = useCallback((event: ObservationEvent) => {
    const { sessionId: activeSession, observation: latest } = input.current;
    if (!activeSession || !event.fullId || !event.composeProject || !Number.isFinite(Date.parse(event.occurredAt))) return;
    const matching = latest?.sessionId === activeSession ? latest : null;
    void query({ sessionId: activeSession, event: { ...event }, windowMinutes: 2,
      resourcePoints: resourceSnapshot(matching, event), resourceTruncated: matching?.resourceTruncated ?? false,
      capturedAt: new Date().toISOString(), page: null, throughSequence: null, loading: true, error: null, logScroll: 0 }, true);
  }, [query]);
  const setWindow = useCallback((minutes: IncidentWindow) => {
    const selected = current.current;
    if (!selected || selected.sessionId !== input.current.sessionId || minutes === selected.windowMinutes) return;
    void query({ ...selected, windowMinutes: minutes, page: null, logScroll: 0 }, true);
  }, [query]);
  const refresh = useCallback(() => {
    const selected = current.current;
    if (!selected || selected.sessionId !== input.current.sessionId) return;
    const latest = input.current.observation?.sessionId === selected.sessionId ? input.current.observation : null;
    void query({ ...selected, resourcePoints: resourceSnapshot(latest, selected.event), resourceTruncated: latest?.resourceTruncated ?? false,
      capturedAt: new Date().toISOString(), throughSequence: null }, true, undefined, selected);
  }, [query]);
  const page = useCallback((offset: number) => {
    const selected = current.current;
    if (!selected?.page || selected.loading || selected.sessionId !== input.current.sessionId) return;
    void query(selected, false, offset < selected.page.offset ? 'previous' : 'next');
  }, [query]);
  const setLogScroll = useCallback((top: number) => {
    const selected = current.current;
    if (selected && selected.sessionId === input.current.sessionId && top !== selected.logScroll) publish({ ...selected, logScroll: top });
  }, [publish]);
  return { state: state?.sessionId === sessionId ? state : null, select, close, setWindow, refresh, page, setLogScroll };
}
