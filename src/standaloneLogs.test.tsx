import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProjectLogs, useLogCollection } from './ProjectLogs';
import { useIncidentReview } from './useIncidentReview';
import { useStandaloneLogFeedback } from './useStandaloneLogFeedback';
import { observationApi, projectLogApi, standaloneLogApi, type LogScope, type ObservationEvent, type StandaloneLogPage } from './observationApi';
import { PreferencesProvider } from './preferences';

vi.mock('./observationApi', async original => ({ ...await original<typeof import('./observationApi')>(),
  observationApi: { available: vi.fn(() => true) },
  projectLogApi: { configure: vi.fn(), query: vi.fn(), retry: vi.fn(), stop: vi.fn() },
  standaloneLogApi: { configure: vi.fn(), query: vi.fn(), retry: vi.fn() },
}));
const fullId = 'a'.repeat(64), nextId = 'b'.repeat(64), at = '2026-09-16T01:00:00Z';
const event: ObservationEvent = { sequence: 1, fullId, name: 'same-name', composeProject: null, composeService: null, occurredAt: at, observedAt: at, kind: 'oom', detail: null };
const page = (): StandaloneLogPage => ({ sessionId: 'one', project: null, revision: 1, maxSequence: 2, totalRows: 2, offset: 0, droppedRows: 0, needsSelection: false, error: null, retainedFrom: at, retainedTo: at,
  sources: [fullId, nextId].map((id, index) => ({ sourceId: id, fullId: id, containerName: 'same-name', serviceName: null, selected: true, status: index ? 'following' : 'removed', error: null, droppedRows: 0 })),
  rows: [fullId, nextId].map((id, index) => ({ rowId: `r${index}`, sequence: index + 1, sourceId: id, fullId: id, serviceName: null, containerName: 'same-name', timestamp: index ? at : null, receivedAt: at, pipe: 'stdout', text: `line ${index}`, truncated: false })),
});
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => {
  vi.resetAllMocks(); vi.mocked(observationApi.available).mockReturnValue(true);
  vi.mocked(standaloneLogApi.configure).mockResolvedValue(page()); vi.mocked(standaloneLogApi.query).mockResolvedValue(page()); vi.mocked(standaloneLogApi.retry).mockResolvedValue(page());
  vi.mocked(projectLogApi.configure).mockResolvedValue({ ...page(), project: 'orders' }); vi.mocked(projectLogApi.stop).mockResolvedValue();
});
afterEach(() => vi.useRealTimers());
it('keeps one collection for recreated standalone scope objects and retries the standalone manager', async () => {
  const { result, rerender } = renderHook(({ scope }: { scope: LogScope }) => useLogCollection('one', scope, true, vi.fn()), { initialProps: { scope: { kind: 'standalone' } } });
  await waitFor(() => expect(result.current.page?.project).toBeNull());
  rerender({ scope: { kind: 'standalone' } }); rerender({ scope: { kind: 'standalone' } });
  await act(async () => { await result.current.retry(); });
  expect(standaloneLogApi.configure).toHaveBeenCalledExactlyOnceWith('one', null); expect(standaloneLogApi.retry).toHaveBeenCalledExactlyOnceWith('one');
  expect(projectLogApi.configure).not.toHaveBeenCalled(); expect(projectLogApi.stop).not.toHaveBeenCalled();
});
it('orders a pending standalone configure before stopping it and configuring a project', async () => {
  const pending = deferred<StandaloneLogPage>(); vi.mocked(standaloneLogApi.configure).mockReturnValue(pending.promise);
  const { result, rerender } = renderHook(({ scope }: { scope: LogScope }) => useLogCollection('one', scope, true, vi.fn()), { initialProps: { scope: { kind: 'standalone' } } });
  await waitFor(() => expect(standaloneLogApi.configure).toHaveBeenCalledOnce());
  rerender({ scope: { kind: 'project', name: 'orders' } }); expect(projectLogApi.configure).not.toHaveBeenCalled();
  await act(async () => pending.resolve(page()));
  await waitFor(() => expect(result.current.page?.project).toBe('orders'));
  expect(vi.mocked(projectLogApi.stop).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(projectLogApi.configure).mock.invocationCallOrder[0]!);
});
it('lets a reconnected session start without waiting for the old standalone request', async () => {
  const old = deferred<StandaloneLogPage>(); vi.mocked(standaloneLogApi.configure).mockReturnValueOnce(old.promise).mockResolvedValue({ ...page(), sessionId: 'two' });
  const { result, rerender } = renderHook(({ sessionId }) => useLogCollection(sessionId, { kind: 'standalone' }, true, vi.fn()), { initialProps: { sessionId: 'one' } });
  await waitFor(() => expect(standaloneLogApi.configure).toHaveBeenCalledOnce()); rerender({ sessionId: 'two' });
  await waitFor(() => expect(result.current.page?.sessionId).toBe('two')); await act(async () => old.resolve(page()));
  expect(result.current.page?.sessionId).toBe('two');
});
it('rejects a project page returned to the standalone collection', async () => {
  vi.mocked(standaloneLogApi.configure).mockResolvedValue({ ...page(), project: 'other' } as unknown as StandaloneLogPage);
  const { result } = renderHook(() => useLogCollection('one', { kind: 'standalone' }, true, vi.fn()));
  await waitFor(() => expect(result.current.error?.code).toBe('InvalidProjectLogsResponse')); expect(result.current.page).toBeNull();
});
it('queries retained standalone incident data by old ID and receive-time-compatible bounds without configuring', async () => {
  vi.mocked(standaloneLogApi.query).mockResolvedValue({ ...page(), rows: [page().rows[0]!] });
  const { result } = renderHook(() => useIncidentReview('one', null));
  act(() => result.current.select(event)); await waitFor(() => expect(result.current.state?.loading).toBe(false));
  expect(standaloneLogApi.query).toHaveBeenCalledExactlyOnceWith('one', expect.objectContaining({ sourceIds: [fullId], anchorTime: at, timeFrom: '2026-09-16T00:58:00.000Z', timeTo: '2026-09-16T01:02:00.000Z' }));
  expect(result.current.state?.page?.rows[0]?.timestamp).toBeNull();
  expect(standaloneLogApi.configure).not.toHaveBeenCalled(); expect(projectLogApi.query).not.toHaveBeenCalled();
});
it.each(['project', 'session', 'container'] as const)('rejects incident records with the wrong %s', async wrong => {
  vi.mocked(standaloneLogApi.query).mockResolvedValue({ ...page(), sessionId: wrong === 'session' ? 'other' : 'one', project: wrong === 'project' ? 'orders' : null,
    rows: [page().rows[wrong === 'container' ? 1 : 0]!] } as unknown as StandaloneLogPage);
  const { result } = renderHook(() => useIncidentReview('one', null)); act(() => result.current.select(event));
  await waitFor(() => expect(result.current.state?.error?.code).toBe('InvalidProjectLogsResponse')); expect(result.current.state?.page).toBeNull();
});
it('uses full IDs for same-name source filters and includes retained deletion metadata', async () => {
  vi.mocked(standaloneLogApi.query).mockImplementation(async (_session, query) => ({ ...page(), rows: page().rows.filter(row => !query.sourceIds.length || query.sourceIds.includes(row.fullId)) }));
  render(<PreferencesProvider initialPreferences={{ language: 'en', theme: 'light' }}><ProjectLogs sessionId="one" project={null} containers={[]} initialPage={page()} configure={vi.fn()} retry={vi.fn()} error={null} onError={vi.fn()} copy={vi.fn()} /></PreferencesProvider>);
  fireEvent.click(screen.getByText('Container filter'));
  const filter = within(document.querySelector<HTMLElement>('.project-service-filter')!);
  const old = filter.getByRole('checkbox', { name: `same-name · ${fullId.slice(0, 12)} · Container removed` });
  const replacement = filter.getByRole('checkbox', { name: `same-name · ${nextId.slice(0, 12)}` });
  expect(old).toBeChecked(); fireEvent.click(replacement);
  await waitFor(() => expect(standaloneLogApi.query).toHaveBeenLastCalledWith('one', expect.objectContaining({ sourceIds: [fullId] })));
});
it('restores separate standalone copy/clear feedback while preserving its original deadline', async () => {
  vi.useFakeTimers(); const writeText = vi.fn().mockResolvedValue(undefined); Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  const { result, rerender } = renderHook(({ viewKey }) => useStandaloneLogFeedback('one', viewKey), { initialProps: { viewKey: 'group' } });
  await act(async () => result.current.copy('group text', 'logs'));
  const group = result.current.message!; rerender({ viewKey: fullId }); expect(result.current.message).toBeNull();
  act(() => result.current.beginClear()()); expect(result.current.message?.key).toBe('logsCleared');
  rerender({ viewKey: 'group' }); expect(result.current.message?.key).toBe('copied'); expect(result.current.message?.highlightUntil).toBe(group.highlightUntil);
  await act(async () => vi.advanceTimersByTimeAsync(2_000)); expect(result.current.message?.highlighted).toBe(false);
});
it('discards pending standalone clipboard results after reconnect', async () => {
  const pending = deferred<void>(); Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockReturnValue(pending.promise) } });
  const { result, rerender } = renderHook(({ sessionId }) => useStandaloneLogFeedback(sessionId, 'group'), { initialProps: { sessionId: 'one' } });
  let copying!: Promise<void>; act(() => { copying = result.current.copy('old', 'logs'); }); rerender({ sessionId: 'two' });
  await act(async () => { pending.resolve(); await copying; }); expect(result.current.message).toBeNull();
});
