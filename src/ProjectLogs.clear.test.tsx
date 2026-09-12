import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Container } from './api';
import { createProjectLogViewCache, ProjectLogs } from './ProjectLogs';
import { observationApi, projectLogApi, type ProjectLogPage, type ProjectLogQuery, type ProjectLogRow } from './observationApi';
import { PreferencesProvider } from './preferences';

vi.mock('./observationApi', async original => ({ ...await original<typeof import('./observationApi')>(),
  observationApi: { available: vi.fn() },
  projectLogApi: { configure: vi.fn(), query: vi.fn(), retry: vi.fn(), stop: vi.fn() },
}));

const web: Container = { handle: 'ha', fullId: 'a'.repeat(64), shortId: 'a'.repeat(12), name: 'web', image: 'fixture', state: 'running', health: null, ports: [], composeProject: 'demo', composeService: 'web', createdAt: '' };
const worker = { ...web, handle: 'hb', fullId: 'b'.repeat(64), name: 'worker', composeService: 'worker' };
const containers = [web, worker];
const timestamp = '2026-09-12T00:00:00Z';
const row = (sequence: number, text: string, container = web): ProjectLogRow => ({ rowId: `r${sequence}`, sequence, text,
  sourceId: container.fullId, fullId: container.fullId, serviceName: container.composeService, containerName: container.name,
  timestamp, receivedAt: timestamp, pipe: 'stdout', truncated: false });
let retained: ProjectLogRow[];
const sources = containers.map(container => ({ sourceId: container.fullId, fullId: container.fullId, containerName: container.name,
  serviceName: container.composeService, selected: true, status: 'following' as const, error: null, droppedRows: 0 }));
function page(sessionId = 'one', query?: ProjectLogQuery): ProjectLogPage {
  const rows = retained.filter(item => (!query?.sourceIds.length || query.sourceIds.includes(item.sourceId))
    && (!query?.keyword || item.text.includes(query.keyword))
    && (query?.throughSequence == null || item.sequence <= query.throughSequence)
    && (query?.afterSequence == null || item.sequence > query.afterSequence));
  const offset = query?.offset ?? Math.max(0, rows.length - (query?.limit ?? rows.length));
  return { sessionId, project: 'demo', revision: 1, maxSequence: retained.at(-1)?.sequence ?? 0,
    rows: rows.slice(offset, offset + (query?.limit ?? rows.length)), totalRows: rows.length, offset,
    sources, droppedRows: 0, needsSelection: false, error: null, retainedFrom: rows[0]?.timestamp ?? null, retainedTo: rows.at(-1)?.timestamp ?? null };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
const query = vi.mocked(projectLogApi.query);
const advance = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const click = (name: string) => act(async () => { fireEvent.click(screen.getByRole('button', { name })); });
const clear = () => click('현재 로그 비우기');
const viewport = () => screen.getByRole('log');
const success = vi.fn(), begin = vi.fn(() => success), onError = vi.fn(), configure = vi.fn();
function mount() {
  const cache = createProjectLogViewCache();
  const view = (sessionId = 'one', fullId?: string) => <PreferencesProvider initialPreferences={{ theme: 'dark', language: 'ko' }}>
    <ProjectLogs sessionId={sessionId} project="demo" containers={containers} initialPage={page(sessionId)} fullId={fullId}
      viewCache={cache} configure={configure} error={null} onError={onError} copy={vi.fn().mockResolvedValue(undefined)} onClearStarted={begin} />
  </PreferencesProvider>;
  const rendered = render(view());
  return { ...rendered, cache, show: (sessionId = 'one', fullId?: string) => rendered.rerender(view(sessionId, fullId)) };
}

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(timestamp)); vi.resetAllMocks();
  retained = [row(10, 'old web'), row(11, 'old worker', worker)];
  vi.mocked(observationApi.available).mockReturnValue(true);
  query.mockImplementation(async (sessionId, _project, request) => page(sessionId, request));
  begin.mockReturnValue(success);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('clears through a fresh Core watermark, including rows accumulated while paused, then follows new output', async () => {
  mount(); await advance();
  await click('화면 일시정지');
  retained.push(row(40, 'collected while paused'), row(50, 'latest before clear'));
  const boundary = deferred<ProjectLogPage>();
  query.mockReturnValueOnce(boundary.promise);
  await clear();
  expect(query).toHaveBeenLastCalledWith('one', 'demo', { sourceIds: [], keyword: '', offset: null, limit: 1, throughSequence: null });
  expect(begin).toHaveBeenCalledOnce(); expect(success).not.toHaveBeenCalled();
  expect(viewport()).toHaveTextContent('old web');
  expect(screen.getByRole('button', { name: '화면 일시정지' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '최신 위치' })).toBeDisabled();
  await act(async () => boundary.resolve(page()));
  expect(viewport()).not.toHaveTextContent('old web');
  expect(viewport()).not.toHaveTextContent('collected while paused');
  expect(screen.getByText('이전 로그를 화면에서 비웠습니다. 새로 수집되는 로그가 여기에 표시됩니다.')).toBeVisible();
  expect(query).toHaveBeenLastCalledWith('one', 'demo', expect.objectContaining({ afterSequence: 50, throughSequence: null }));
  expect(success).toHaveBeenCalledOnce();
  expect(screen.getByRole('button', { name: '화면 일시정지' })).toBeEnabled();
  retained.push(row(51, 'new output'));
  await advance(500);
  expect(viewport()).toHaveTextContent('new output');
  expect(viewport()).not.toHaveTextContent('latest before clear');
  expect(retained).toHaveLength(5);
  expect(configure).not.toHaveBeenCalled(); expect(projectLogApi.stop).not.toHaveBeenCalled(); expect(projectLogApi.retry).not.toHaveBeenCalled();
});

it('discards a display response that was already pending when Clear captured a newer watermark', async () => {
  const pending = deferred<ProjectLogPage>();
  query.mockReturnValueOnce(pending.promise);
  mount(); await advance();
  const previous = page();
  retained.push(row(30, 'arrived during pending read'));
  await clear();
  expect(query).toHaveBeenLastCalledWith('one', 'demo', expect.objectContaining({ afterSequence: 30 }));
  expect(viewport()).not.toHaveTextContent('old web');
  await act(async () => pending.resolve(previous));
  expect(viewport()).not.toHaveTextContent('old web');
  expect(success).toHaveBeenCalledOnce();
  retained.push(row(31, 'new after pending'));
  await advance(500);
  expect(viewport()).toHaveTextContent('new after pending');
  expect(viewport()).not.toHaveTextContent('arrived during pending read');
});

it('keeps the clear floor scoped to its cached target across view controls and invalidates it for a new session', async () => {
  const resizeCallbacks: (() => void)[] = [];
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resizeCallbacks.push(callback); } observe() {} disconnect() {} });
  const { show, cache } = mount(); await advance();
  await clear();
  show('one', web.fullId); await advance();
  expect(viewport()).toHaveTextContent('old web');
  expect(query.mock.calls.at(-1)![2]).not.toHaveProperty('afterSequence');
  show(); await advance();
  expect(viewport()).not.toHaveTextContent('old web');
  const preservedCalls = query.mock.calls.length;
  await act(async () => fireEvent.click(screen.getByText('서비스 필터')));
  await act(async () => fireEvent.click(screen.getByRole('checkbox', { name: 'worker' })));
  await act(async () => fireEvent.change(screen.getByRole('searchbox', { name: '로그 키워드 검색' }), { target: { value: 'old' } }));
  expect(screen.getByRole('button', { name: '필터 초기화' })).toBeVisible();
  await click('필터 초기화');
  await click('화면 일시정지');
  await click('로그 확대');
  Object.defineProperty(viewport(), 'clientHeight', { configurable: true, value: 500 });
  await act(async () => resizeCallbacks.at(-1)!());
  await act(async () => fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' }));
  await click('최신 위치');
  expect(query.mock.calls.slice(preservedCalls).length).toBeGreaterThan(0);
  expect(query.mock.calls.slice(preservedCalls).every(call => call[2].afterSequence === 11)).toBe(true);
  expect(viewport()).not.toHaveTextContent('old web');
  expect(cache.views.get(JSON.stringify(['demo', null]))?.afterSequence).toBe(11);
  show('two'); await advance();
  expect(viewport()).toHaveTextContent('old web');
  expect(query).toHaveBeenLastCalledWith('two', 'demo', expect.not.objectContaining({ afterSequence: 11 }));
  expect(cache.views.get(JSON.stringify(['demo', null]))?.afterSequence).toBeNull();
});

it.each(['rejected', 'response error'] as const)('retains the visible page and withholds success feedback when the clear boundary has a %s', async failure => {
  mount(); await advance();
  const error = { code: 'TimedOut', message: 'Cannot establish the clear boundary' };
  if (failure === 'rejected') query.mockRejectedValueOnce(error);
  else query.mockResolvedValueOnce({ ...page(), error });
  await clear();
  expect(viewport()).toHaveTextContent('old web');
  expect(viewport()).toHaveTextContent('old worker');
  expect(onError).toHaveBeenCalledWith(error, expect.objectContaining({ code: 'TimedOut' }), 'one');
  expect(success).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: '화면 일시정지' })).toBeEnabled();
  expect(screen.getByRole('button', { name: '최신 위치' })).toBeEnabled();
  expect(screen.getByRole('button', { name: '현재 로그 비우기' })).toBeEnabled();
  await click('최신 위치');
  expect(query.mock.calls.at(-1)![2]).not.toHaveProperty('afterSequence');
});

it('times out a pending clear without stacking reads or accepting the late boundary', async () => {
  mount(); await advance();
  const boundary = deferred<ProjectLogPage>(); query.mockReturnValueOnce(boundary.promise);
  await clear();
  const calls = query.mock.calls.length;
  await advance(10_000);
  expect(query).toHaveBeenCalledTimes(calls);
  expect(viewport()).toHaveTextContent('old web');
  expect(screen.getByRole('button', { name: '화면 일시정지' })).toBeEnabled();
  expect(screen.getByRole('button', { name: '최신 위치' })).toBeEnabled();
  expect(screen.getByRole('button', { name: '로그 다시 조회' })).toBeVisible();
  await act(async () => boundary.resolve({ ...page(), maxSequence: 99 }));
  expect(success).not.toHaveBeenCalled();
  expect(viewport()).toHaveTextContent('old web');
  await click('로그 다시 조회');
  expect(query.mock.calls.at(-1)![2]).not.toHaveProperty('afterSequence');
});

it('discards a clear boundary after its target unmounts and does not save it into the next session', async () => {
  const { show, cache } = mount(); await advance();
  const boundary = deferred<ProjectLogPage>(); query.mockReturnValueOnce(boundary.promise);
  await clear();
  show('two', web.fullId); await advance();
  await act(async () => boundary.resolve(page()));
  expect(success).not.toHaveBeenCalled();
  expect(viewport()).toHaveTextContent('old web');
  expect(cache.sessionId).toBe('two');
  expect(cache.views.get(JSON.stringify(['demo', web.fullId]))?.afterSequence).toBeNull();
  expect(cache.views.has(JSON.stringify(['demo', null]))).toBe(false);
});
