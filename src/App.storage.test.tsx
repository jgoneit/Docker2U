import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import App from './App';
import { api, type ContainerList, type Environment } from './api';
import { composeApi, type ComposeOperation } from './composeApi';
import { mountApi, mountKey } from './mountApi';
import { observationApi, projectLogApi, type ObservationRead, type ProjectLogPage } from './observationApi';
import { containerDetailsFixture } from './test/containerDetailsFixture';
import { storageContainer, storageFixture, storageOther, storageSnapshot, volumeMount } from './test/storageFixtures';

vi.mock('./api', async original => ({ ...await original<typeof import('./api')>(), api: {
  getEnvironment: vi.fn(), listContainers: vi.fn(), getRecentLogs: vi.fn(), startLogStream: vi.fn(),
  readLogStream: vi.fn(), stopLogStream: vi.fn(), getContainerStats: vi.fn(), getContainerDetails: vi.fn(),
  mutateContainer: vi.fn(), mutateContainers: vi.fn(),
} }));
vi.mock('./observationApi', async original => ({ ...await original<typeof import('./observationApi')>(),
  observationApi: { available: vi.fn(), configure: vi.fn(), read: vi.fn(), hold: vi.fn(), release: vi.fn() },
  projectLogApi: { configure: vi.fn(), query: vi.fn(), retry: vi.fn(), stop: vi.fn() },
}));
vi.mock('./mountApi', async original => ({ ...await original<typeof import('./mountApi')>(), mountApi: { getInventory: vi.fn() } }));
vi.mock('./composeApi', async original => ({ ...await original<typeof import('./composeApi')>(), composeApi: {
  available: vi.fn(), pick: vi.fn(), list: vi.fn(), preview: vi.fn(), save: vi.fn(), remove: vi.fn(),
  prepare: vi.fn(), start: vi.fn(), operations: vi.fn(), read: vi.fn(), cancel: vi.fn(),
} }));

const primary = { ...storageContainer, state: 'running', health: 'unhealthy', healthConfigured: true };
const inventory: ContainerList = { ...storageSnapshot, containers: [primary, storageOther] };
const observation: ObservationRead = { sessionId: inventory.sessionId, sequence: 1, scope: { kind: 'all' }, inventory, resources: [], events: [], resourceTruncated: false, eventTruncated: false, inventoryError: null, statsError: null, eventError: null, eventStatus: 'following' };
const operation: ComposeOperation = { id: 'compose-job', sessionId: inventory.sessionId, projectId: 'registered-orders', projectName: 'orders', action: 'up', phase: 'finished', outcome: 'succeeded', cancelRequested: false, exitCode: 0, startedAt: '2026-09-13T00:00:00Z', finishedAt: '2026-09-13T00:00:03Z', reconciliation: 'succeeded', observedContainers: 1, error: null };
function logs(project: string): ProjectLogPage {
  const containers = inventory.containers.filter(container => container.composeProject === project);
  return { sessionId: inventory.sessionId, project, revision: 2, maxSequence: 2, totalRows: containers.length * 2, offset: 0, droppedRows: 0, needsSelection: false, error: null, retainedFrom: '2026-09-13T00:00:00Z', retainedTo: '2026-09-13T00:00:01Z',
    sources: containers.map(container => ({ sourceId: container.fullId, fullId: container.fullId, containerName: container.name, serviceName: container.composeService, selected: true, status: 'following', error: null, droppedRows: 0 })),
    rows: containers.flatMap(container => [0, 1].map(index => ({ rowId: container.fullId + '-' + index, sequence: index + 1, sourceId: container.fullId, fullId: container.fullId, serviceName: container.composeService, containerName: container.name, timestamp: '2026-09-13T00:00:00.123456789Z', receivedAt: '2026-09-13T00:00:00Z', pipe: 'stdout', text: index === 0 ? 'request=keep' : 'noise', truncated: false }))),
  };
}
const advance = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const click = (element: HTMLElement) => act(async () => { element.focus(); fireEvent.click(element); });
async function mount() {
  render(<App />); await advance();
  expect(screen.getByRole('treeitem', { name: 'database 상세' })).toBeVisible();
  expect(screen.getByRole('button', { name: '새로고침' })).toBeEnabled();
}

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-13T00:00:05Z')); vi.resetAllMocks();
  localStorage.setItem('docker2u.preferences.v1', JSON.stringify({ theme: 'dark', language: 'ko' }));
  vi.mocked(api.getEnvironment).mockResolvedValue({ status: 'ready', sessionId: inventory.sessionId, contextName: 'fixture', endpoint: 'unix:///fixture.sock', engineId: 'one', mutationAllowed: true, error: null, diagnostics: [] } as unknown as Environment);
  vi.mocked(api.listContainers).mockResolvedValue(inventory);
  vi.mocked(api.getContainerDetails).mockImplementation(async (sessionId, generation, handle) => {
    const container = inventory.containers.find(item => item.handle === handle)!;
    const result = containerDetailsFixture(container, { ...inventory, sessionId, generation });
    return { ...result, diagnostics: { ...result.diagnostics, state: container.state } };
  });
  vi.mocked(observationApi.available).mockReturnValue(true);
  vi.mocked(observationApi.configure).mockResolvedValue(observation); vi.mocked(observationApi.read).mockResolvedValue(observation);
  vi.mocked(projectLogApi.configure).mockImplementation(async (_sessionId, project) => logs(project));
  vi.mocked(projectLogApi.query).mockImplementation(async (_sessionId, project, query) => {
    const page = logs(project);
    const rows = page.rows.filter(row => row.text.includes(query.keyword) && (!query.sourceIds.length || query.sourceIds.includes(row.sourceId)) && (query.throughSequence === null || row.sequence <= query.throughSequence));
    return { ...page, rows, totalRows: rows.length };
  });
  vi.mocked(projectLogApi.stop).mockResolvedValue();
  vi.mocked(mountApi.getInventory).mockResolvedValue(storageFixture(inventory));
  vi.mocked(composeApi.available).mockReturnValue(true); vi.mocked(composeApi.list).mockResolvedValue([]); vi.mocked(composeApi.operations).mockResolvedValue([]);
  vi.mocked(composeApi.read).mockResolvedValue({ operation, text: '', oldestSequence: 1, nextSequence: 0, truncated: false });
});
afterEach(() => vi.useRealTimers());

it('opens project storage and navigates to the exact stopped shared consumer with its matching mount highlighted', async () => {
  await mount();
  await click(screen.getByRole('treeitem', { name: 'orders 프로젝트' }));
  expect(mountApi.getInventory).not.toHaveBeenCalled();
  await click(screen.getByRole('tab', { name: '저장소' })); await advance();
  const panel = screen.getByRole('region', { name: '저장소 연결' });
  expect(panel.querySelectorAll('.storage-mount')).toHaveLength(1);
  await click(within(panel).getByText('사용 컨테이너 2개 보기'));
  const sharing = panel.querySelector('.storage-sharing')!;
  expect(sharing).toHaveTextContent('backup'); expect(sharing).toHaveTextContent('backups / backup'); expect(sharing).toHaveTextContent('중지됨');
  await click(within(sharing as HTMLElement).getByRole('button', { name: 'backup 저장소로 이동' })); await advance();
  expect(screen.getByRole('treeitem', { name: 'backup 상세' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('treeitem', { name: 'database 상세' })).toHaveAttribute('aria-selected', 'false');
  expect(screen.getByRole('tab', { name: '저장소' })).toHaveAttribute('aria-selected', 'true');
  const highlighted = screen.getByRole('region', { name: '저장소 연결' }).querySelector('.storage-mount[data-highlighted="true"]');
  expect(highlighted).toHaveTextContent('/backup/source');
  expect(mountKey(volumeMount, storageOther.fullId, 0)).toBe(mountKey(volumeMount, primary.fullId, 0));
  expect(mountApi.getInventory).toHaveBeenCalledExactlyOnceWith(inventory.sessionId, false);
  expect(api.mutateContainer).not.toHaveBeenCalled(); expect(api.mutateContainers).not.toHaveBeenCalled();
  await click(screen.getByRole('tab', { name: '로그' })); await advance();
  fireEvent.keyDown(screen.getByRole('tab', { name: '로그' }), { key: 'End' });
  fireEvent.keyDown(screen.getByRole('tab', { name: '이력' }), { key: 'ArrowLeft' });
  const storageTab = screen.getByRole('tab', { name: '저장소' });
  expect(storageTab).toHaveFocus();
  // A native button's Enter activation emits click; preserve the keyboard-moved focus.
  fireEvent.keyDown(storageTab, { key: 'Enter' }); fireEvent.click(storageTab); await advance();
  expect(storageTab).toHaveAttribute('aria-selected', 'true'); expect(storageTab).toHaveFocus();
  fireEvent.keyDown(storageTab, { key: 'ArrowRight' });
  expect(screen.getByRole('tab', { name: '이력' })).toHaveFocus();
});

it('retains the project log filter, paused position and subscription across a storage tab round trip', async () => {
  await mount(); await click(screen.getByRole('treeitem', { name: 'orders 프로젝트' }));
  fireEvent.change(screen.getByRole('searchbox', { name: '로그 키워드 검색' }), { target: { value: 'request=' } }); await advance();
  await click(screen.getByRole('button', { name: '화면 일시정지' })); await advance();
  const viewport = screen.getByRole('log'); const frozenPosition = viewport.scrollTop;
  const configured = vi.mocked(projectLogApi.configure).mock.calls.length;
  const stopped = vi.mocked(projectLogApi.stop).mock.calls.length;
  const frozen = viewport.textContent;
  await click(screen.getByRole('tab', { name: '저장소' })); await advance();
  expect(screen.getByRole('region', { name: '저장소 연결' })).toBeVisible();
  await click(screen.getByRole('tab', { name: '통합 로그' })); await advance();
  expect(screen.getByRole('searchbox', { name: '로그 키워드 검색' })).toHaveValue('request=');
  expect(screen.getByRole('button', { name: '화면 재개' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('log')).toBe(viewport); expect(viewport.scrollTop).toBe(frozenPosition); expect(viewport.textContent).toBe(frozen);
  expect(projectLogApi.configure).toHaveBeenCalledTimes(configured); expect(projectLogApi.stop).toHaveBeenCalledTimes(stopped);
  await click(screen.getByRole('tab', { name: '저장소' })); await advance();
  expect(mountApi.getInventory).toHaveBeenCalledTimes(1);
});

it.each(['logs', 'diagnostics'] as const)('navigates from Compose progress to the actual container %s tab and transfers focus', async tab => {
  vi.mocked(composeApi.operations).mockResolvedValue([operation]);
  await mount();
  await click(screen.getByRole('treeitem', { name: 'backup 상세' }));
  await click(screen.getByRole('button', { name: '최근 프로젝트 작업' })); await advance();
  const dialog = screen.getByRole('dialog', { name: '프로젝트 작업' });
  expect(within(dialog).getByRole('status')).toHaveTextContent('명령 실행 완료');
  expect(within(dialog).getByText('비정상')).toBeVisible();
  const label = tab === 'logs' ? 'database 로그 보기' : 'database 진단 보기';
  await click(within(dialog).getByRole('button', { name: label })); await advance();
  expect(screen.queryByRole('dialog', { name: '프로젝트 작업' })).not.toBeInTheDocument();
  expect(screen.getByRole('treeitem', { name: 'database 상세' })).toHaveAttribute('aria-selected', 'true');
  const destination = screen.getByRole('tab', { name: tab === 'logs' ? '로그' : '상태 진단' });
  expect(destination).toHaveAttribute('aria-selected', 'true'); expect(destination).toHaveFocus();
  if (tab === 'logs') {
    expect(screen.getByRole('log')).toHaveTextContent('request=keep');
    expect(projectLogApi.query).toHaveBeenLastCalledWith(inventory.sessionId, 'orders', expect.objectContaining({ sourceIds: [primary.fullId] }));
  } else expect(api.getContainerDetails).toHaveBeenCalledExactlyOnceWith(inventory.sessionId, inventory.generation, primary.handle);
  expect(composeApi.start).not.toHaveBeenCalled(); expect(composeApi.cancel).not.toHaveBeenCalled();
});
