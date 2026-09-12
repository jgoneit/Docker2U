import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import App from './App';
import { api, type Container, type ContainerList, type Environment } from './api';
import { observationApi, projectLogApi, type ObservationRead, type ProjectLogPage } from './observationApi';
import { logRowsText } from './ProjectLogs';

vi.mock('./api', async original => ({ ...await original<typeof import('./api')>(), api: {
  getEnvironment: vi.fn(), listContainers: vi.fn(), getRecentLogs: vi.fn(), startLogStream: vi.fn(),
  readLogStream: vi.fn(), stopLogStream: vi.fn(), getContainerStats: vi.fn(), getContainerDetails: vi.fn(),
  mutateContainer: vi.fn(), mutateContainers: vi.fn(),
} }));
vi.mock('./observationApi', async original => ({ ...await original<typeof import('./observationApi')>(),
  observationApi: { available: vi.fn(), configure: vi.fn(), read: vi.fn(), hold: vi.fn(), release: vi.fn() },
  projectLogApi: { configure: vi.fn(), query: vi.fn(), retry: vi.fn(), stop: vi.fn() },
}));
const container: Container = { handle: 'web-1', fullId: 'a'.repeat(64), shortId: 'a'.repeat(12), name: 'web', composeProject: 'demo', composeService: 'web', state: 'running', health: null, image: 'fixture', ports: [], createdAt: '' };
const inventory: ContainerList = { sessionId: 'one', generation: 1, containers: [container], refreshedAt: '2026-09-12T00:00:00Z', stale: false };
const observation: ObservationRead = { sessionId: 'one', sequence: 1, scope: { kind: 'all' }, inventory, resources: [], events: [], resourceTruncated: false, eventTruncated: false, inventoryError: null, statsError: null, eventError: null, eventStatus: 'following' };
const page: ProjectLogPage = { sessionId: 'one', project: 'demo', revision: 2, maxSequence: 2, totalRows: 2, offset: 0, droppedRows: 0, needsSelection: false, error: null, retainedFrom: '2026-09-12T00:00:00Z', retainedTo: '2026-09-12T00:00:01Z',
  sources: [{ sourceId: container.fullId, fullId: container.fullId, containerName: 'web', serviceName: 'web', selected: true, status: 'following', error: null, droppedRows: 0 }],
  rows: [0, 1].map(index => ({ rowId: `r${index}`, sequence: index + 1, sourceId: container.fullId, fullId: container.fullId, serviceName: 'web', containerName: 'web', timestamp: '2026-09-12T00:00:00.123456789Z', receivedAt: '2026-09-12T00:00:00Z', pipe: 'stdout', text: `line ${index}`, truncated: false })),
};
const write = vi.fn<(text: string) => Promise<void>>();
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const click = (element: HTMLElement) => act(async () => { element.focus(); fireEvent.click(element); });
const footerFeedback = () => screen.getByRole('contentinfo').querySelector<HTMLElement>('.clipboard-feedback')!;
const modalFeedback = () => screen.getByRole('dialog').querySelector<HTMLElement>('.project-log-copy-feedback')!;
function deferred() { let resolve!: () => void, reject!: (error: Error) => void; const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function mount(target: 'project' | 'container' = 'project') {
  render(<App />); await advance(0);
  if (target === 'project') await click(screen.getByRole('treeitem', { name: 'demo 프로젝트' }));
  expect(screen.getByRole('log')).toHaveTextContent('line 1');
}

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-12T00:00:00Z')); vi.resetAllMocks();
  localStorage.setItem('docker2u.preferences.v1', JSON.stringify({ theme: 'dark', language: 'ko' }));
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: write } });
  write.mockResolvedValue();
  vi.mocked(api.getEnvironment).mockResolvedValue({ status: 'ready', sessionId: 'one', contextName: 'fixture', endpoint: 'unix:///fixture.sock', engineId: 'one', mutationAllowed: true, error: null, diagnostics: [] } as unknown as Environment);
  vi.mocked(api.listContainers).mockResolvedValue(inventory);
  vi.mocked(observationApi.available).mockReturnValue(true);
  vi.mocked(observationApi.configure).mockResolvedValue(observation);
  vi.mocked(observationApi.read).mockResolvedValue(observation);
  vi.mocked(projectLogApi.configure).mockResolvedValue(page);
  vi.mocked(projectLogApi.query).mockResolvedValue(page);
  vi.mocked(projectLogApi.stop).mockResolvedValue();
});
afterEach(() => vi.useRealTimers());

it.each(['project', 'container'] as const)('copies the %s displayed window through the shared footer without changing the log view', async target => {
  await mount(target);
  await click(screen.getByRole('button', { name: '화면 일시정지' }));
  fireEvent.change(screen.getByRole('searchbox', { name: '로그 키워드 검색' }), { target: { value: 'line' } });
  await advance(0);
  const viewport = screen.getByRole('log'); viewport.scrollTop = 123;
  const configured = vi.mocked(projectLogApi.configure).mock.calls.length;
  await click(screen.getByRole('button', { name: '현재 표시 구간 복사' }));
  expect(write).toHaveBeenCalledExactlyOnceWith(logRowsText(page.rows));
  const footer = footerFeedback(), text = footer.querySelector('.copy-feedback-text');
  expect(footer).toHaveTextContent('표시된 로그 복사됨');
  expect(footer).toHaveClass('copy-feedback-success', 'copy-feedback-highlighted');
  await advance(1_999); expect(footer).toHaveClass('copy-feedback-highlighted');
  await advance(1); expect(footer).not.toHaveClass('copy-feedback-highlighted');
  expect(footer.querySelector('.copy-feedback-text')).toBe(text);
  expect(footer).toHaveTextContent('표시된 로그 복사됨');
  expect(screen.getByRole('log')).toBe(viewport); expect(viewport.scrollTop).toBe(123);
  expect(screen.getByRole('searchbox', { name: '로그 키워드 검색' })).toHaveValue('line');
  expect(screen.getByRole('button', { name: '화면 재개' })).toHaveAttribute('aria-pressed', 'true');
  expect(projectLogApi.configure).toHaveBeenCalledTimes(configured);
  expect(projectLogApi.stop).not.toHaveBeenCalled();
});

it.each(['success', 'error'] as const)('shares the %s feedback and original deadline when expanding, closing and reopening logs', async outcome => {
  await mount();
  if (outcome === 'error') write.mockRejectedValue(new Error('Clipboard denied'));
  await click(screen.getByRole('button', { name: '현재 표시 구간 복사' }));
  await advance(750);
  await click(screen.getByRole('button', { name: '로그 확대' }));
  const message = outcome === 'success' ? '표시된 로그 복사됨' : '클립보드에 복사하지 못했습니다.';
  expect(modalFeedback()).toHaveTextContent(message);
  expect(modalFeedback()).toHaveClass(`copy-feedback-${outcome}`, 'copy-feedback-highlighted');
  expect(modalFeedback().querySelector<HTMLElement>('.copy-feedback-glow')!.style.animationDelay).toBe('-750ms');
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  await advance(250);
  await click(screen.getByRole('button', { name: '로그 확대' }));
  expect(modalFeedback().querySelector<HTMLElement>('.copy-feedback-glow')!.style.animationDelay).toBe('-1000ms');
  await advance(1_000);
  expect(modalFeedback()).not.toHaveClass('copy-feedback-highlighted');
  expect(footerFeedback()).not.toHaveClass('copy-feedback-highlighted');
  expect(modalFeedback()).toHaveTextContent(message);
  expect(footerFeedback()).toHaveTextContent(message);
});

it('restarts the shared glow for a repeated expanded copy and ignores an older clipboard failure', async () => {
  await mount();
  await click(screen.getByRole('button', { name: '로그 확대' }));
  const copy = within(screen.getByRole('dialog')).getByRole('button', { name: '현재 표시 구간 복사' });
  const earlier = deferred();
  write.mockReturnValueOnce(earlier.promise).mockResolvedValue();
  await click(copy); await click(copy);
  const firstGlow = modalFeedback().querySelector('.copy-feedback-glow');
  await act(async () => earlier.reject(new Error('Older attempt failed')));
  expect(modalFeedback()).toHaveTextContent('표시된 로그 복사됨');
  expect(modalFeedback().querySelector('.copy-feedback-glow')).toBe(firstGlow);
  await advance(1_500); await click(copy);
  const repeatedGlow = modalFeedback().querySelector('.copy-feedback-glow');
  expect(repeatedGlow).not.toBe(firstGlow);
  await advance(500); expect(modalFeedback().querySelector('.copy-feedback-glow')).toBe(repeatedGlow);
  await advance(1_499); expect(footerFeedback()).toHaveClass('copy-feedback-highlighted');
  await advance(1); expect(modalFeedback().querySelector('.copy-feedback-glow')).toBeNull();
  expect(modalFeedback()).toHaveTextContent('표시된 로그 복사됨');
  expect(copy).toHaveFocus();
});

it('keeps the last copy feedback when moving from the project to its container and opening expanded logs', async () => {
  await mount();
  await click(screen.getByRole('button', { name: '현재 표시 구간 복사' }));
  await advance(500);
  await click(screen.getByRole('treeitem', { name: 'web 상세' }));
  await click(screen.getByRole('button', { name: '로그 확대' }));
  expect(modalFeedback()).toHaveTextContent('표시된 로그 복사됨');
  expect(modalFeedback().querySelector<HTMLElement>('.copy-feedback-glow')!.style.animationDelay).toBe('-500ms');
  await advance(1_500);
  expect(modalFeedback()).not.toHaveClass('copy-feedback-highlighted');
  expect(modalFeedback()).toHaveTextContent('표시된 로그 복사됨');
  expect(projectLogApi.configure).toHaveBeenCalledOnce();
  expect(projectLogApi.stop).not.toHaveBeenCalled();
});

it('discards a pending project copy after reconnect while retaining the previous footer message', async () => {
  await mount();
  await click(screen.getByRole('button', { name: '현재 표시 구간 복사' }));
  await advance(2_000);
  const text = footerFeedback().querySelector('.copy-feedback-text'), pending = deferred();
  write.mockReturnValueOnce(pending.promise);
  await click(screen.getByRole('button', { name: '현재 표시 구간 복사' }));
  await click(screen.getByRole('button', { name: '다시 연결' }));
  await act(async () => pending.reject(new Error('Previous view clipboard failure')));
  expect(footerFeedback().querySelector('.copy-feedback-text')).toBe(text);
  expect(footerFeedback()).toHaveTextContent('표시된 로그 복사됨');
  expect(footerFeedback()).not.toHaveClass('copy-feedback-highlighted');
  expect(api.mutateContainer).not.toHaveBeenCalled(); expect(api.mutateContainers).not.toHaveBeenCalled();
});
