import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mergeObservation, useObservation } from './useObservation';
import { ObservationHistory, ResourceChart, resourceSegments } from './ObservationHistory';
import { ProjectLogs, createProjectLogViewCache, logRowsText, useProjectLogCollection, PROJECT_LOG_VIEW_PAGE_BUDGET } from './ProjectLogs';
import { observationApi, projectLogApi, type ObservationRead, type ResourcePoint, type ProjectLogPage } from './observationApi';
import { PreferencesProvider } from './preferences';
import type { Container } from './api';

vi.mock('./observationApi', async importOriginal => ({ ...await importOriginal<typeof import('./observationApi')>(),
  observationApi: { available: vi.fn(() => true), configure: vi.fn(), read: vi.fn(), hold: vi.fn(), release: vi.fn() },
  projectLogApi: { configure: vi.fn(), query: vi.fn(), retry: vi.fn(), stop: vi.fn() },
}));
const now = Date.parse('2026-09-12T00:00:00Z');
const point = (sequence: number, offset = sequence * 5000): ResourcePoint => ({ sequence, fullId: 'a', sampledAt: new Date(now + offset).toISOString(), cpuPercent: 150, memoryUsageBytes: 64 * 1024 * 1024, memoryLimitBytes: 1024 * 1024 * 1024, available: true });
const read = (sequence = 1): ObservationRead => ({ sessionId: 'one', sequence, scope: { kind: 'all' }, inventory: null,
  resources: [point(sequence)], events: [], resourceTruncated: false, eventTruncated: false, inventoryError: null, statsError: null, eventError: null, eventStatus: 'following' });
const container: Container = { handle: 'ha', fullId: 'a', shortId: 'a', name: 'web-1', composeProject: 'demo', composeService: 'web', state: 'running', health: 'healthy', healthConfigured: true, image: 'web', ports: [], createdAt: '' };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
const page = (count = 2): ProjectLogPage => ({ sessionId: 'one', project: 'demo', revision: count, maxSequence: count, totalRows: count, offset: 0, droppedRows: 0, needsSelection: false, error: null, retainedFrom: new Date(now).toISOString(), retainedTo: new Date(now + 1000).toISOString(),
  sources: [{ sourceId: 'a', fullId: 'a', containerName: 'web-1', serviceName: 'web', selected: true, status: 'following', error: null, droppedRows: 0 }],
  rows: Array.from({ length: count }, (_, index) => ({ rowId: `r${index}`, sequence: index + 1, sourceId: 'a', fullId: 'a', serviceName: 'web', containerName: 'web-1', timestamp: '2026-09-12T00:00:00.123456789Z', receivedAt: new Date(now).toISOString(), pipe: 'stdout', text: `line ${index}`, truncated: false })),
});
beforeEach(() => { vi.resetAllMocks(); vi.mocked(observationApi.available).mockReturnValue(true); vi.mocked(observationApi.configure).mockResolvedValue(read()); vi.mocked(observationApi.read).mockResolvedValue(read(2)); vi.mocked(projectLogApi.query).mockResolvedValue(page()); localStorage.setItem('docker2u.preferences.v1', JSON.stringify({ theme: 'dark', language: 'ko' })); });
afterEach(() => { vi.useRealTimers(); Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); });

describe('Core observation view', () => {
  it('deduplicates deltas, bounds each source and removes older and previous-session samples', () => {
    const many = { ...read(400), resources: Array.from({ length: 400 }, (_, i) => point(i, -i * 1000)) };
    const merged = mergeObservation(null, many, now);
    expect(merged.resources).toHaveLength(360);
    expect(mergeObservation(merged, many, now).resources).toHaveLength(360);
    expect(mergeObservation(merged, { ...read(), sessionId: 'other' }, now).resources).toHaveLength(1);
    expect(mergeObservation(merged, { ...read(), resources: [] }, now + 31 * 60_000).resources).toHaveLength(0);
  });
  it('shows gaps for unavailable and unobserved intervals and supports CPU above 100%', () => {
    const points = [point(1, 0), point(2, 5000), { ...point(3, 10000), available: false }, point(4, 15000), point(5, 50000)];
    expect(resourceSegments(points, item => item.cpuPercent).map(part => part.length)).toEqual([2, 1, 1]);
    render(<PreferencesProvider><ResourceChart points={points} metric="cpu" /></PreferencesProvider>);
    expect(screen.getByText('0–150%')).toBeVisible();
  });
  it('suspends only display reads while hidden, then applies new Core inventory before restoring actions', async () => {
    vi.useFakeTimers();
    const onInventory = vi.fn();
    const input = { sessionId: 'one', scope: { kind: 'all' } as const, enabled: true, onInventory, onError: vi.fn() };
    const { result } = renderHook(() => useObservation(input));
    await act(async () => { await Promise.resolve(); });
    expect(observationApi.configure).toHaveBeenCalledOnce();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(observationApi.read).not.toHaveBeenCalled();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(observationApi.configure).toHaveBeenCalledOnce();
    expect(observationApi.read).toHaveBeenCalledWith('one', 1);
    expect(result.current.restoring).toBe(false);
  });
});

describe('combined logs', () => {
  it('copies timestamps with nanosecond precision and source identity', () => {
    expect(logRowsText(page().rows)).toContain('2026-09-12T00:00:00.123456789Z\tweb\tweb-1\tline 0');
  });
  it('sends literal keyword filters and freezes the view without stopping collection', async () => {
    const configure = vi.fn();
    render(<PreferencesProvider><ProjectLogs copy={vi.fn().mockResolvedValue(undefined)} sessionId="one" project="demo" containers={[container]} initialPage={page()} retry={vi.fn().mockResolvedValue(true)} configure={configure} error={null} onError={vi.fn()} /></PreferencesProvider>);
    await waitFor(() => expect(projectLogApi.query).toHaveBeenCalled());
    fireEvent.change(screen.getByRole('searchbox', { name: '로그 키워드 검색' }), { target: { value: 'Error[DB]' } });
    await waitFor(() => expect(projectLogApi.query).toHaveBeenLastCalledWith('one', 'demo', expect.objectContaining({ keyword: 'Error[DB]', sourceIds: [] })));
    fireEvent.click(screen.getByRole('button', { name: '화면 일시정지' }));
    expect(screen.getByText('화면이 고정되었습니다. 로그 수집은 계속됩니다.')).toBeVisible();
    expect(configure).not.toHaveBeenCalled(); expect(projectLogApi.stop).not.toHaveBeenCalled();
  });
  it('requires explicit source selection above 64 and never configures an arbitrary subset', async () => {
    const sources = Array.from({ length: 65 }, (_, i) => ({ ...page().sources[0]!, sourceId: `id${i}`, fullId: `id${i}`, containerName: `web-${i}`, selected: false }));
    const initial = { ...page(0), sources, needsSelection: true };
    vi.mocked(projectLogApi.query).mockResolvedValue(initial);
    const configure = vi.fn().mockResolvedValue(true);
    render(<PreferencesProvider><ProjectLogs copy={vi.fn().mockResolvedValue(undefined)} sessionId="one" project="demo" containers={sources.map(source => ({ ...container, fullId: source.fullId, handle: `h-${source.fullId}` }))} initialPage={initial} retry={vi.fn().mockResolvedValue(true)} configure={configure} error={null} onError={vi.fn()} /></PreferencesProvider>);
    const checks = within(screen.getByRole('group', { name: '로그 수집 대상 선택' })).getAllByRole('checkbox');
    for (const checkbox of checks.slice(0, 64)) fireEvent.click(checkbox);
    expect(checks[64]).toBeDisabled(); expect(configure).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '수집 대상 적용' }));
    await waitFor(() => expect(configure).toHaveBeenCalledOnce());
    expect(configure.mock.calls[0]![0]).toHaveLength(64);
  });
  it('renders only the loaded window for a 100,000-row log buffer', async () => {
    const large = { ...page(160), totalRows: 100_000, offset: 99_840 };
    vi.mocked(projectLogApi.query).mockResolvedValue(large);
    const { container: root } = render(<PreferencesProvider><ProjectLogs copy={vi.fn().mockResolvedValue(undefined)} sessionId="one" project="demo" containers={[container]} initialPage={large} retry={vi.fn().mockResolvedValue(true)} configure={vi.fn()} error={null} onError={vi.fn()} /></PreferencesProvider>);
    expect(root.querySelectorAll('.project-log-row')).toHaveLength(160);
    expect(root.querySelector('.project-log-spacer')).toHaveStyle({ height: '2600000px' });
  });
});

it('uses the latest-page offset and copies only its displayed window', async () => {
  const latest = { ...page(40), totalRows: 5000, offset: 4960 };
  vi.mocked(projectLogApi.query).mockResolvedValue(latest);
  const clipboard = vi.fn().mockResolvedValue(undefined);
  const { container: root } = render(<PreferencesProvider><ProjectLogs copy={clipboard} sessionId="one" project="demo" containers={[container]} initialPage={latest} retry={vi.fn().mockResolvedValue(true)} configure={vi.fn()} error={null} onError={vi.fn()} /></PreferencesProvider>);
  expect(latest.offset + latest.rows.length).toBe(latest.totalRows);
  expect(root.querySelector('.project-log-window')).toHaveStyle({ top: `${4960 * 26}px` });
  fireEvent.click(screen.getByRole('button', { name: '현재 표시 구간 복사' }));
  await waitFor(() => expect(clipboard).toHaveBeenCalledWith(logRowsText(latest.rows), 'logs'));
  expect(clipboard.mock.calls[0]![0].split('\n')).toHaveLength(40);
});

it('keeps old samples in graphs but hides stale current values and pages a 10,000-event history', () => {
  vi.useFakeTimers(); vi.setSystemTime(now + 30_000);
  const events = Array.from({ length: 10_000 }, (_, index) => ({ sequence: index + 1, fullId: 'a', name: 'web-1', composeProject: 'demo', composeService: 'web', kind: 'start', occurredAt: new Date(now).toISOString(), observedAt: new Date(now).toISOString(), detail: null }));
  const value = { ...read(), resources: [point(1, 0)], events };
  const { container: root } = render(<PreferencesProvider><ObservationHistory observation={value} containers={[container]} /></PreferencesProvider>);
  expect(root.querySelectorAll('.history-events li')).toHaveLength(200);
  expect(root.querySelector('.history-service')).toHaveTextContent('CPU —');
  fireEvent.click(screen.getByRole('button', { name: '이전 기록' }));
  expect(root.querySelectorAll('.history-events li')).toHaveLength(200);
  fireEvent.click(root.querySelector('.history-service')!);
  expect(screen.getByText('0–150%')).toBeVisible();
});

it('expands resource history directly below its named row and closes the previous item', () => {
  const worker = { ...container, fullId: 'b', handle: 'hb', name: 'worker-1', composeService: 'worker' };
  const value = { ...read(), resources: [point(1), { ...point(2), fullId: 'b', cpuPercent: 230 }] };
  render(<PreferencesProvider><ObservationHistory observation={value} containers={[container, worker]} /></PreferencesProvider>);
  const webButton = screen.getByRole('button', { name: /^web\s*web-1/ });
  const workerButton = screen.getByRole('button', { name: /^worker\s*worker-1/ });
  fireEvent.click(webButton);
  const webPanel = screen.getByRole('region', { name: /^web\s*web-1/ });
  expect(webButton).toHaveAttribute('aria-controls', webPanel.id);
  expect(webButton.nextElementSibling).toBe(webPanel);
  expect(within(webPanel).getByText('0–150%')).toBeVisible();
  expect(screen.getAllByRole('img')).toHaveLength(2);
  fireEvent.click(workerButton);
  expect(webPanel).not.toBeVisible();
  expect(webButton).toHaveAttribute('aria-expanded', 'false');
  const workerPanel = screen.getByRole('region', { name: /^worker\s*worker-1/ });
  expect(workerButton.nextElementSibling).toBe(workerPanel);
  expect(within(workerPanel).getByText('0–230%')).toBeVisible();
  expect(screen.getAllByRole('img')).toHaveLength(2);
  fireEvent.click(workerButton);
  expect(workerButton).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByRole('region', { name: /^(web|worker)/ })).not.toBeInTheDocument();
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
});

it('keeps the expanded history across handle refresh but does not attach it to a recreated name', () => {
  const view = (items: Container[]) => <PreferencesProvider><ObservationHistory observation={read()} containers={items} /></PreferencesProvider>;
  const { rerender } = render(view([container]));
  fireEvent.click(screen.getByRole('button', { name: /^web\s*web-1/ }));
  rerender(view([{ ...container, handle: 'new-handle' }]));
  expect(screen.getByRole('region', { name: /^web\s*web-1/ })).toBeVisible();
  rerender(view([{ ...container, handle: 'recreated-handle', fullId: 'different-id' }]));
  expect(screen.getByRole('button', { name: /^web\s*web-1/ })).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByRole('region', { name: /^(web|worker)/ })).not.toBeInTheDocument();
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
});

it('keeps the frozen scroll position when expanding and closing a paused log view', async () => {
  render(<PreferencesProvider><ProjectLogs copy={vi.fn().mockResolvedValue(undefined)} sessionId="one" project="demo" containers={[container]} initialPage={page()} retry={vi.fn().mockResolvedValue(true)} configure={vi.fn()} error={null} onError={vi.fn()} /></PreferencesProvider>);
  await waitFor(() => expect(projectLogApi.query).toHaveBeenCalled());
  const viewport = screen.getByRole('log', { name: '통합 로그' }); viewport.scrollTop = 1234;
  fireEvent.click(screen.getByRole('button', { name: '화면 일시정지' }));
  fireEvent.click(screen.getByRole('button', { name: '로그 확대' }));
  expect(screen.getByRole('log', { name: '통합 로그' }).scrollTop).toBe(1234);
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  expect(screen.getByRole('log', { name: '통합 로그' }).scrollTop).toBe(1234);
});

it('anchors a historical row when a late log shifts its sorted index', async () => {
  const previous = { ...page(40), totalRows: 200, offset: 100 };
  const shifted = { ...previous, offset: 101, totalRows: 201 };
  vi.mocked(projectLogApi.query).mockResolvedValueOnce(previous).mockResolvedValue(shifted);
  render(<PreferencesProvider><ProjectLogs copy={vi.fn().mockResolvedValue(undefined)} sessionId="one" project="demo" containers={[container]} initialPage={previous} retry={vi.fn().mockResolvedValue(true)} configure={vi.fn()} error={null} onError={vi.fn()} /></PreferencesProvider>);
  await waitFor(() => expect(projectLogApi.query).toHaveBeenCalledOnce());
  const viewport = screen.getByRole('log', { name: '통합 로그' });
  Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 260 });
  Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 5200 });
  // Deliver the geometry change before the separate user scroll.
  fireEvent.scroll(viewport);
  viewport.scrollTop = 105 * 26 + 7;
  fireEvent.scroll(viewport);
  await waitFor(() => expect(projectLogApi.query).toHaveBeenLastCalledWith('one', 'demo', expect.objectContaining({ anchorRowId: 'r5' })));
  await waitFor(() => expect(viewport.scrollTop).toBe(106 * 26 + 7));
});


it('keeps removed and recreated same-name lifecycle sources visibly distinct by ID', () => {
  const identity = { name: 'web-1', composeProject: 'demo', composeService: 'web', occurredAt: new Date(now).toISOString(), observedAt: new Date(now).toISOString(), detail: null };
  const events = [{ ...identity, sequence: 1, fullId: 'a'.repeat(64), kind: 'destroy' }, { ...identity, sequence: 2, fullId: 'b'.repeat(64), kind: 'create' }];
  const { container: root } = render(<PreferencesProvider><ObservationHistory observation={{ ...read(), scope: { kind: 'project', name: 'demo' }, events }} containers={[]} /></PreferencesProvider>);
  const rows = root.querySelectorAll('.history-events li');
  expect(rows).toHaveLength(2);
  for (const row of rows) { expect(within(row as HTMLElement).getByText('web')).toBeVisible(); expect(within(row as HTMLElement).getByText('web-1')).toBeVisible(); }
  expect(within(rows[0] as HTMLElement).getByText('bbbbbbbbbbbb')).toHaveAttribute('title', 'b'.repeat(64));
  expect(within(rows[1] as HTMLElement).getByText('aaaaaaaaaaaa')).toHaveAttribute('title', 'a'.repeat(64));
});

it('splits resource lines across backwards wall-clock adjustments', () => {
  const points = [point(1, 0), point(2, 5000), point(3, -2000), point(4, 3000)];
  expect(resourceSegments(points, item => item.cpuPercent).map(segment => segment.map(item => item.sequence))).toEqual([[1, 2], [3, 4]]);
});

it('keeps both sides of a backwards clock adjustment inside the chart time axis', () => {
  const points = [point(1, 0), point(2, 5000), point(3, -2000), point(4, 3000)];
  const { container: root } = render(<PreferencesProvider><ResourceChart points={points} metric="cpu" /></PreferencesProvider>);
  const lines = [...root.querySelectorAll('polyline')];
  expect(lines).toHaveLength(2);
  const coordinates = lines.flatMap(line => line.getAttribute('points')!.split(' ').map(pair => Number(pair.split(',')[0])));
  expect(Math.min(...coordinates)).toBe(8);
  expect(Math.max(...coordinates)).toBe(592);
});


it('loads a larger window and keeps the latest row visible when the log viewport grows', async () => {
  let resize: ResizeObserverCallback | undefined;
  const observer = { observe: vi.fn(), disconnect: vi.fn(), unobserve: vi.fn() };
  vi.stubGlobal('ResizeObserver', class { constructor(callback: ResizeObserverCallback) { resize = callback; } observe = observer.observe; disconnect = observer.disconnect; unobserve = observer.unobserve; });
  try {
    const latest = { ...page(160), totalRows: 5000, offset: 4840, maxSequence: 5000 };
    vi.mocked(projectLogApi.query).mockResolvedValue(latest);
    const { unmount } = render(<PreferencesProvider><ProjectLogs copy={vi.fn().mockResolvedValue(undefined)} sessionId="one" project="demo" containers={[container]} initialPage={latest} retry={vi.fn().mockResolvedValue(true)} configure={vi.fn()} error={null} onError={vi.fn()} /></PreferencesProvider>);
    const viewport = screen.getByRole('log', { name: '통합 로그' });
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 130 });
    await act(async () => resize!([], observer));
    await waitFor(() => expect(projectLogApi.query).toHaveBeenLastCalledWith('one', 'demo', expect.objectContaining({ limit: 40, offset: null })));
    expect(viewport.scrollTop).toBe(5000 * 26 - 130);
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 1300 });
    await act(async () => resize!([], observer));
    await waitFor(() => expect(projectLogApi.query).toHaveBeenLastCalledWith('one', 'demo', expect.objectContaining({ limit: 74, offset: null })));
    expect(viewport.scrollTop).toBe(5000 * 26 - 1300);
    unmount();
    expect(observer.disconnect).toHaveBeenCalledOnce();
  } finally { vi.unstubAllGlobals(); }
});


it('keeps a paused scroll position when a hidden tab reports zero scroll offset', async () => {
  const initial = page();
  const view = (visible: boolean) => <PreferencesProvider><ProjectLogs copy={vi.fn().mockResolvedValue(undefined)} sessionId="one" project="demo" containers={[container]} initialPage={initial} retry={vi.fn().mockResolvedValue(true)} configure={vi.fn()} error={null} visible={visible} onError={vi.fn()} /></PreferencesProvider>;
  const { rerender } = render(view(true));
  await waitFor(() => expect(projectLogApi.query).toHaveBeenCalled());
  const viewport = screen.getByRole('log', { name: '통합 로그' });
  let hidden = false, scrollTop = 1234;
  Object.defineProperty(viewport, 'scrollTop', { configurable: true, get: () => hidden ? 0 : scrollTop, set: value => { scrollTop = hidden ? 0 : value; } });
  fireEvent.click(screen.getByRole('button', { name: '화면 일시정지' }));
  hidden = true; rerender(view(false));
  hidden = false; rerender(view(true));
  expect(viewport.scrollTop).toBe(1234);
});


describe('project log empty states', () => {
  const view = (initial: ProjectLogPage | null, fullId?: string) =>
    <PreferencesProvider><ProjectLogs copy={vi.fn().mockResolvedValue(undefined)} sessionId="one" project="demo" containers={[container]} initialPage={initial} fullId={fullId} retry={vi.fn().mockResolvedValue(true)} configure={vi.fn()} error={null} onError={vi.fn()} /></PreferencesProvider>;

  it('shows initial loading separately from a quiet connected source', async () => {
    const { rerender } = render(view(null));
    expect(screen.getByRole('status')).toHaveTextContent('기존 로그를 불러오고 있습니다');
    expect(projectLogApi.query).not.toHaveBeenCalled();
    vi.mocked(projectLogApi.query).mockResolvedValue(page(0));
    rerender(view(page(0)));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('아직 수신한 로그가 없습니다'));
    expect(screen.getByText(/컨테이너별 최근 최대 300행/)).toBeVisible();
  });

  it.each([
    ['starting', true, null, '기존 로그를 불러오고 있습니다'],
    ['idle', false, null, '로그 수집 대상을 선택하세요'],
    ['error', true, { code: 'ReadFailed', message: 'stream unavailable' }, '로그를 가져오지 못했습니다'],
  ] as const)('distinguishes %s from an empty successful collection', async (status, selected, error, message) => {
    const initial = { ...page(0), sources: [{ ...page(0).sources[0]!, status, selected, error }] };
    vi.mocked(projectLogApi.query).mockResolvedValue(initial);
    render(view(initial));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(message));
    expect(screen.queryByText(/아직 수신한 로그가 없습니다/)).not.toBeInTheDocument();
  });

  it('clears an empty keyword filter without restarting collection', async () => {
    vi.mocked(projectLogApi.query).mockImplementation(async (_session, _project, query) => query?.keyword ? page(0) : page());
    render(view(page()));
    fireEvent.change(screen.getByRole('searchbox', { name: '로그 키워드 검색' }), { target: { value: 'missing' } });
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('현재 필터에 맞는 로그가 없습니다'));
    fireEvent.click(screen.getByRole('button', { name: '필터 초기화' }));
    await waitFor(() => expect(screen.getByText('line 0')).toBeVisible());
    expect(screen.getByRole('searchbox')).toHaveValue('');
    expect(projectLogApi.stop).not.toHaveBeenCalled();
    expect(projectLogApi.configure).not.toHaveBeenCalled();
  });

  it('uses only the selected container when showing errors and source counts', async () => {
    const initial: ProjectLogPage = { ...page(0), sources: [...page(0).sources, { ...page(0).sources[0]!, fullId: 'b', sourceId: 'b', status: 'error', error: { code: 'ReadFailed', message: 'other source failed' } }] };
    vi.mocked(projectLogApi.query).mockResolvedValue(initial);
    render(view(initial, 'a'));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('아직 수신한 로그가 없습니다'));
    expect(screen.getByText(/선택한 1개 \/ 전체 1개/)).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows the dates of historical log coverage instead of only time of day', () => {
    const initial = { ...page(), retainedFrom: '2026-09-02T09:07:06.986616542Z', retainedTo: '2026-09-08T13:00:54.829851593Z' };
    vi.mocked(projectLogApi.query).mockResolvedValue(initial);
    render(view(initial));
    expect(screen.getByText('보관 구간 (UTC): 2026-09-02 09:07:06 – 2026-09-08 13:00:54')).toBeVisible();
  });
});

describe('project log view continuity', () => {
  it('keeps an oversized page out of the cache without evicting smaller recent pages', () => {
    const cache = createProjectLogViewCache();
    const state = { page: page(), keyword: 'retained', services: null, paused: true, frozenSequence: 2, savedScroll: 7, anchorInset: 7, following: false, offset: 0, anchor: 'r0', delayed: false };
    cache.save('small', state);
    const previousBytes = cache.retainedPageBytes;
    cache.save('oversized', { ...state, page: { ...page(100), rows: page(100).rows.map(row => ({ ...row, text: 'x'.repeat(64 * 1024) })) } });
    expect(cache.views.get('small')!.page).toBe(state.page);
    expect(cache.views.get('oversized')!.page).toBeNull();
    expect(cache.views.get('oversized')!.keyword).toBe('retained');
    expect(cache.views.get('oversized')!.anchor).toBe('r0');
    expect(cache.retainedPageBytes).toBe(previousBytes);
  });

  it('keeps a restored missing-service filter empty instead of querying all rows into view', async () => {
    const cache = createProjectLogViewCache(); cache.sessionId = 'one';
    cache.save(JSON.stringify(['demo', null]), { page: null, keyword: '', services: ['removed-service'], paused: false, frozenSequence: null, savedScroll: 0, anchorInset: 0, following: true, offset: null, anchor: null, delayed: false });
    render(<PreferencesProvider><ProjectLogs copy={vi.fn().mockResolvedValue(undefined)} viewCache={cache} sessionId="one" project="demo" containers={[container]} initialPage={page()} retry={vi.fn().mockResolvedValue(true)} configure={vi.fn()} error={null} onError={vi.fn()} /></PreferencesProvider>);
    await waitFor(() => expect(projectLogApi.query).toHaveBeenCalled());
    expect(screen.queryByText('line 0')).not.toBeInTheDocument();
    expect(screen.getByText('현재 필터에 맞는 로그가 없습니다.')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '필터 초기화' }));
    await waitFor(() => expect(screen.getByText('line 0')).toBeVisible());
  });

  it('bounds cached long log pages while retaining settings and requerying an evicted view', async () => {
    const cache = createProjectLogViewCache();
    vi.mocked(projectLogApi.query).mockImplementation(async (_session, project, query) => ({ ...page(2), project, rows: page(2).rows.map(row => ({ ...row, fullId: query.sourceIds[0] ?? 'a', text: 'x'.repeat(64 * 1024) })) }));
    const view = (fullId: string) => <PreferencesProvider><ProjectLogs copy={vi.fn().mockResolvedValue(undefined)} viewCache={cache} sessionId="one" project="demo" containers={[container]} initialPage={page()} fullId={fullId} retry={vi.fn().mockResolvedValue(true)} configure={vi.fn()} error={null} onError={vi.fn()} /></PreferencesProvider>;
    const { rerender } = render(view('container-0'));
    await act(async () => {});
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'keep this filter' } });
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: '화면 일시정지' }));
    for (let index = 1; index < 40; index++) { rerender(view(`container-${index}`)); await act(async () => {}); }
    expect(cache.views.size).toBe(40);
    expect(cache.retainedPageBytes).toBeLessThanOrEqual(PROJECT_LOG_VIEW_PAGE_BUDGET);
    const evicted = cache.views.get(JSON.stringify(['demo', 'container-0']))!;
    expect(evicted.page).toBeNull();
    expect(evicted.keyword).toBe('keep this filter');
    expect(evicted.paused).toBe(true);
    expect(evicted.frozenSequence).toBe(2);
    expect(cache.views.get(JSON.stringify(['demo', 'container-39']))!.page?.rows).toHaveLength(2);
    const pending = deferred<ProjectLogPage>();
    vi.mocked(projectLogApi.query).mockReturnValue(pending.promise);
    rerender(view('container-0'));
    expect(screen.getByRole('searchbox')).toHaveValue('keep this filter');
    expect(screen.getByRole('button', { name: '화면 재개' })).toHaveAttribute('aria-pressed', 'true');
    expect(document.querySelectorAll('.project-log-row')).toHaveLength(0);
    expect(projectLogApi.query).toHaveBeenLastCalledWith('one', 'demo', expect.objectContaining({ sourceIds: ['container-0'], keyword: 'keep this filter', throughSequence: 2 }));
  });

  it('restores filters, frozen sequence, historical anchor and page by target after unmount', async () => {
    const cache = createProjectLogViewCache();
    const retained = { ...page(40), totalRows: 200, offset: 100, maxSequence: 250,
      sources: [...page().sources, { ...page().sources[0]!, fullId: 'b', sourceId: 'b', serviceName: 'worker', containerName: 'worker-1' }] };
    vi.mocked(projectLogApi.query).mockResolvedValue(retained);
    const view = (fullId?: string, initialPage: ProjectLogPage | null = retained) => <PreferencesProvider><ProjectLogs copy={vi.fn().mockResolvedValue(undefined)} viewCache={cache} sessionId="one" project="demo" containers={[container]} initialPage={initialPage} fullId={fullId} retry={vi.fn().mockResolvedValue(true)} configure={vi.fn()} error={null} onError={vi.fn()} /></PreferencesProvider>;
    let mounted = render(view());
    await waitFor(() => expect(projectLogApi.query).toHaveBeenCalledOnce());
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Error[DB]' } });
    fireEvent.click(screen.getByText('서비스 필터'));
    fireEvent.click(screen.getByRole('checkbox', { name: 'worker' }));
    await waitFor(() => expect(projectLogApi.query).toHaveBeenLastCalledWith('one', 'demo', expect.objectContaining({ keyword: 'Error[DB]', sourceIds: ['a'] })));
    const viewport = screen.getByRole('log');
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 260 });
    Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 5200 });
    fireEvent.scroll(viewport);
    viewport.scrollTop = 115 * 26 + 7;
    fireEvent.scroll(viewport);
    fireEvent.click(screen.getByRole('button', { name: '화면 일시정지' }));
    mounted.unmount();
    mounted = render(view('b'));
    expect(screen.getByRole('searchbox')).toHaveValue('');
    expect(screen.getByRole('button', { name: '화면 일시정지' })).toHaveAttribute('aria-pressed', 'false');
    mounted.unmount();
    const pending = deferred<ProjectLogPage>();
    vi.mocked(projectLogApi.query).mockReturnValue(pending.promise);
    mounted = render(view(undefined, { ...page(0), sources: page().sources.map(source => ({ ...source, status: 'starting' })) }));
    expect(screen.getByRole('searchbox')).toHaveValue('Error[DB]');
    expect(screen.getByRole('button', { name: '화면 재개' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('line 15')).toBeVisible();
    expect(screen.getByRole('log').scrollTop).toBe(115 * 26 + 7);
    await waitFor(() => expect(projectLogApi.query).toHaveBeenLastCalledWith('one', 'demo', expect.objectContaining({ keyword: 'Error[DB]', sourceIds: ['a'], throughSequence: 250, anchorRowId: 'r15', offset: 95 })));
    expect(projectLogApi.configure).not.toHaveBeenCalled();
    expect(projectLogApi.stop).not.toHaveBeenCalled();
    mounted.unmount();
  });

  it('invalidates cached views on session changes and ignores the previous session response', async () => {
    const cache = createProjectLogViewCache(), oldRead = deferred<ProjectLogPage>();
    vi.mocked(projectLogApi.query).mockReturnValue(oldRead.promise);
    const view = (sessionId: string, initialPage: ProjectLogPage | null) => <PreferencesProvider><ProjectLogs copy={vi.fn().mockResolvedValue(undefined)} viewCache={cache} sessionId={sessionId} project="demo" containers={[container]} initialPage={initialPage} retry={vi.fn().mockResolvedValue(true)} configure={vi.fn()} error={null} onError={vi.fn()} /></PreferencesProvider>;
    const { rerender } = render(view('one', page()));
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'old filter' } });
    fireEvent.click(screen.getByRole('button', { name: '화면 일시정지' }));
    rerender(view('two', null));
    expect(screen.getByRole('searchbox')).toHaveValue('');
    expect(screen.getByRole('button', { name: '화면 일시정지' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByText('line 0')).not.toBeInTheDocument();
    await act(async () => oldRead.resolve(page()));
    expect(screen.queryByText('line 0')).not.toBeInTheDocument();
    expect(cache.sessionId).toBe('two');
    cache.clear();
    expect(cache.views.size).toBe(0);
    rerender(view('one', null));
    expect(screen.getByRole('searchbox')).toHaveValue('');
    expect(screen.queryByText('line 0')).not.toBeInTheDocument();
  });

  it('does not replace successful rows with initial or queried startup placeholders', async () => {
    vi.useFakeTimers();
    const starting = { ...page(0), sources: page().sources.map(source => ({ ...source, status: 'starting' as const })) };
    vi.mocked(projectLogApi.query).mockResolvedValueOnce(page()).mockResolvedValueOnce(starting).mockResolvedValue(page(0));
    const view = (initial: ProjectLogPage) => <PreferencesProvider><ProjectLogs copy={vi.fn().mockResolvedValue(undefined)} sessionId="one" project="demo" containers={[container]} initialPage={initial} retry={vi.fn().mockResolvedValue(true)} configure={vi.fn()} error={null} onError={vi.fn()} /></PreferencesProvider>;
    const { rerender } = render(view(page()));
    await act(async () => {});
    rerender(view(starting));
    expect(screen.getByText('line 0')).toBeVisible();
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(screen.getByText('line 0')).toBeVisible();
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(screen.queryByText('line 0')).not.toBeInTheDocument();
    expect(screen.getByText(/아직 수신한 로그가 없습니다/)).toBeVisible();
  });
});

describe('project log query deadlines', () => {
  it('distinguishes a delayed initial query from a confirmed empty stream', async () => {
    vi.useFakeTimers();
    const pending = deferred<ProjectLogPage>();
    vi.mocked(projectLogApi.query).mockReturnValue(pending.promise);
    render(<PreferencesProvider><ProjectLogs copy={vi.fn().mockResolvedValue(undefined)} sessionId="one" project="demo" containers={[container]} initialPage={page(0)} retry={vi.fn().mockResolvedValue(true)} configure={vi.fn()} error={null} onError={vi.fn()} /></PreferencesProvider>);
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(screen.getByRole('status')).toHaveTextContent('로그 조회 응답이 지연되고 있습니다');
    expect(screen.queryByText(/아직 수신한 로그가 없습니다/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '로그 다시 조회' })).toBeVisible();
  });

  it('preserves existing rows after ten seconds, requires manual retry, and discards the late response', async () => {
    vi.useFakeTimers();
    const oldRead = deferred<ProjectLogPage>(), newRead = deferred<ProjectLogPage>();
    vi.mocked(projectLogApi.query).mockReturnValueOnce(oldRead.promise).mockReturnValueOnce(newRead.promise);
    render(<PreferencesProvider><ProjectLogs copy={vi.fn().mockResolvedValue(undefined)} sessionId="one" project="demo" containers={[container]} initialPage={page()} retry={vi.fn().mockResolvedValue(true)} configure={vi.fn()} error={null} onError={vi.fn()} /></PreferencesProvider>);
    await act(async () => vi.advanceTimersByTimeAsync(9_999));
    expect(screen.queryByRole('button', { name: '로그 다시 조회' })).not.toBeInTheDocument();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(screen.getByText('로그 갱신이 지연되어 마지막 표시 구간을 유지하고 있습니다.')).toBeVisible();
    expect(screen.getByText('line 0')).toBeVisible();
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(projectLogApi.query).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: '로그 다시 조회' }));
    expect(projectLogApi.query).toHaveBeenCalledTimes(2);
    await act(async () => newRead.resolve({ ...page(), rows: page().rows.map(row => ({ ...row, text: 'new result ' + row.rowId })) }));
    expect(screen.getByText('new result r0')).toBeVisible();
    await act(async () => oldRead.resolve(page()));
    expect(screen.queryByText('line 0')).not.toBeInTheDocument();
    expect(screen.getByText('new result r0')).toBeVisible();
  });

  it('queues changed filters behind an active query instead of issuing duplicate reads', async () => {
    const oldRead = deferred<ProjectLogPage>(), nextRead = deferred<ProjectLogPage>();
    vi.mocked(projectLogApi.query).mockReturnValueOnce(oldRead.promise).mockReturnValueOnce(nextRead.promise);
    render(<PreferencesProvider><ProjectLogs copy={vi.fn().mockResolvedValue(undefined)} sessionId="one" project="demo" containers={[container]} initialPage={page()} retry={vi.fn().mockResolvedValue(true)} configure={vi.fn()} error={null} onError={vi.fn()} /></PreferencesProvider>);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'latest filter' } });
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(projectLogApi.query).toHaveBeenCalledOnce();
    await act(async () => oldRead.resolve({ ...page(), rows: [{ ...page().rows[0]!, text: 'obsolete result' }] }));
    expect(screen.queryByText('obsolete result')).not.toBeInTheDocument();
    expect(projectLogApi.query).toHaveBeenCalledTimes(2);
    expect(projectLogApi.query).toHaveBeenLastCalledWith('one', 'demo', expect.objectContaining({ keyword: 'latest filter' }));
    await act(async () => nextRead.resolve(page(0)));
    expect(screen.getByText('현재 필터에 맞는 로그가 없습니다.')).toBeVisible();
  });

  it('does not report a quiet stream as a delayed query', async () => {
    vi.useFakeTimers();
    vi.mocked(projectLogApi.query).mockResolvedValue(page(0));
    render(<PreferencesProvider><ProjectLogs copy={vi.fn().mockResolvedValue(undefined)} sessionId="one" project="demo" containers={[container]} initialPage={page(0)} retry={vi.fn().mockResolvedValue(true)} configure={vi.fn()} error={null} onError={vi.fn()} /></PreferencesProvider>);
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(vi.mocked(projectLogApi.query).mock.calls.length).toBeGreaterThan(10);
    expect(screen.queryByRole('button', { name: '로그 다시 조회' })).not.toBeInTheDocument();
    expect(screen.getByText(/아직 수신한 로그가 없습니다/)).toBeVisible();
  });
});

describe('project log source choices', () => {
  it('keeps per-source status collapsed until the summary is opened', async () => {
    render(<PreferencesProvider><ProjectLogs copy={vi.fn().mockResolvedValue(undefined)} sessionId="one" project="demo" containers={[container]} initialPage={page()} retry={vi.fn().mockResolvedValue(true)} configure={vi.fn()} error={null} onError={vi.fn()} /></PreferencesProvider>);
    expect(screen.getByText('선택한 1개 / 전체 1개')).toBeVisible();
    expect(screen.getByText('web-1 · 수집 중')).not.toBeVisible();
    fireEvent.click(screen.getByText('대상별 상태'));
    expect(screen.getByText('web-1 · 수집 중')).toBeVisible();
  });

  it.each(['취소', '수집 대상 선택 닫기', 'Escape'])('discards pending source edits on %s', async action => {
    const configure = vi.fn().mockResolvedValue(true);
    render(<PreferencesProvider><ProjectLogs copy={vi.fn().mockResolvedValue(undefined)} sessionId="one" project="demo" containers={[container]} initialPage={page()} retry={vi.fn().mockResolvedValue(true)} configure={configure} error={null} onError={vi.fn()} /></PreferencesProvider>);
    fireEvent.click(screen.getByRole('button', { name: '수집 대상' }));
    fireEvent.click(within(screen.getByRole('group', { name: '로그 수집 대상 선택' })).getByRole('checkbox'));
    if (action === 'Escape') fireEvent.keyDown(screen.getByRole('group', { name: '로그 수집 대상 선택' }), { key: 'Escape' });
    else fireEvent.click(screen.getByRole('button', { name: action }));
    expect(screen.queryByRole('group', { name: '로그 수집 대상 선택' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '수집 대상' })).toHaveFocus();
    expect(configure).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '수집 대상' }));
    expect(within(screen.getByRole('group', { name: '로그 수집 대상 선택' })).getByRole('checkbox')).toBeChecked();
  });

  it('preserves pending source choices when apply fails and uses current handles on retry', async () => {
    const pending = deferred<boolean>();
    const configure = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(true);
    const other = { ...container, fullId: 'b', handle: 'hb', name: 'worker-1', composeService: 'worker' };
    const initial = { ...page(), sources: [...page().sources, { ...page().sources[0]!, fullId: 'b', sourceId: 'b', serviceName: 'worker', containerName: 'worker-1', selected: false }] };
    vi.mocked(projectLogApi.query).mockResolvedValue(initial);
    const view = (containers: Container[]) => <PreferencesProvider><ProjectLogs copy={vi.fn().mockResolvedValue(undefined)} sessionId="one" project="demo" containers={containers} initialPage={initial} retry={vi.fn().mockResolvedValue(true)} configure={configure} error={null} onError={vi.fn()} /></PreferencesProvider>;
    const { rerender } = render(view([container, other]));
    fireEvent.click(screen.getByRole('button', { name: '수집 대상' }));
    const group = screen.getByRole('group', { name: '로그 수집 대상 선택' });
    fireEvent.click(within(group).getByRole('checkbox', { name: 'web · web-1' }));
    fireEvent.click(within(group).getByRole('checkbox', { name: 'worker · worker-1' }));
    fireEvent.click(screen.getByRole('button', { name: '수집 대상 적용' }));
    expect(configure).toHaveBeenLastCalledWith(['hb']);
    expect(screen.getByRole('button', { name: '적용 중…' })).toBeDisabled();
    await act(async () => pending.reject({ code: 'Busy', message: 'Try after refresh' }));
    expect(within(group).getByRole('checkbox', { name: 'worker · worker-1' })).toBeChecked();
    expect(within(group).getByRole('checkbox', { name: 'web · web-1' })).not.toBeChecked();
    expect(screen.getByRole('alert')).toHaveTextContent('Try after refresh');
    rerender(view([container, { ...other, handle: 'hb-new' }]));
    fireEvent.click(screen.getByRole('button', { name: '수집 대상 적용' }));
    await waitFor(() => expect(screen.queryByRole('group', { name: '로그 수집 대상 선택' })).not.toBeInTheDocument());
    expect(configure).toHaveBeenLastCalledWith(['hb-new']);
  });

  it('allows a required source picker to close without configuring an arbitrary subset', async () => {
    const initial = { ...page(0), needsSelection: true, sources: page().sources.map(source => ({ ...source, selected: false })) };
    vi.mocked(projectLogApi.query).mockResolvedValue(initial);
    render(<PreferencesProvider><ProjectLogs copy={vi.fn().mockResolvedValue(undefined)} sessionId="one" project="demo" containers={[container]} initialPage={initial} retry={vi.fn().mockResolvedValue(true)} configure={vi.fn()} error={null} onError={vi.fn()} /></PreferencesProvider>);
    fireEvent.keyDown(screen.getByRole('group', { name: '로그 수집 대상 선택' }), { key: 'Escape' });
    await act(async () => {});
    expect(screen.queryByRole('group', { name: '로그 수집 대상 선택' })).not.toBeInTheDocument();
    expect(screen.getByText('로그 수집 대상을 선택하세요.')).toBeVisible();
    expect(projectLogApi.configure).not.toHaveBeenCalled();
  });
});

describe('project log collection configuration', () => {
  it('accepts only the latest configure response for the same project', async () => {
    const automatic = deferred<ProjectLogPage>(), older = deferred<ProjectLogPage>(), newer = deferred<ProjectLogPage>();
    vi.mocked(projectLogApi.configure).mockReturnValueOnce(automatic.promise).mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const onError = vi.fn();
    const { result, rerender } = renderHook(({ onError }) => useProjectLogCollection('one', 'demo', true, onError), { initialProps: { onError } });
    await act(async () => automatic.resolve({ ...page(), revision: 10 }));
    let first!: Promise<boolean>, second!: Promise<boolean>;
    await act(async () => { first = result.current.configure(['old']); });
    act(() => { second = result.current.configure(['new']); });
    expect(projectLogApi.configure).toHaveBeenCalledTimes(2);
    await act(async () => { older.resolve({ ...page(), revision: 20 }); await first; });
    expect(result.current.page?.revision).toBe(10);
    expect(projectLogApi.configure).toHaveBeenLastCalledWith('one', 'demo', ['new']);
    await act(async () => { newer.resolve({ ...page(), revision: 30 }); await second; });
    expect(result.current.page?.revision).toBe(30);
    rerender({ onError: vi.fn() });
    expect(projectLogApi.configure).toHaveBeenCalledTimes(3);
    expect(projectLogApi.stop).not.toHaveBeenCalled();
  });

  it('skips superseded queued configurations before invoking Core', async () => {
    const automatic = deferred<ProjectLogPage>();
    vi.mocked(projectLogApi.configure).mockReturnValueOnce(automatic.promise).mockResolvedValue({ ...page(), revision: 30 });
    const { result } = renderHook(() => useProjectLogCollection('one', 'demo', true, vi.fn()));
    await act(async () => {});
    let older!: Promise<boolean>, newer!: Promise<boolean>;
    act(() => { older = result.current.configure(['old']); newer = result.current.configure(['new']); });
    expect(projectLogApi.configure).toHaveBeenCalledOnce();
    await act(async () => { automatic.resolve(page()); await Promise.all([older, newer]); });
    expect(vi.mocked(projectLogApi.configure).mock.calls.map(call => call[2])).toEqual([null, ['new']]);
    expect(result.current.page?.revision).toBe(30);
  });

  it('finishes an active apply before stopping its project and configuring the next one', async () => {
    const applying = deferred<ProjectLogPage>();
    const order: string[] = [];
    vi.mocked(projectLogApi.configure).mockImplementation(async (_session, project, handles) => {
      order.push(`configure:${project}:${handles?.join() ?? 'auto'}`);
      if (handles) { const result = await applying.promise; order.push('applied:demo'); return result; }
      return { ...page(), project };
    });
    vi.mocked(projectLogApi.stop).mockImplementation(async () => { order.push('stop'); });
    const { result, rerender } = renderHook(({ project }) => useProjectLogCollection('one', project, true, vi.fn()), { initialProps: { project: 'demo' } });
    await act(async () => {});
    let apply!: Promise<boolean>;
    await act(async () => { apply = result.current.configure(['ha']); });
    rerender({ project: 'next' });
    await act(async () => {});
    expect(order).toEqual(['configure:demo:auto', 'configure:demo:ha']);
    await act(async () => { applying.resolve(page()); await apply; });
    expect(order).toEqual(['configure:demo:auto', 'configure:demo:ha', 'applied:demo', 'stop', 'configure:next:auto']);
    expect(result.current.page?.project).toBe('next');
  });

  it('rejects configure failures to callers while retaining the last successful collection', async () => {
    vi.mocked(projectLogApi.configure).mockResolvedValueOnce(page()).mockRejectedValueOnce({ code: 'Busy', message: 'Inventory changed' });
    const onError = vi.fn();
    const { result } = renderHook(() => useProjectLogCollection('one', 'demo', true, onError));
    await act(async () => {});
    await act(async () => { await expect(result.current.configure(['ha'])).rejects.toEqual({ code: 'Busy', message: 'Inventory changed' }); });
    expect(result.current.page?.rows).toHaveLength(2);
    expect(result.current.error?.code).toBe('Busy');
    expect(onError).toHaveBeenCalledOnce();
  });

  it('rejects an error-bearing configure page without reporting successful application', async () => {
    const failure = { code: 'Busy', message: 'Source selection was not applied' };
    vi.mocked(projectLogApi.configure).mockResolvedValueOnce(page()).mockResolvedValueOnce({ ...page(0), error: failure });
    const { result } = renderHook(() => useProjectLogCollection('one', 'demo', true, vi.fn()));
    await act(async () => {});
    await act(async () => { await expect(result.current.configure(['ha'])).rejects.toEqual(failure); });
    expect(result.current.page?.rows).toHaveLength(2);
    expect(result.current.error).toEqual(failure);
  });
});
