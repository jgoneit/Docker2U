import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import App from './App';
import { api, type Container, type ContainerList, type Environment } from './api';
import { observationApi, projectLogApi, type ObservationRead } from './observationApi';
import { installSnapshotStreams } from './test/snapshotStreams';

vi.mock('./api', async importOriginal => ({ ...await importOriginal<typeof import('./api')>(), api: { getEnvironment: vi.fn(), listContainers: vi.fn(), getRecentLogs: vi.fn(), startLogStream: vi.fn(), readLogStream: vi.fn(), stopLogStream: vi.fn(), getContainerStats: vi.fn(), getContainerDetails: vi.fn(), mutateContainer: vi.fn(), mutateContainers: vi.fn() } }));
vi.mock('./observationApi', async importOriginal => ({ ...await importOriginal<typeof import('./observationApi')>(), observationApi: { available: vi.fn(() => true), configure: vi.fn(), read: vi.fn(), hold: vi.fn(), release: vi.fn() }, projectLogApi: { configure: vi.fn(), query: vi.fn(), retry: vi.fn(), stop: vi.fn() } }));
const mock = vi.mocked(api);
const container: Container = { handle: 'ha-1', fullId: 'a'.repeat(64), shortId: 'a'.repeat(12), name: 'web', composeProject: 'demo', composeService: 'web', state: 'running', health: 'healthy', image: 'web', ports: [], createdAt: '' };
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
