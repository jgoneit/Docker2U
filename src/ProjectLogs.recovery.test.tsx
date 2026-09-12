import { useRef } from 'react';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProjectLogs, createProjectLogViewCache, useProjectLogCollection } from './ProjectLogs';
import { observationApi, projectLogApi, type ProjectLogPage } from './observationApi';
import { PreferencesProvider } from './preferences';
import type { Container } from './api';

vi.mock('./observationApi', async importOriginal => ({ ...await importOriginal<typeof import('./observationApi')>(),
  observationApi: { available: vi.fn(() => true) },
  projectLogApi: { configure: vi.fn(), query: vi.fn(), retry: vi.fn(), stop: vi.fn() },
}));
const failure = { code: 'ObservationTransport', message: 'temporary collection failure' };
const container: Container = { handle: 'ha', fullId: 'a', shortId: 'a', name: 'web', composeProject: 'demo', composeService: 'web', state: 'running', health: null, image: 'web', ports: [], createdAt: '' };
const page = (sessionId = 'one', project = 'demo'): ProjectLogPage => ({ sessionId, project, revision: 1, maxSequence: 140, totalRows: 40, offset: 0, droppedRows: 0, needsSelection: false, error: null, retainedFrom: null, retainedTo: null,
  sources: [{ sourceId: 'a', fullId: 'a', containerName: 'web', serviceName: 'web', selected: true, status: 'following', error: null, droppedRows: 0 }],
  rows: Array.from({ length: 40 }, (_, index) => ({ rowId: `r${101 + index}`, sequence: 101 + index, sourceId: 'a', fullId: 'a', serviceName: 'web', containerName: 'web', timestamp: '2026-09-12T00:00:00.000Z', receivedAt: '2026-09-12T00:00:00.000Z', pipe: 'stdout', text: `needle ${101 + index}`, truncated: false })),
});
const failedPage = () => ({ ...page(), error: failure, rows: [], totalRows: 0 });
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
function Harness({ sessionId = 'one', project = 'demo', cache }: { sessionId?: string; project?: string; cache?: ReturnType<typeof createProjectLogViewCache> }) {
  const localCache = useRef(createProjectLogViewCache());
  const collection = useProjectLogCollection(sessionId, project, true, vi.fn());
  return <PreferencesProvider><ProjectLogs sessionId={sessionId} project={project} containers={[container]} initialPage={collection.page}
    configure={collection.configure} retry={collection.retry} retrying={collection.retrying} error={collection.error} onError={vi.fn()} copy={vi.fn()} viewCache={cache ?? localCache.current} /></PreferencesProvider>;
}
beforeEach(() => {
  vi.resetAllMocks(); vi.mocked(observationApi.available).mockReturnValue(true);
  vi.mocked(projectLogApi.configure).mockResolvedValue(page()); vi.mocked(projectLogApi.query).mockResolvedValue(page());
  vi.mocked(projectLogApi.retry).mockResolvedValue(page()); vi.mocked(projectLogApi.stop).mockResolvedValue(undefined);
  localStorage.setItem('docker2u.preferences.v1', JSON.stringify({ theme: 'dark', language: 'ko' }));
});
afterEach(() => vi.useRealTimers());

it('resumes an initially failed collection and starts display polling without reconfiguring its sources', async () => {
  const resuming = deferred<ProjectLogPage>();
  vi.mocked(projectLogApi.configure).mockResolvedValue(failedPage()); vi.mocked(projectLogApi.retry).mockReturnValue(resuming.promise);
  render(<Harness />);
  const resume = await screen.findByRole('button', { name: '수집 재개' });
  expect(projectLogApi.query).not.toHaveBeenCalled();
  fireEvent.click(resume); fireEvent.click(resume);
  expect(resume).toBeDisabled();
  await act(async () => resuming.resolve({ ...page(), rows: [], totalRows: 0, sources: page().sources.map(source => ({ ...source, status: 'starting' })) }));
  await screen.findByText('needle 140');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(projectLogApi.configure).toHaveBeenCalledExactlyOnceWith('one', 'demo', null);
  expect(projectLogApi.retry).toHaveBeenCalledExactlyOnceWith('one');
  expect(projectLogApi.query).toHaveBeenCalledWith('one', 'demo', expect.any(Object));
  expect(projectLogApi.stop).not.toHaveBeenCalled();
});

it('preserves a cached paused query, service filter, Clear floor, and anchor after collection recovery', async () => {
  const cache = createProjectLogViewCache(); cache.sessionId = 'one';
  cache.save(JSON.stringify(['demo', null]), { page: page(), keyword: 'needle', services: ['web'], paused: true, frozenSequence: 140,
    savedScroll: 55, anchorInset: 3, following: false, offset: 0, anchor: 'r103', delayed: false, afterSequence: 100 });
  vi.mocked(projectLogApi.configure).mockResolvedValue(failedPage());
  render(<Harness cache={cache} />);
  fireEvent.click(await screen.findByRole('button', { name: '수집 재개' }));
  await waitFor(() => expect(projectLogApi.query).toHaveBeenCalledWith('one', 'demo', expect.objectContaining({
    keyword: 'needle', sourceIds: ['a'], throughSequence: 140, afterSequence: 100, anchorRowId: 'r103', offset: 0,
  })));
  expect(screen.getByRole('searchbox')).toHaveValue('needle');
  expect(screen.getByRole('button', { name: '화면 재개' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('log')).toHaveProperty('scrollTop', 55);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(cache.read(JSON.stringify(['demo', null]))).toMatchObject({ afterSequence: 100, paused: true, keyword: 'needle', anchor: 'r103', services: ['web'] });
});

it.each(['session', 'project', 'embedded error'] as const)('rejects a retry response with %s without reporting recovery', async kind => {
  vi.mocked(projectLogApi.configure).mockResolvedValue(failedPage());
  vi.mocked(projectLogApi.retry).mockResolvedValue(kind === 'session' ? page('old') : kind === 'project' ? page('one', 'other') : failedPage());
  const onError = vi.fn();
  const { result } = renderHook(() => useProjectLogCollection('one', 'demo', true, onError));
  await waitFor(() => expect(result.current.error).toEqual(failure));
  await act(async () => { await expect(result.current.retry()).rejects.toMatchObject({ code: kind === 'embedded error' ? failure.code : 'InvalidProjectLogsResponse' }); });
  expect(result.current.page).toBeNull(); expect(result.current.retrying).toBe(false); expect(onError).toHaveBeenCalledTimes(2);
});

it('coalesces retry calls and accepts only source application queued after an active retry', async () => {
  const resuming = deferred<ProjectLogPage>(); vi.mocked(projectLogApi.retry).mockReturnValue(resuming.promise);
  const { result } = renderHook(() => useProjectLogCollection('one', 'demo', true, vi.fn()));
  await waitFor(() => expect(result.current.page).not.toBeNull());
  let first!: Promise<boolean>, duplicate!: Promise<boolean>, applying!: Promise<boolean>;
  act(() => { first = result.current.retry(); duplicate = result.current.retry(); });
  expect(first).toBe(duplicate);
  await act(async () => {});
  vi.mocked(projectLogApi.configure).mockResolvedValue({ ...page(), revision: 30 });
  act(() => { applying = result.current.configure(['latest-ha']); });
  expect(projectLogApi.configure).toHaveBeenCalledOnce();
  await act(async () => { resuming.resolve({ ...page(), revision: 20 }); expect(await first).toBe(false); expect(await applying).toBe(true); });
  expect(projectLogApi.retry).toHaveBeenCalledOnce(); expect(result.current.page?.revision).toBe(30);
  expect(projectLogApi.configure).toHaveBeenLastCalledWith('one', 'demo', ['latest-ha']);
  expect(result.current.retrying).toBe(false);
});

it('finishes the old-project retry before stopping it and ignores its failure after navigation', async () => {
  const resuming = deferred<ProjectLogPage>(); const onError = vi.fn(); const order: string[] = [];
  vi.mocked(projectLogApi.configure).mockImplementation(async (session, project) => { order.push(`configure:${project}`); return page(session, project); });
  vi.mocked(projectLogApi.retry).mockImplementation(() => { order.push('retry'); return resuming.promise; });
  vi.mocked(projectLogApi.stop).mockImplementation(async () => { order.push('stop'); });
  const { result, rerender } = renderHook(({ project }) => useProjectLogCollection('one', project, true, onError), { initialProps: { project: 'demo' } });
  await waitFor(() => expect(result.current.page).not.toBeNull());
  let retry!: Promise<boolean>;
  await act(async () => { retry = result.current.retry(); });
  rerender({ project: 'next' });
  expect(order).toEqual(['configure:demo', 'retry']);
  await act(async () => { resuming.reject(failure); expect(await retry).toBe(false); });
  await waitFor(() => expect(result.current.page?.project).toBe('next'));
  expect(order).toEqual(['configure:demo', 'retry', 'stop', 'configure:next']); expect(onError).not.toHaveBeenCalled();
});

it('starts a reconnected session even while the previous configure never settles and fences its late response and stop', async () => {
  const old = deferred<ProjectLogPage>();
  vi.mocked(projectLogApi.configure).mockImplementation((session, project) => session === 'one' ? old.promise : Promise.resolve(page(session, project)));
  const onError = vi.fn();
  const { result, rerender } = renderHook(({ session }) => useProjectLogCollection(session, 'demo', true, onError), { initialProps: { session: 'one' } });
  await waitFor(() => expect(projectLogApi.configure).toHaveBeenCalledOnce());
  rerender({ session: 'two' });
  await waitFor(() => expect(result.current.page?.sessionId).toBe('two'));
  expect(projectLogApi.stop).not.toHaveBeenCalled();
  await act(async () => old.resolve(failedPage()));
  await waitFor(() => expect(projectLogApi.stop).toHaveBeenCalledExactlyOnceWith('one'));
  expect(result.current.page?.sessionId).toBe('two'); expect(result.current.error).toBeNull(); expect(onError).not.toHaveBeenCalled();
});

it('discards a retry rejection once the session is disabled', async () => {
  const resuming = deferred<ProjectLogPage>(); vi.mocked(projectLogApi.retry).mockReturnValue(resuming.promise);
  const onError = vi.fn();
  const { result, rerender } = renderHook(({ enabled }) => useProjectLogCollection('one', 'demo', enabled, onError), { initialProps: { enabled: true } });
  await waitFor(() => expect(result.current.page).not.toBeNull());
  let retry!: Promise<boolean>;
  await act(async () => { retry = result.current.retry(); });
  rerender({ enabled: false });
  await act(async () => { resuming.reject(failure); expect(await retry).toBe(false); });
  expect(onError).not.toHaveBeenCalled(); expect(result.current.retrying).toBe(false);
});
