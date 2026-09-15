import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IncidentDetail, IncidentResourceChart, incidentResourceSegments } from './IncidentDetail';
import { useIncidentReview, incidentWindow, type IncidentReview } from './useIncidentReview';
import { projectLogApi, type ObservationEvent, type ObservationRead, type ProjectLogPage, type ResourcePoint } from './observationApi';
import { PreferencesProvider } from './preferences';
import { ObservationHistory } from './ObservationHistory';

vi.mock('./observationApi', async importOriginal => ({ ...await importOriginal<typeof import('./observationApi')>(),
  projectLogApi: { configure: vi.fn(), query: vi.fn(), retry: vi.fn(), stop: vi.fn() },
}));
const occurredAt = '2026-09-15T10:00:00.000Z';
const fullId = 'a'.repeat(64);
const event: ObservationEvent = { sequence: 10, fullId, name: 'web-1', composeProject: 'demo', composeService: 'web', kind: 'oom', occurredAt, observedAt: occurredAt, detail: null };
const point = (sequence: number, seconds = 0, id = fullId): ResourcePoint => ({ sequence, fullId: id, sampledAt: new Date(Date.parse(occurredAt) + seconds * 1000).toISOString(), cpuPercent: 125, memoryUsageBytes: 2048, memoryLimitBytes: 4096, available: true });
const observation = (resources = [point(1)]): ObservationRead => ({ sessionId: 'one', sequence: 10, scope: { kind: 'project', name: 'demo' }, inventory: null, resources, events: [event], resourceTruncated: false, eventTruncated: false, inventoryError: null, statsError: null, eventError: null, eventStatus: 'following' });
function page(overrides: Partial<ProjectLogPage> = {}): ProjectLogPage {
  return { sessionId: 'one', project: 'demo', revision: 1, maxSequence: 30, totalRows: 3, offset: 0, droppedRows: 0, needsSelection: false, error: null, retainedFrom: '2026-09-15T09:59:50.000Z', retainedTo: '2026-09-15T10:00:01.000Z', coverageGaps: 0,
    sources: [{ sourceId: fullId, fullId, serviceName: 'web', containerName: 'web-1', selected: true, status: 'following', error: null, droppedRows: 0 }],
    rows: [-10, 0, 1].map((seconds, index) => ({ rowId: `row-${index}`, sequence: index + 1, sourceId: fullId, fullId, serviceName: 'web', containerName: 'web-1', timestamp: point(index, seconds).sampledAt, receivedAt: occurredAt, pipe: 'stdout', text: `log ${index}`, truncated: false })), ...overrides };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(accept => { resolve = accept; }); return { promise, resolve }; }
beforeEach(() => { vi.resetAllMocks(); vi.mocked(projectLogApi.query).mockResolvedValue(page()); localStorage.setItem('docker2u.preferences.v1', JSON.stringify({ theme: 'dark', language: 'ko' })); });
afterEach(() => vi.useRealTimers());

describe('incident query lifecycle', () => {
  it('anchors a bounded exact-ID read and snapshots only matching resources without configuring collection', async () => {
    const source = observation([point(1), point(2, 400), point(3, 0, 'other'), point(4, -300)]);
    const { result } = renderHook(() => useIncidentReview('one', source));
    act(() => result.current.select(event));
    await waitFor(() => expect(result.current.state?.loading).toBe(false));
    expect(projectLogApi.query).toHaveBeenCalledWith('one', 'demo', {
      sourceIds: [fullId], keyword: '', offset: null, limit: 160, throughSequence: null,
      timeFrom: '2026-09-15T09:58:00.000Z', timeTo: '2026-09-15T10:02:00.000Z', anchorTime: occurredAt,
    });
    expect(result.current.state?.resourcePoints.map(item => item.sequence)).toEqual([4, 1]);
    expect(result.current.state?.event).not.toBe(event);
    expect(result.current.state?.resourcePoints[1]).not.toBe(source.resources[0]);
    expect(result.current.state?.logScroll).toBe(24);
    expect(projectLogApi.configure).not.toHaveBeenCalled(); expect(projectLogApi.stop).not.toHaveBeenCalled();
  });
  it('keeps selection frozen across observations, window changes and pages until refresh', async () => {
    const { result, rerender } = renderHook(({ value }) => useIncidentReview('one', value), { initialProps: { value: observation([point(1)]) } });
    act(() => result.current.select(event));
    await waitFor(() => expect(result.current.state?.loading).toBe(false));
    rerender({ value: observation([point(1), point(2, 5)]) });
    expect(result.current.state?.resourcePoints).toHaveLength(1);
    expect(projectLogApi.query).toHaveBeenCalledOnce();
    act(() => result.current.setWindow(5));
    await waitFor(() => expect(result.current.state?.loading).toBe(false));
    expect(projectLogApi.query).toHaveBeenLastCalledWith('one', 'demo', expect.objectContaining({ throughSequence: 30, timeFrom: '2026-09-15T09:55:00.000Z', timeTo: '2026-09-15T10:05:00.000Z', anchorTime: occurredAt }));
    expect(result.current.state?.resourcePoints).toHaveLength(1);
    act(() => result.current.page(160));
    await waitFor(() => expect(result.current.state?.loading).toBe(false));
    expect(projectLogApi.query).toHaveBeenLastCalledWith('one', 'demo', expect.objectContaining({ anchorRowId: 'row-2', throughSequence: 30 }));
    expect(vi.mocked(projectLogApi.query).mock.lastCall?.[2]).not.toHaveProperty('anchorTime');
    vi.mocked(projectLogApi.query).mockResolvedValue(page({ maxSequence: 45 }));
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.state?.throughSequence).toBe(45));
    expect(projectLogApi.query).toHaveBeenLastCalledWith('one', 'demo', expect.objectContaining({ throughSequence: null }));
    expect(result.current.state?.resourcePoints).toHaveLength(2);
  });
  it('pages by retained row boundaries without skipping after prefix pruning', async () => {
    let retainedRows = Array.from({ length: 500 }, (_, index) => ({ ...page().rows[0]!, rowId: `r${index}`, sequence: index + 1, text: `retained ${index}` }));
    let pruneBeforeBackwardRead = false;
    vi.mocked(projectLogApi.query).mockImplementation(async (_session, _project, query) => {
      if (!query.anchorRowId && !query.anchorTime && pruneBeforeBackwardRead) {
        retainedRows = retainedRows.slice(10); pruneBeforeBackwardRead = false;
      }
      const anchored = query.anchorRowId ? retainedRows.findIndex(row => row.rowId === query.anchorRowId) : -1;
      const offset = query.anchorTime ? 100 : anchored >= 0 ? anchored : query.offset ?? 0;
      if (query.anchorRowId === 'r260') pruneBeforeBackwardRead = true;
      return page({ maxSequence: 500, totalRows: retainedRows.length, offset, rows: retainedRows.slice(offset, offset + query.limit), anchorLost: !!query.anchorRowId && anchored < 0 });
    });
    const { result } = renderHook(() => useIncidentReview('one', observation()));
    act(() => result.current.select(event));
    await waitFor(() => expect(result.current.state?.loading).toBe(false));
    expect(result.current.state?.page?.rows.at(-1)?.rowId).toBe('r259');
    retainedRows = retainedRows.slice(50);
    act(() => result.current.page(260));
    await waitFor(() => expect(result.current.state?.loading).toBe(false));
    expect(result.current.state?.page?.rows[0]?.rowId).toBe('r260');
    expect(result.current.state?.page?.rows.at(-1)?.rowId).toBe('r418');
    expect(projectLogApi.query).toHaveBeenLastCalledWith('one', 'demo', expect.objectContaining({ anchorRowId: 'r259', limit: 160, throughSequence: 500 }));
    retainedRows = retainedRows.slice(20);
    act(() => result.current.page(50));
    await waitFor(() => expect(result.current.state?.loading).toBe(false));
    expect(result.current.state?.page?.rows.map(row => row.rowId)).toEqual(Array.from({ length: 149 }, (_, index) => `r${111 + index}`));
    expect(result.current.state?.page?.rows.at(-1)?.rowId).toBe('r259');
    expect(vi.mocked(projectLogApi.query).mock.calls.every(call => call[2].limit <= 160)).toBe(true);
  });
  it('keeps the displayed page when its stable boundary is evicted', async () => {
    const { result } = renderHook(() => useIncidentReview('one', observation()));
    act(() => result.current.select(event));
    await waitFor(() => expect(result.current.state?.loading).toBe(false));
    const retained = result.current.state!.page!;
    vi.mocked(projectLogApi.query).mockResolvedValue(page({ anchorLost: true, rows: [{ ...page().rows[0]!, rowId: 'unrelated-fallback' }] }));
    act(() => result.current.page(3));
    await waitFor(() => expect(result.current.state?.loading).toBe(false));
    expect(result.current.state?.error?.code).toBe('IncidentLogAnchorLost');
    expect(result.current.state?.page?.rows).toBe(retained.rows);
    expect(result.current.state?.page?.anchorLost).toBe(true);
  });
  it('rejects a backward page when pruning moves its boundary outside the candidate', async () => {
    const rows = Array.from({ length: 160 }, (_, index) => ({ ...page().rows[0]!, rowId: `r${200 + index}` }));
    vi.mocked(projectLogApi.query).mockResolvedValue(page({ offset: 200, totalRows: 500, rows }));
    const { result } = renderHook(() => useIncidentReview('one', observation()));
    act(() => result.current.select(event));
    await waitFor(() => expect(result.current.state?.loading).toBe(false));
    const committed = result.current.state!.page;
    vi.mocked(projectLogApi.query).mockResolvedValueOnce(page({ offset: 180, totalRows: 480, rows }))
      .mockResolvedValueOnce(page({ offset: 21, totalRows: 200, rows: [{ ...rows[0]!, rowId: 'past-the-boundary' }] }));
    act(() => result.current.page(40));
    await waitFor(() => expect(result.current.state?.loading).toBe(false));
    expect(result.current.state?.error?.code).toBe('IncidentLogPageChanged');
    expect(result.current.state?.page).toBe(committed);
    expect(projectLogApi.query).toHaveBeenCalledTimes(3);
  });
  it('preserves the committed snapshot and watermark after a failed refresh', async () => {
    const { result, rerender } = renderHook(({ value }) => useIncidentReview('one', value), { initialProps: { value: observation() } });
    act(() => result.current.select(event));
    await waitFor(() => expect(result.current.state?.loading).toBe(false));
    const committed = result.current.state!;
    rerender({ value: observation([point(2, 5)]) });
    const failed = deferred<ProjectLogPage>();
    vi.mocked(projectLogApi.query).mockReturnValueOnce(failed.promise);
    act(() => result.current.refresh());
    expect(result.current.state?.throughSequence).toBe(30);
    expect(result.current.state?.capturedAt).toBe(committed.capturedAt);
    expect(result.current.state?.resourcePoints).toBe(committed.resourcePoints);
    await act(async () => failed.resolve(page({ error: { code: 'QueryFailed', message: 'Query failed' }, maxSequence: 90 })));
    expect(result.current.state?.error?.code).toBe('QueryFailed');
    expect(result.current.state?.page).toBe(committed.page);
    expect(result.current.state?.throughSequence).toBe(30);
    expect(result.current.state?.capturedAt).toBe(committed.capturedAt);
    expect(result.current.state?.resourcePoints).toBe(committed.resourcePoints);
    act(() => result.current.page(3));
    await waitFor(() => expect(result.current.state?.loading).toBe(false));
    expect(projectLogApi.query).toHaveBeenLastCalledWith('one', 'demo', expect.objectContaining({ throughSequence: 30, anchorRowId: 'row-2' }));
    act(() => result.current.setWindow(5));
    await waitFor(() => expect(result.current.state?.loading).toBe(false));
    expect(projectLogApi.query).toHaveBeenLastCalledWith('one', 'demo', expect.objectContaining({ throughSequence: 30, anchorTime: occurredAt }));
  });
  it('discards an earlier incident response when another incident is selected', async () => {
    const old = deferred<ProjectLogPage>();
    vi.mocked(projectLogApi.query).mockReturnValueOnce(old.promise).mockResolvedValue(page({ rows: [], totalRows: 0 }));
    const { result } = renderHook(() => useIncidentReview('one', observation()));
    act(() => result.current.select(event));
    act(() => result.current.select({ ...event, sequence: 11, kind: 'restart' }));
    await waitFor(() => expect(result.current.state?.loading).toBe(false));
    await act(async () => old.resolve(page()));
    expect(result.current.state?.event.sequence).toBe(11);
    expect(result.current.state?.page?.rows).toEqual([]);
  });
  it('discards a late window response and retains the latest window', async () => {
    const old = deferred<ProjectLogPage>();
    const { result } = renderHook(() => useIncidentReview('one', observation()));
    act(() => result.current.select(event));
    await waitFor(() => expect(result.current.state?.loading).toBe(false));
    vi.mocked(projectLogApi.query).mockReturnValueOnce(old.promise).mockResolvedValue(page({ rows: [], totalRows: 0 }));
    act(() => result.current.setWindow(1));
    act(() => result.current.setWindow(5));
    await waitFor(() => expect(result.current.state?.loading).toBe(false));
    await act(async () => old.resolve(page()));
    expect(result.current.state?.windowMinutes).toBe(5);
    expect(result.current.state?.page?.rows).toEqual([]);
  });
  it('clears session state and ignores previous-session replies after reconnect', async () => {
    const old = deferred<ProjectLogPage>(), onError = vi.fn();
    vi.mocked(projectLogApi.query).mockReturnValueOnce(old.promise);
    const { result, rerender } = renderHook(({ session }) => useIncidentReview(session, observation(), onError), { initialProps: { session: 'one' } });
    act(() => result.current.select(event));
    rerender({ session: 'two' });
    expect(result.current.state).toBeNull();
    await act(async () => old.resolve(page()));
    expect(result.current.state).toBeNull(); expect(onError).not.toHaveBeenCalled();
  });
  it('rejects cross-container and cross-project responses without attaching their data', async () => {
    const onError = vi.fn();
    vi.mocked(projectLogApi.query).mockResolvedValueOnce(page({ rows: [{ ...page().rows[0]!, fullId: 'recreated' }] })).mockResolvedValue(page({ project: 'other' }));
    const { result } = renderHook(() => useIncidentReview('one', observation(), onError));
    act(() => result.current.select(event));
    await waitFor(() => expect(result.current.state?.error?.code).toBe('InvalidProjectLogsResponse'));
    expect(result.current.state?.page).toBeNull();
    act(() => result.current.refresh());
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(2));
    expect(result.current.state?.page).toBeNull();
  });
  it('times out a query while preserving the last page and lets refresh retry', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useIncidentReview('one', observation()));
    await act(async () => result.current.select(event));
    const retained = result.current.state?.page;
    const capturedAt = result.current.state?.capturedAt;
    vi.mocked(projectLogApi.query).mockReturnValueOnce(new Promise(() => {}));
    await act(async () => result.current.refresh());
    act(() => result.current.setLogScroll(96));
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(result.current.state?.loading).toBe(false);
    expect(result.current.state?.page).toBe(retained);
    expect(result.current.state?.error?.code).toBe('IncidentQueryTimeout');
    expect(result.current.state?.throughSequence).toBe(30);
    expect(result.current.state?.capturedAt).toBe(capturedAt);
    expect(result.current.state?.logScroll).toBe(96);
    await act(async () => result.current.refresh());
    expect(result.current.state?.error).toBeNull();
  });
});

function fixedReview(): IncidentReview {
  return { state: { sessionId: 'one', event, windowMinutes: 2, resourcePoints: [point(1, -5), point(2)], resourceTruncated: false, capturedAt: occurredAt, page: page(), throughSequence: 30, loading: false, error: null, logScroll: 24 }, select: vi.fn(), close: vi.fn(), setWindow: vi.fn(), refresh: vi.fn(), page: vi.fn(), setLogScroll: vi.fn() };
}
describe('incident detail', () => {
  it('shows the selected identity, event marker, window and current-detail actions', () => {
    const review = fixedReview(), onClose = vi.fn(), onNavigate = vi.fn();
    const { container } = render(<PreferencesProvider><IncidentDetail review={review} onClose={onClose} onNavigate={onNavigate} currentAvailable /></PreferencesProvider>);
    expect(screen.getByRole('region', { name: '사건 당시 기록' })).toHaveTextContent('메모리 부족');
    expect(container.querySelectorAll('.incident-time-marker')).toHaveLength(2);
    expect(screen.getByRole('log', { name: '사건 구간 로그' }).scrollTop).toBe(24);
    const group = screen.getByRole('group', { name: '사건 조회 구간' });
    expect(within(group).getByRole('button', { name: '전후 2분' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(within(group).getByRole('button', { name: '전후 5분' })); expect(review.setWindow).toHaveBeenCalledWith(5);
    fireEvent.click(screen.getByRole('button', { name: '사건 기록 새로고침' })); expect(review.refresh).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: '현재 진단' })); expect(onNavigate).toHaveBeenCalledWith('diagnostics');
    fireEvent.click(screen.getByRole('button', { name: '사건 상세 닫기' })); expect(onClose).toHaveBeenCalledOnce();
  });
  it('pages within the frozen view and restores log scroll when detail remounts', () => {
    const review = fixedReview();
    review.state!.page = page({ offset: 160, totalRows: 500 });
    const view = () => <PreferencesProvider><IncidentDetail review={review} onClose={vi.fn()} onNavigate={vi.fn()} currentAvailable /></PreferencesProvider>;
    const first = render(view());
    const logs = screen.getByRole('log', { name: '사건 구간 로그' });
    logs.scrollTop = 72; fireEvent.scroll(logs);
    expect(review.setLogScroll).toHaveBeenCalledWith(72);
    fireEvent.click(screen.getByRole('button', { name: '이전 로그' })); expect(review.page).toHaveBeenCalledWith(0);
    fireEvent.click(screen.getByRole('button', { name: '다음 로그' })); expect(review.page).toHaveBeenCalledWith(163);
    review.state!.logScroll = 72;
    first.unmount(); render(view());
    expect(screen.getByRole('log', { name: '사건 구간 로그' }).scrollTop).toBe(72);
    expect(projectLogApi.query).not.toHaveBeenCalled();
  });
  it('plots resources at inclusive bounds across RFC3339 offsets and precision', () => {
    const review = fixedReview();
    review.state!.resourcePoints = [
      { ...point(1), sampledAt: '2026-09-15T18:58:00+09:00' },
      { ...point(2), sampledAt: '2026-09-15T10:02:00Z' },
      { ...point(3), sampledAt: '2026-09-15T10:02:00.001Z' },
    ];
    const { container } = render(<PreferencesProvider><IncidentDetail review={review} onClose={vi.fn()} onNavigate={vi.fn()} currentAvailable /></PreferencesProvider>);
    expect(container.querySelectorAll('.resource-point')).toHaveLength(4);
    expect(container.querySelector('.resource-point')).toHaveAttribute('cx', '8');
    expect(container.querySelectorAll('.resource-point')[1]).toHaveAttribute('cx', '592');
  });
  it('labels receive-time rows, retained coverage and project-wide losses', () => {
    const review = fixedReview(); review.state!.page = page({ droppedRows: 9, coverageGaps: 2, rows: [{ ...page().rows[0]!, timestamp: null, truncated: true }] });
    render(<PreferencesProvider><IncidentDetail review={review} onClose={vi.fn()} onNavigate={vi.fn()} currentAvailable={false} /></PreferencesProvider>);
    expect(screen.getByText('수신 시각')).toBeVisible(); expect(screen.getByText('긴 행 잘림')).toBeVisible();
    expect(screen.getByText('프로젝트 전체: 보관 한도로 9행 삭제됨')).toBeVisible();
    expect(screen.getByText('프로젝트 전체 수집 공백 2회')).toBeVisible();
    expect(screen.getByRole('button', { name: '현재 진단' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '현재 접속' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '현재 저장소' })).toBeDisabled();
  });
  it('distinguishes an empty interval from a failed query', () => {
    const review = fixedReview(); review.state!.page = page({ rows: [], totalRows: 0 });
    const view = () => <PreferencesProvider><IncidentDetail review={review} onClose={vi.fn()} onNavigate={vi.fn()} currentAvailable /></PreferencesProvider>;
    const { rerender } = render(view());
    expect(screen.getByText('해당 구간에 보관된 로그 없음')).toBeVisible();
    review.state!.error = { code: 'ReadFailed', message: 'Read failed' };
    rerender(view());
    expect(screen.queryByText('해당 구간에 보관된 로그 없음')).not.toBeInTheDocument();
    expect(screen.getAllByText('사건 로그를 조회하지 못했습니다. 새로고침으로 다시 조회하세요.').length).toBeGreaterThan(0);
  });
  it('keeps unavailable and unsampled resource intervals empty and places the event at the window center', () => {
    const points = [point(1, -20), point(2, -15), { ...point(3, -10), available: false }, point(4, -5), point(5, 30)];
    expect(incidentResourceSegments(points, 'cpu').map(segment => segment.length)).toEqual([2, 1, 1]);
    const bounds = incidentWindow(event, 2);
    const { container } = render(<PreferencesProvider><IncidentResourceChart points={points} metric="cpu" from={bounds.timeFrom} to={bounds.timeTo} occurredAt={occurredAt} /></PreferencesProvider>);
    expect(container.querySelector('.incident-time-marker')).toHaveAttribute('x1', '300');
    expect(container.querySelectorAll('.resource-line')).toHaveLength(1);
    expect(container.querySelectorAll('.resource-point')).toHaveLength(2);
  });
});

function HistoryHarness({ value }: { value: ObservationRead }) {
  const review = useIncidentReview('one', value);
  return <PreferencesProvider><ObservationHistory observation={value} containers={[]} incident={review} onSelectEvent={review.select} onCloseIncident={review.close} /></PreferencesProvider>;
}
it('keeps an expired incident row as a focus target until deliberate history navigation', async () => {
  const value = observation();
  const { rerender } = render(<HistoryHarness value={value} />);
  fireEvent.click(document.querySelector('.history-event-trigger')!);
  await screen.findByRole('button', { name: '사건 상세 닫기' });
  rerender(<HistoryHarness value={{ ...value, events: [] }} />);
  fireEvent.click(screen.getByRole('button', { name: '사건 상세 닫기' }));
  expect(document.querySelector('[data-event-sequence="10"]')).toHaveFocus();
  expect(document.querySelector('.incident-detail')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '최신 위치' }));
  expect(document.querySelector('[data-event-sequence="10"]')).not.toBeInTheDocument();
});
