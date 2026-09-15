import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProjectLogs, PROJECT_LOG_VIEW_PAGE_BUDGET, createProjectLogViewCache, useLogCollection } from './ProjectLogs';
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
it('keeps a removed full-ID filter and its label across Compose navigation and repeated polls', async () => {
  vi.useFakeTimers();
  const cache = createProjectLogViewCache(); let catalogRetired = false;
  const currentPage = () => ({ ...page(), sources: page().sources.filter(source => !catalogRetired || source.fullId !== fullId) });
  vi.mocked(standaloneLogApi.query).mockImplementation(async (_session, query) => {
    const rows = page().rows.filter(row => (!query.sourceIds.length || query.sourceIds.includes(row.fullId)) && row.text.includes(query.keyword));
    return { ...currentPage(), rows, totalRows: rows.length };
  });
  vi.mocked(projectLogApi.query).mockResolvedValue({ ...page(), project: 'orders', rows: [], sources: [], totalRows: 0 });
  const view = (project: string | null = null) => <PreferencesProvider initialPreferences={{ language: 'en', theme: 'light' }}><ProjectLogs viewCache={cache} sessionId="one" project={project} containers={[]} initialPage={{ ...currentPage(), project }} configure={vi.fn()} retry={vi.fn()} error={null} onError={vi.fn()} copy={vi.fn()} /></PreferencesProvider>;
  const rendered = render(view()); await act(async () => {});
  fireEvent.click(screen.getByText('Container filter'));
  const filter = () => within(document.querySelector<HTMLElement>('.project-service-filter')!);
  fireEvent.click(filter().getByRole('checkbox', { name: `same-name · ${nextId.slice(0, 12)}` })); await act(async () => {});
  expect(screen.getByText('line 0')).toBeInTheDocument(); expect(screen.queryByText('line 1')).not.toBeInTheDocument();

  rendered.rerender(view('orders')); await act(async () => {});
  // Core drops the old source catalog on stop/configure, while its retained rows survive.
  catalogRetired = true; vi.mocked(standaloneLogApi.query).mockClear();
  rendered.rerender(view()); await act(async () => {});
  await act(async () => vi.advanceTimersByTimeAsync(500));
  await act(async () => vi.advanceTimersByTimeAsync(500));
  expect(vi.mocked(standaloneLogApi.query).mock.calls.length).toBeGreaterThanOrEqual(3);
  expect(vi.mocked(standaloneLogApi.query).mock.calls.every(([, query]) => query.sourceIds.length === 1 && query.sourceIds[0] === fullId)).toBe(true);
  fireEvent.click(screen.getByText('Container filter (1)'));
  expect(filter().getByRole('checkbox', { name: `same-name · ${fullId.slice(0, 12)} · Container removed` })).toBeChecked();
  expect(filter().getByRole('checkbox', { name: `same-name · ${nextId.slice(0, 12)}` })).not.toBeChecked();
  expect(screen.getByText('line 0')).toBeInTheDocument(); expect(screen.queryByText('line 1')).not.toBeInTheDocument();
  const archived = cache.read(JSON.stringify([null, null]))!.page!.sources.find(source => source.fullId === fullId);
  expect(archived).toMatchObject({ containerName: 'same-name', selected: false, status: 'removed', error: null });

  // The merged descriptor lives in the existing cached page, including when a keyword has no rows.
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'absent' } }); await act(async () => {});
  expect(filter().getByRole('checkbox', { name: `same-name · ${fullId.slice(0, 12)} · Container removed` })).toBeChecked();
  rendered.unmount();
  render(view()); await act(async () => {});
  await act(async () => vi.advanceTimersByTimeAsync(500));
  await act(async () => vi.advanceTimersByTimeAsync(500));
  fireEvent.click(screen.getByText('Container filter (1)'));
  expect(filter().getByRole('checkbox', { name: `same-name · ${fullId.slice(0, 12)} · Container removed` })).toBeChecked();
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } }); await act(async () => {});
  expect(screen.getByText('line 0')).toBeInTheDocument(); expect(screen.queryByText('line 1')).not.toBeInTheDocument();
});
it('recovers an evicted standalone filter page by full ID and reconstructs its removed source label from retained rows', async () => {
  vi.useFakeTimers();
  const cache = createProjectLogViewCache(); cache.sessionId = 'one';
  cache.save(JSON.stringify([null, null]), { page: null, keyword: '', services: [fullId], paused: false, frozenSequence: null,
    savedScroll: 0, anchorInset: 0, following: true, offset: null, anchor: null, delayed: false });
  vi.mocked(standaloneLogApi.query).mockImplementation(async (_session, query) => {
    const rows = page().rows.filter(row => !query.sourceIds.length || query.sourceIds.includes(row.fullId));
    return { ...page(), sources: [page().sources[1]!], rows, totalRows: rows.length };
  });
  render(<PreferencesProvider initialPreferences={{ language: 'en', theme: 'light' }}><ProjectLogs viewCache={cache} sessionId="one" project={null} containers={[]} initialPage={{ ...page(), sources: [page().sources[1]!] }} configure={vi.fn()} retry={vi.fn()} error={null} onError={vi.fn()} copy={vi.fn()} /></PreferencesProvider>);
  await act(async () => {}); await act(async () => vi.advanceTimersByTimeAsync(1_000));
  expect(standaloneLogApi.query).toHaveBeenLastCalledWith('one', expect.objectContaining({ sourceIds: [fullId] }));
  fireEvent.click(screen.getByText('Container filter (1)'));
  expect(screen.getByRole('checkbox', { name: `same-name · ${fullId.slice(0, 12)} · Container removed` })).toBeChecked();
  expect(screen.getByText('line 0')).toBeInTheDocument(); expect(screen.queryByText('line 1')).not.toBeInTheDocument();
});
it('offers deleted IDs from an unfiltered retained page after the active source catalog is empty', async () => {
  vi.useFakeTimers();
  const cache = createProjectLogViewCache();
  vi.mocked(standaloneLogApi.query).mockImplementation(async (_session, query) => {
    const rows = page().rows.filter(row => !query.sourceIds.length || query.sourceIds.includes(row.fullId));
    return { ...page(), sources: [], rows, totalRows: rows.length };
  });
  render(<PreferencesProvider initialPreferences={{ language: 'en', theme: 'light' }}><ProjectLogs viewCache={cache} sessionId="one" project={null} containers={[]} initialPage={{ ...page(), sources: [] }} configure={vi.fn()} retry={vi.fn()} error={null} onError={vi.fn()} copy={vi.fn()} /></PreferencesProvider>);
  await act(async () => {}); await act(async () => vi.advanceTimersByTimeAsync(1_000));
  fireEvent.click(screen.getByText('Container filter'));
  expect(screen.getByRole('checkbox', { name: `same-name · ${fullId.slice(0, 12)} · Container removed` })).toBeChecked();
  fireEvent.click(screen.getByRole('checkbox', { name: `same-name · ${nextId.slice(0, 12)} · Container removed` }));
  await act(async () => {}); await act(async () => vi.advanceTimersByTimeAsync(1_000));
  expect(standaloneLogApi.query).toHaveBeenLastCalledWith('one', expect.objectContaining({ sourceIds: [fullId] }));
  expect(screen.getByRole('checkbox', { name: `same-name · ${fullId.slice(0, 12)} · Container removed` })).toBeChecked();
  expect(screen.getByText('line 0')).toBeInTheDocument(); expect(screen.queryByText('line 1')).not.toBeInTheDocument();
  const other = screen.getByRole('checkbox', { name: `same-name · ${nextId.slice(0, 12)} · Container removed` });
  expect(other).not.toBeChecked();
  fireEvent.click(other); await act(async () => {}); await act(async () => vi.advanceTimersByTimeAsync(500));
  expect(standaloneLogApi.query).toHaveBeenLastCalledWith('one', expect.objectContaining({ sourceIds: [fullId, nextId] }));
  expect(other).toBeChecked(); expect(screen.getByText('line 0')).toBeInTheDocument(); expect(screen.getByText('line 1')).toBeInTheDocument();
  expect(cache.read(JSON.stringify([null, null]))!.page!.sources.map(source => source.fullId)).toEqual([fullId, nextId]);
});
it('drops oversized archived descriptors at the page budget while preserving the selected full-ID query', async () => {
  vi.useFakeTimers();
  const cache = createProjectLogViewCache(); cache.sessionId = 'one';
  cache.save(JSON.stringify([null, null]), { page: page(), keyword: '', services: [fullId], paused: false, frozenSequence: null,
    savedScroll: 0, anchorInset: 0, following: true, offset: null, anchor: null, delayed: false });
  vi.mocked(standaloneLogApi.query).mockResolvedValueOnce({ ...page(), rows: [page().rows[0]!], totalRows: 1,
    sources: [{ ...page().sources[0]!, serviceName: 'x'.repeat(PROJECT_LOG_VIEW_PAGE_BUDGET / 2) }, page().sources[1]!] })
    .mockResolvedValue({ ...page(), rows: [], totalRows: 0, sources: [page().sources[1]!] });
  render(<PreferencesProvider initialPreferences={{ language: 'en', theme: 'light' }}><ProjectLogs viewCache={cache} sessionId="one" project={null} containers={[]} initialPage={page()} configure={vi.fn()} retry={vi.fn()} error={null} onError={vi.fn()} copy={vi.fn()} /></PreferencesProvider>);
  await act(async () => {});
  expect(cache.read(JSON.stringify([null, null]))!.page).toBeNull();
  await act(async () => vi.advanceTimersByTimeAsync(500));
  await act(async () => vi.advanceTimersByTimeAsync(500));
  const retained = cache.read(JSON.stringify([null, null]))!.page!;
  expect(retained.sources.some(source => source.fullId === fullId)).toBe(false);
  expect(cache.retainedPageBytes).toBeGreaterThan(0); expect(cache.retainedPageBytes).toBeLessThanOrEqual(PROJECT_LOG_VIEW_PAGE_BUDGET);
  expect(vi.mocked(standaloneLogApi.query).mock.calls.every(([, query]) => query.sourceIds.length === 1 && query.sourceIds[0] === fullId)).toBe(true);
  fireEvent.click(screen.getByText('Container filter (1)'));
  expect(screen.getByRole('checkbox', { name: `${fullId.slice(0, 12)} · Container removed` })).toBeChecked();
  expect(screen.queryByText('line 1')).not.toBeInTheDocument();
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
