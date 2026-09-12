import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mergeObservation, useObservation } from './useObservation';
import { ObservationHistory, ResourceChart, resourceSegments } from './ObservationHistory';
import { ProjectLogs, logRowsText } from './ProjectLogs';
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
const container: Container = { handle: 'ha', fullId: 'a', shortId: 'a', name: 'web-1', composeProject: 'demo', composeService: 'web', state: 'running', health: 'healthy', image: 'web', ports: [], createdAt: '' };
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
    render(<PreferencesProvider><ProjectLogs sessionId="one" project="demo" containers={[container]} initialPage={page()} configure={configure} error={null} onError={vi.fn()} /></PreferencesProvider>);
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
    const configure = vi.fn().mockResolvedValue(undefined);
    render(<PreferencesProvider><ProjectLogs sessionId="one" project="demo" containers={sources.map(source => ({ ...container, fullId: source.fullId, handle: `h-${source.fullId}` }))} initialPage={initial} configure={configure} error={null} onError={vi.fn()} /></PreferencesProvider>);
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
    const { container: root } = render(<PreferencesProvider><ProjectLogs sessionId="one" project="demo" containers={[container]} initialPage={large} configure={vi.fn()} error={null} onError={vi.fn()} /></PreferencesProvider>);
    expect(root.querySelectorAll('.project-log-row')).toHaveLength(160);
    expect(root.querySelector('.project-log-spacer')).toHaveStyle({ height: '2600000px' });
  });
});

it('uses the latest-page offset and copies only its displayed window', async () => {
  const latest = { ...page(40), totalRows: 5000, offset: 4960 };
  vi.mocked(projectLogApi.query).mockResolvedValue(latest);
  const clipboard = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: clipboard } });
  const { container: root } = render(<PreferencesProvider><ProjectLogs sessionId="one" project="demo" containers={[container]} initialPage={latest} configure={vi.fn()} error={null} onError={vi.fn()} /></PreferencesProvider>);
  expect(latest.offset + latest.rows.length).toBe(latest.totalRows);
  expect(root.querySelector('.project-log-window')).toHaveStyle({ top: `${4960 * 26}px` });
  fireEvent.click(screen.getByRole('button', { name: '현재 표시 구간 복사' }));
  await waitFor(() => expect(clipboard).toHaveBeenCalledWith(logRowsText(latest.rows)));
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

it('keeps the frozen scroll position when expanding and closing a paused log view', async () => {
  render(<PreferencesProvider><ProjectLogs sessionId="one" project="demo" containers={[container]} initialPage={page()} configure={vi.fn()} error={null} onError={vi.fn()} /></PreferencesProvider>);
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
  render(<PreferencesProvider><ProjectLogs sessionId="one" project="demo" containers={[container]} initialPage={previous} configure={vi.fn()} error={null} onError={vi.fn()} /></PreferencesProvider>);
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
    const { unmount } = render(<PreferencesProvider><ProjectLogs sessionId="one" project="demo" containers={[container]} initialPage={latest} configure={vi.fn()} error={null} onError={vi.fn()} /></PreferencesProvider>);
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
  const view = (visible: boolean) => <PreferencesProvider><ProjectLogs sessionId="one" project="demo" containers={[container]} initialPage={initial} configure={vi.fn()} error={null} visible={visible} onError={vi.fn()} /></PreferencesProvider>;
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
