import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import App from './App';
import { api, type Container, type ContainerList, type Environment } from './api';
import { observationApi, projectLogApi, type ObservationRead } from './observationApi';
import { installSnapshotStreams } from './test/snapshotStreams';
import { containerDetailsFixture } from './test/containerDetailsFixture';

vi.mock('./api', async importOriginal => ({ ...await importOriginal<typeof import('./api')>(), api: { getEnvironment: vi.fn(), listContainers: vi.fn(), getRecentLogs: vi.fn(), startLogStream: vi.fn(), readLogStream: vi.fn(), stopLogStream: vi.fn(), getContainerStats: vi.fn(), getContainerDetails: vi.fn(), mutateContainer: vi.fn(), mutateContainers: vi.fn() } }));
vi.mock('./observationApi', async importOriginal => ({ ...await importOriginal<typeof import('./observationApi')>(), observationApi: { available: vi.fn(() => true), configure: vi.fn(), read: vi.fn(), hold: vi.fn(), release: vi.fn() }, projectLogApi: { configure: vi.fn(), query: vi.fn(), retry: vi.fn(), stop: vi.fn() } }));
const mock = vi.mocked(api);
const container: Container = { handle: 'ha-1', fullId: 'a'.repeat(64), shortId: 'a'.repeat(12), name: 'web', composeProject: 'demo', composeService: 'web', state: 'running', health: 'healthy', healthConfigured: true, image: 'web', ports: [], createdAt: '' };
const inventory = (generation = 1, state = 'running'): ContainerList => ({ sessionId: 'one', generation, containers: [{ ...container, handle: `ha-${generation}`, state }], refreshedAt: new Date().toISOString(), stale: false });
const observation = (generation = 1): ObservationRead => ({ sessionId: 'one', sequence: generation, scope: { kind: 'all' }, inventory: inventory(generation), resources: [], events: [], resourceTruncated: false, eventTruncated: false, inventoryError: null, statsError: null, eventError: null, eventStatus: 'following' });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => {
  vi.resetAllMocks(); installSnapshotStreams(mock);
  localStorage.setItem('docker2u.preferences.v1', JSON.stringify({ theme: 'dark', language: 'ko' }));
  vi.mocked(observationApi.available).mockReturnValue(true);
  mock.getEnvironment.mockResolvedValue({ status: 'ready', sessionId: 'one', contextName: 'local', endpoint: 'unix:///fixture', engineId: 'engine', mutationAllowed: true, error: null, diagnostics: [] } as unknown as Environment);
  mock.listContainers.mockResolvedValue(inventory());
  mock.getRecentLogs.mockImplementation(async (sessionId, handle) => ({ sessionId, handle, generation: Number(handle.split('-').at(-1)), text: 'ready', truncated: false, byteCount: 5, command: '', stderr: '' }));
  vi.mocked(observationApi.configure).mockResolvedValue(observation());
  vi.mocked(observationApi.read).mockResolvedValue(observation());
  vi.mocked(observationApi.release).mockResolvedValue(undefined);
  vi.mocked(projectLogApi.stop).mockResolvedValue(undefined);
  const initialLogs = { sessionId: 'one', project: 'demo', revision: 1, maxSequence: 0, rows: [], sources: [], totalRows: 0, offset: 0, droppedRows: 0, needsSelection: false, error: null, retainedFrom: null, retainedTo: null };
  vi.mocked(projectLogApi.configure).mockResolvedValue(initialLogs); vi.mocked(projectLogApi.query).mockResolvedValue(initialLogs);
  mock.mutateContainer.mockResolvedValue({ outcome: 'succeeded', message: '', command: '', stderr: '', reconciliation: 'succeeded', mutationBlocked: false });
});
async function ready() { await screen.findByRole('treeitem', { name: 'web 상세' }); await waitFor(() => expect(screen.getByRole('button', { name: '새로고침' })).toBeEnabled()); }

it('preserves checked full IDs when Core publishes new inventory handles without reloading the selected log stream', async () => {
  const next = deferred<ObservationRead>(); vi.mocked(observationApi.read).mockReturnValue(next.promise);
  render(<App />); await ready();
  fireEvent.click(screen.getByRole('checkbox', { name: 'web 작업 대상으로 선택' }));
  await waitFor(() => expect(projectLogApi.configure).toHaveBeenCalledOnce());
  await waitFor(() => expect(observationApi.read).toHaveBeenCalled(), { timeout: 1600 });
  await act(async () => next.resolve(observation(2)));
  expect(screen.getByRole('checkbox', { name: 'web 작업 대상으로 선택' })).toBeChecked();
  expect(screen.getByRole('treeitem', { name: 'web 상세' })).toHaveAttribute('aria-selected', 'true');
  expect(projectLogApi.configure).toHaveBeenCalledOnce();
  expect(mock.getContainerStats).not.toHaveBeenCalled();
});

it('awaits a refresh hold before showing confirmation and uses the latest handle until final reconciliation', async () => {
  const hold = deferred<Awaited<ReturnType<typeof observationApi.hold>>>(); vi.mocked(observationApi.hold).mockReturnValue(hold.promise);
  render(<App />); await ready();
  fireEvent.click(within(screen.getByRole('region', { name: '서비스 복구' })).getByRole('button', { name: '중지' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(observationApi.hold).toHaveBeenCalledWith('one');
  await act(async () => hold.resolve({ sessionId: 'one', holdId: 'held', inventory: inventory(2) }));
  expect(screen.getByRole('dialog', { name: 'web 중지 확인' })).toBeVisible();
  expect(observationApi.release).not.toHaveBeenCalled();
  mock.listContainers.mockResolvedValue(inventory(3, 'exited'));
  fireEvent.click(screen.getByRole('button', { name: '중지 확인' }));
  await waitFor(() => expect(observationApi.release).toHaveBeenCalledWith('one', 'held'));
  expect(mock.mutateContainer).toHaveBeenCalledExactlyOnceWith('one', 'ha-2', 'stop');
  expect(mock.listContainers.mock.invocationCallOrder.at(-1)!).toBeLessThan(vi.mocked(observationApi.release).mock.invocationCallOrder[0]!);
});

it('takes the same latest-inventory hold for Start without opening a confirmation dialog', async () => {
  mock.listContainers.mockResolvedValue(inventory(1, 'exited'));
  vi.mocked(observationApi.configure).mockResolvedValue({ ...observation(), inventory: inventory(1, 'exited') });
  vi.mocked(observationApi.hold).mockResolvedValue({ sessionId: 'one', holdId: 'start-held', inventory: inventory(2, 'exited') });
  render(<App />); await ready();
  mock.listContainers.mockResolvedValue(inventory(3));
  fireEvent.click(within(screen.getByRole('region', { name: '서비스 복구' })).getByRole('button', { name: '시작' }));
  await waitFor(() => expect(mock.mutateContainer).toHaveBeenCalledExactlyOnceWith('one', 'ha-2', 'start'));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  await waitFor(() => expect(observationApi.release).toHaveBeenCalledWith('one', 'start-held'));
});

it('applies same-generation stale inventory after a background failure and blocks actions', async () => {
  const next = deferred<ObservationRead>(); vi.mocked(observationApi.read).mockReturnValue(next.promise);
  render(<App />); await ready();
  await waitFor(() => expect(observationApi.read).toHaveBeenCalled(), { timeout: 2000 });
  await act(async () => next.resolve({ ...observation(), inventory: { ...inventory(), stale: true }, inventoryError: { code: 'CommandFailed', message: 'Inventory unavailable' } }));
  expect(within(screen.getByRole('region', { name: '서비스 복구' })).getByRole('button', { name: '중지' })).toBeDisabled();
  expect(screen.getByRole('treeitem', { name: 'web 상세' })).toBeVisible();
});

it('accepts a manual inventory response already published by the Core display poll', async () => {
  const next = deferred<ObservationRead>(); vi.mocked(observationApi.read).mockReturnValue(next.promise);
  render(<App />); await ready();
  const manual = deferred<ContainerList>(); mock.listContainers.mockReturnValue(manual.promise);
  fireEvent.click(screen.getByRole('button', { name: '새로고침' }));
  await waitFor(() => expect(observationApi.read).toHaveBeenCalled(), { timeout: 2000 });
  const current = inventory(2);
  await act(async () => next.resolve({ ...observation(2), inventory: current }));
  await act(async () => manual.resolve(current));
  expect(screen.queryByText('오래된 정보 · 마지막 정상 목록입니다.')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '새로고침' })).toBeEnabled();
});

it('keeps the project view and collection scope when its last selected container disappears', async () => {
  const next = deferred<ObservationRead>(); vi.mocked(observationApi.read).mockReturnValue(next.promise);
  const page = { sessionId: 'one', project: 'demo', revision: 1, maxSequence: 0, rows: [], sources: [], totalRows: 0, offset: 0, droppedRows: 0, needsSelection: false, error: null, retainedFrom: null, retainedTo: null };
  vi.mocked(projectLogApi.configure).mockResolvedValue(page); vi.mocked(projectLogApi.query).mockResolvedValue(page);
  render(<App />); await ready();
  fireEvent.click(screen.getByRole('treeitem', { name: 'demo 프로젝트' }));
  await waitFor(() => expect(projectLogApi.configure).toHaveBeenCalledWith('one', 'demo', null));
  await waitFor(() => expect(observationApi.read).toHaveBeenCalled(), { timeout: 2000 });
  await act(async () => next.resolve({ ...observation(2), scope: { kind: 'project', name: 'demo' }, inventory: { ...inventory(2), containers: [] } }));
  expect(screen.getByRole('treeitem', { name: 'demo 프로젝트' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('tab', { name: '통합 로그' })).toBeVisible();
  expect(screen.getByRole('heading', { name: '프로젝트 · demo' })).toBeVisible();
});

it.each(['events', 'configure', 'query'] as const)('requires Reconnect immediately for an unsupported observation endpoint reported by %s', async source => {
  const failure = { code: 'UnsupportedObservationEndpoint', message: 'Engine observation requires a Unix socket' };
  if (source === 'events') vi.mocked(observationApi.configure).mockResolvedValueOnce({ ...observation(), eventError: failure, eventStatus: 'error' });
  else if (source === 'configure') vi.mocked(projectLogApi.configure).mockRejectedValueOnce(failure);
  else vi.mocked(projectLogApi.query).mockRejectedValueOnce(failure);
  render(<App />); await ready();
  await waitFor(() => expect(document.querySelector('.connection-status')).toHaveTextContent('연결 재확인 필요'));
  const recovery = within(screen.getByRole('region', { name: '서비스 복구' }));
  expect(recovery.getByRole('button', { name: '중지' })).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox', { name: 'web 작업 대상으로 선택' }));
  expect(screen.getByRole('button', { name: '중지 (1)' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '재시작 (1)' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '새로고침' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '새로고침' })).toBeEnabled());
  expect(document.querySelector('.connection-status')).toHaveTextContent('연결 재확인 필요');
  expect(recovery.getByRole('button', { name: '중지' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '다시 연결' }));
  await waitFor(() => expect(within(screen.getByRole('region', { name: '서비스 복구' })).getByRole('button', { name: '중지' })).toBeEnabled());
  expect(document.querySelector('.connection-status')).toHaveTextContent('연결됨');
  expect(mock.mutateContainer).not.toHaveBeenCalled(); expect(mock.mutateContainers).not.toHaveBeenCalled();
});


function incidentFixture() {
  const at = new Date().toISOString();
  const event = { sequence: 10, fullId: container.fullId, name: container.name, composeProject: 'demo', composeService: 'web', kind: 'oom', occurredAt: at, observedAt: at, detail: null };
  const observed: ObservationRead = { ...observation(), events: [event], resources: [{ sequence: 11, fullId: container.fullId, sampledAt: at, cpuPercent: 42, memoryUsageBytes: 1024, memoryLimitBytes: 4096, available: true }] };
  const page = { sessionId: 'one', project: 'demo', revision: 1, maxSequence: 5, rows: [{ rowId: 'incident-row', sequence: 5, sourceId: container.fullId, fullId: container.fullId, serviceName: 'web', containerName: 'web', timestamp: at, receivedAt: at, pipe: 'stdout' as const, text: 'retained incident output', truncated: false }], sources: [], totalRows: 1, offset: 0, droppedRows: 0, needsSelection: false, error: null, retainedFrom: at, retainedTo: at };
  vi.mocked(observationApi.configure).mockResolvedValue(observed); vi.mocked(observationApi.read).mockResolvedValue(observed);
  vi.mocked(projectLogApi.configure).mockResolvedValue(page); vi.mocked(projectLogApi.query).mockResolvedValue(page);
  mock.getContainerDetails.mockImplementation(async (sessionId, generation) => containerDetailsFixture(container, { ...inventory(generation), sessionId }));
  return { observed, page };
}
async function openIncident() {
  await ready();
  fireEvent.click(screen.getByRole('treeitem', { name: 'demo 프로젝트' }));
  fireEvent.click(screen.getByRole('tab', { name: '이력' }));
  const trigger = document.querySelector<HTMLButtonElement>('.history-event-trigger')!;
  fireEvent.click(trigger);
  await screen.findByRole('button', { name: '사건 상세 닫기' });
  return trigger;
}
it('returns from current details to the frozen incident and restores its trigger without changing collection', async () => {
  incidentFixture(); render(<App />); await openIncident();
  await waitFor(() => expect(projectLogApi.query).toHaveBeenCalledWith('one', 'demo', expect.objectContaining({ sourceIds: [container.fullId], anchorTime: expect.any(String), timeFrom: expect.any(String) })));
  const collectionCalls = vi.mocked(projectLogApi.configure).mock.calls.length;
  fireEvent.click(screen.getByRole('button', { name: '전후 5분' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '전후 5분' })).toHaveAttribute('aria-pressed', 'true'));
  await waitFor(() => expect(screen.getByRole('button', { name: '현재 진단' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: '현재 진단' }));
  await waitFor(() => expect(screen.getByRole('tab', { name: '상태 진단' })).toHaveAttribute('aria-selected', 'true'));
  fireEvent.click(screen.getByRole('button', { name: '사건으로 돌아가기' }));
  await waitFor(() => expect(screen.getByRole('tab', { name: '이력' })).toHaveAttribute('aria-selected', 'true'));
  expect(screen.getByRole('button', { name: '전후 5분' })).toHaveAttribute('aria-pressed', 'true');
  expect(document.querySelector('.history-event-trigger')).toHaveFocus();
  expect(projectLogApi.configure).toHaveBeenCalledTimes(collectionCalls);
  fireEvent.click(screen.getByRole('button', { name: '사건 상세 닫기' }));
  expect(document.querySelector('.history-event-trigger')).toHaveFocus();
  expect(document.querySelector('.incident-detail')).not.toBeInTheDocument();
});
it('queries an old event ID after same-name recreation and disables current-detail links', async () => {
  const { observed } = incidentFixture();
  const next = deferred<ObservationRead>(); vi.mocked(observationApi.read).mockReturnValue(next.promise);
  render(<App />); await ready();
  fireEvent.click(screen.getByRole('treeitem', { name: 'demo 프로젝트' }));
  await waitFor(() => expect(observationApi.read).toHaveBeenCalled(), { timeout: 2000 });
  await act(async () => next.resolve({ ...observed, sequence: 12, inventory: { ...inventory(2), containers: [{ ...container, fullId: 'b'.repeat(64), shortId: 'b'.repeat(12), handle: 'hb-2' }] } }));
  fireEvent.click(screen.getByRole('tab', { name: '이력' }));
  fireEvent.click(document.querySelector('.history-event-trigger')!);
  await waitFor(() => expect(projectLogApi.query).toHaveBeenCalledWith('one', 'demo', expect.objectContaining({ sourceIds: [container.fullId], timeFrom: expect.any(String) })));
  expect(screen.getByRole('button', { name: '현재 진단' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '현재 접속' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '현재 저장소' })).toBeDisabled();
});
it('clears incident and return state on reconnect and ignores the old pending query', async () => {
  const { page } = incidentFixture();
  const pending = deferred<typeof page>();
  vi.mocked(projectLogApi.query).mockImplementation(async (_id, _project, query) => query.timeFrom ? pending.promise : page);
  render(<App />); await openIncident();
  fireEvent.click(screen.getByRole('button', { name: '다시 연결' }));
  await ready();
  await act(async () => pending.resolve(page));
  expect(document.querySelector('.incident-detail')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '사건으로 돌아가기' })).not.toBeInTheDocument();
});

it('does not restore a previous-session history cursor after reconnect unmount cleanup', async () => {
  const { observed } = incidentFixture();
  const many = { ...observed, sequence: 401, events: Array.from({ length: 400 }, (_, index) => ({ ...observed.events[0]!, sequence: index + 1 })) };
  vi.mocked(observationApi.configure).mockResolvedValue(many); vi.mocked(observationApi.read).mockResolvedValue(many);
  render(<App />); await ready();
  fireEvent.click(screen.getByRole('treeitem', { name: 'demo 프로젝트' }));
  fireEvent.click(screen.getByRole('tab', { name: '이력' }));
  fireEvent.click(screen.getByRole('button', { name: '이전 기록' }));
  expect(document.querySelector('.history-event-trigger')).toHaveAttribute('data-event-sequence', '200');
  const history = document.querySelector<HTMLElement>('.observation-history')!;
  history.scrollTop = 85; fireEvent.scroll(history);
  const fresh = { ...observed, sessionId: 'two', inventory: { ...inventory(), sessionId: 'two' }, sequence: 301, events: [{ ...observed.events[0]!, sequence: 300 }] };
  mock.getEnvironment.mockResolvedValue({ status: 'ready', sessionId: 'two', contextName: 'local', endpoint: 'unix:///fixture', engineId: 'engine', mutationAllowed: true, error: null, diagnostics: [] } as unknown as Environment);
  mock.listContainers.mockResolvedValue({ ...inventory(), sessionId: 'two' });
  vi.mocked(projectLogApi.configure).mockResolvedValue({ sessionId: 'two', project: 'demo', revision: 1, maxSequence: 0, rows: [], sources: [], totalRows: 0, offset: 0, droppedRows: 0, needsSelection: false, error: null, retainedFrom: null, retainedTo: null });
  vi.mocked(projectLogApi.query).mockImplementation(async () => ({ sessionId: 'two', project: 'demo', revision: 1, maxSequence: 0, rows: [], sources: [], totalRows: 0, offset: 0, droppedRows: 0, needsSelection: false, error: null, retainedFrom: null, retainedTo: null }));
  vi.mocked(observationApi.configure).mockResolvedValue(fresh); vi.mocked(observationApi.read).mockResolvedValue(fresh);
  fireEvent.click(screen.getByRole('button', { name: '다시 연결' }));
  await ready();
  fireEvent.click(screen.getByRole('treeitem', { name: 'demo 프로젝트' }));
  fireEvent.click(screen.getByRole('tab', { name: '이력' }));
  expect(document.querySelector('.history-event-trigger')).toHaveAttribute('data-event-sequence', '300');
  expect(document.querySelector('.observation-history')?.scrollTop).toBe(0);
});

it('restores a deleted-container incident into an already mounted project history', async () => {
  const { observed } = incidentFixture();
  const many = { ...observed, sequence: 402, events: Array.from({ length: 401 }, (_, index) => ({ ...observed.events[0]!, sequence: index + 1 })) };
  const next = deferred<ObservationRead>();
  vi.mocked(observationApi.configure).mockResolvedValue(many); vi.mocked(observationApi.read).mockReturnValue(next.promise);
  render(<App />); await ready();
  fireEvent.click(screen.getByRole('treeitem', { name: 'demo 프로젝트' }));
  fireEvent.click(screen.getByRole('tab', { name: '이력' }));
  fireEvent.click(screen.getByRole('button', { name: '이전 기록' }));
  expect(document.querySelector('.history-event-trigger')).toHaveAttribute('data-event-sequence', '201');
  fireEvent.click(screen.getByRole('treeitem', { name: 'web 상세' }));
  fireEvent.click(screen.getByRole('tab', { name: '이력' }));
  fireEvent.click(document.querySelector('.history-event-trigger')!);
  await screen.findByRole('button', { name: '사건 상세 닫기' });
  const history = document.querySelector<HTMLElement>('.observation-history')!;
  history.scrollTop = 95; fireEvent.scroll(history);
  fireEvent.click(screen.getByRole('button', { name: '현재 진단' }));
  await waitFor(() => expect(screen.getByRole('tab', { name: '상태 진단' })).toHaveAttribute('aria-selected', 'true'));
  await waitFor(() => expect(observationApi.read).toHaveBeenCalled(), { timeout: 2000 });
  await act(async () => next.resolve({ ...many, sequence: 403, inventory: { ...inventory(2), containers: [] } }));
  expect(document.querySelector('.history-event-trigger')).toHaveAttribute('data-event-sequence', '201');
  fireEvent.click(screen.getByRole('button', { name: '사건으로 돌아가기' }));
  expect(document.querySelector('[data-event-sequence="401"]')).toHaveFocus();
  expect(document.querySelector('.incident-detail')).toHaveAttribute('data-incident-sequence', '401');
  expect(document.querySelector('.observation-history')?.scrollTop).toBe(95);
});
