import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import App from './App';
import { api, type ContainerDetails, type ContainerList, type MutationResult } from './api';
import { containerDetailsFixture, detailsContainer } from './test/containerDetailsFixture';
import { installSnapshotStreams } from './test/snapshotStreams';

vi.mock('./api', async original => ({ ...await original<typeof import('./api')>(), api: {
  getEnvironment: vi.fn(), listContainers: vi.fn(), getRecentLogs: vi.fn(), startLogStream: vi.fn(), readLogStream: vi.fn(),
  stopLogStream: vi.fn(), getContainerStats: vi.fn(), getContainerDetails: vi.fn(), mutateContainer: vi.fn(), mutateContainers: vi.fn(),
} }));
const mock = vi.mocked(api);
const database = { ...detailsContainer, ports: ['0.0.0.0:15432->5432/tcp'] };
const worker = { ...database, name: 'worker', fullId: 'b'.repeat(64), shortId: 'b'.repeat(12), handle: 'details-b' };
const rows = [database, worker];
const success: MutationResult = { outcome: 'succeeded', message: 'fixture success', command: 'fixture start', stderr: '', reconciliation: 'notNeeded', mutationBlocked: false };
const clock = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const click = (element: HTMLElement) => act(async () => { element.focus(); fireEvent.click(element); });
const change = (element: HTMLElement, value: string) => act(async () => { fireEvent.change(element, { target: { value } }); });
const notification = () => within(screen.getByRole('contentinfo')).getByRole('status', { name: '작업 알림' });
const recent = () => within(screen.getByRole('contentinfo')).getByRole('button', { name: '최근 작업 결과 상세 보기' });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (value: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function mount() { userEvent.setup(); render(<App />); await clock(); expect(screen.getByRole('button', { name: 'database 상세' })).toBeVisible(); }

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-08T12:00:00Z')); vi.resetAllMocks();
  localStorage.setItem('docker2u.preferences.v1', JSON.stringify({ theme: 'dark', language: 'ko' }));
  installSnapshotStreams(mock);
  mock.getEnvironment.mockResolvedValue({ status: 'ready', sessionId: 'one', contextName: 'fixture', endpoint: 'unix:///fixture.sock', dockerPath: '/fixture/docker', dockerConfigPath: '/fixture/config', clientVersion: '1', serverVersion: '1', apiVersion: '1', engineId: 'engine-one', osType: 'linux', architecture: 'arm64', mutationAllowed: true, error: null, diagnostics: [] });
  let generation = 0;
  mock.listContainers.mockImplementation(async sessionId => ({ sessionId, generation: ++generation, containers: rows, refreshedAt: new Date().toISOString(), stale: false }));
  mock.getRecentLogs.mockImplementation(async (sessionId, handle) => ({ sessionId, generation, handle, text: 'service ready\nsearch target', truncated: false, byteCount: 27, command: 'fixture logs', stderr: '' }));
  mock.getContainerDetails.mockImplementation(async (sessionId, version, handle) => containerDetailsFixture(rows.find(row => row.handle === handle)!, { sessionId, generation: version, containers: rows, stale: false, refreshedAt: '' }));
  mock.mutateContainer.mockResolvedValue(success);
});
afterEach(() => vi.useRealTimers());

it('loads one selected detail lazily, shares it across tabs, and keeps operation checkboxes independent of a port shortcut', async () => {
  await mount();
  expect(mock.getContainerDetails).not.toHaveBeenCalled();
  await click(screen.getByRole('checkbox', { name: 'database 작업 대상으로 선택' }));
  await click(screen.getByRole('tab', { name: '상태 진단' }));
  expect(mock.getContainerDetails).toHaveBeenCalledExactlyOnceWith('one', 1, database.handle);
  expect(screen.getByText('종료 코드 137만으로 메모리 부족을 확정할 수 없습니다.')).toBeVisible();
  await click(screen.getByRole('tab', { name: '접속 정보' }));
  expect(mock.getContainerDetails).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: '주소 복사: 127.0.0.1:15432' })).toBeVisible();
  await click(screen.getByRole('button', { name: 'worker 접속 정보 보기' }));
  expect(screen.getByRole('button', { name: 'worker 상세' })).toHaveAttribute('aria-current', 'true');
  expect(screen.getByRole('checkbox', { name: 'database 작업 대상으로 선택' })).toBeChecked();
  expect(screen.getByRole('checkbox', { name: 'worker 작업 대상으로 선택' })).not.toBeChecked();
  expect(screen.getByRole('tab', { name: '접속 정보' })).toHaveAttribute('aria-selected', 'true');
  expect(mock.getContainerDetails).toHaveBeenLastCalledWith('one', 1, worker.handle);
});

it('preserves the mounted log view and does not intercept search while the log tab is hidden', async () => {
  const running = { ...database, state: 'running' };
  mock.listContainers.mockResolvedValue({ sessionId: 'one', generation: 1, containers: [running, worker], refreshedAt: new Date().toISOString(), stale: false });
  mock.getRecentLogs.mockResolvedValue({ sessionId: 'one', generation: 1, handle: running.handle, text: 'service ready\nsearch target', truncated: false, byteCount: 27, command: 'fixture logs', stderr: '' });
  await mount();
  await click(screen.getByRole('button', { name: '일시정지' }));
  await click(screen.getByRole('button', { name: '로그 검색 열기' }));
  await change(screen.getByRole('searchbox', { name: '로그 검색' }), 'target');
  const log = screen.getByLabelText('최근 로그 내용');
  log.scrollTop = 90; fireEvent.scroll(log);
  const streams = mock.startLogStream.mock.calls.length;
  await click(screen.getByRole('tab', { name: '상태 진단' }));
  expect(log).not.toBeVisible();
  const shortcut = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true });
  act(() => { document.dispatchEvent(shortcut); });
  expect(shortcut.defaultPrevented).toBe(false);
  await click(screen.getByRole('tab', { name: '로그' }));
  expect(screen.getByLabelText('최근 로그 내용')).toBe(log);
  expect(log.scrollTop).toBe(90);
  expect(screen.getByRole('searchbox', { name: '로그 검색' })).toHaveValue('target');
  expect(screen.getByRole('button', { name: '재개' })).toHaveAttribute('aria-pressed', 'true');
  expect(mock.startLogStream).toHaveBeenCalledTimes(streams);
});

it('discards an old target response and reloads active details after Refresh', async () => {
  const pending = deferred<ContainerDetails>();
  mock.getContainerDetails.mockReturnValueOnce(pending.promise);
  await mount();
  await click(screen.getByRole('tab', { name: '접속 정보' }));
  await click(screen.getByRole('button', { name: 'worker 상세' }));
  expect(screen.queryByText('127.0.0.1:15432')).not.toBeInTheDocument();
  const old = containerDetailsFixture(database, { sessionId: 'one', generation: 1, containers: rows, stale: false, refreshedAt: '' });
  old.connectivity.ports[0]!.bindings = [{ hostIp: '127.0.0.1', hostPort: 19999 }];
  await act(async () => pending.resolve(old));
  expect(screen.queryByText('127.0.0.1:19999')).not.toBeInTheDocument();
  expect(mock.getContainerDetails).toHaveBeenLastCalledWith('one', 1, worker.handle);
  await click(screen.getByRole('button', { name: '새로고침' }));
  expect(mock.getContainerDetails).toHaveBeenLastCalledWith('one', 2, worker.handle);
});

it('starts the success deadline after final Refresh, hides only the summary, and restores focus after closing details', async () => {
  await mount();
  const pending = deferred<ContainerList>();
  mock.listContainers.mockReturnValueOnce(pending.promise);
  await click(screen.getByRole('button', { name: '시작' }));
  expect(notification()).toHaveTextContent('처리 및 상태 확인 중');
  expect(screen.queryByRole('region', { name: '최근 단일 작업 결과' })).not.toBeInTheDocument();
  await clock(6000);
  expect(notification()).toHaveTextContent('처리 및 상태 확인 중');
  await act(async () => pending.resolve({ sessionId: 'one', generation: 2, containers: rows, refreshedAt: new Date().toISOString(), stale: false }));
  expect(notification()).toHaveTextContent('성공');
  await clock(4999); expect(notification()).toHaveTextContent('성공');
  await clock(1); expect(notification()).toBeEmptyDOMElement();
  await click(recent());
  expect(screen.getByText('성공 · 시작 · database')).toBeVisible();
  expect(screen.getByRole('button', { name: '최근 작업 결과 상세 닫기' })).toHaveFocus();
  await click(screen.getByRole('button', { name: '최근 작업 결과 상세 닫기' }));
  expect(recent()).toHaveFocus();
  expect(mock.mutateContainer).toHaveBeenCalledTimes(1);
});

it('keeps a failed final state check persistent and independent of clipboard feedback', async () => {
  await mount();
  mock.listContainers.mockRejectedValueOnce({ code: 'TimedOut', message: 'inventory timed out' });
  await click(screen.getByRole('button', { name: '시작' }));
  await clock(6000);
  expect(notification()).toHaveTextContent('목록 확인 실패');
  await click(screen.getByText('컨테이너 정보'));
  await click(screen.getByRole('button', { name: '전체 ID 복사' }));
  expect(notification()).toHaveTextContent('목록 확인 실패');
  expect(screen.getByRole('contentinfo').querySelector('.clipboard-feedback')).toHaveTextContent('복사됨');
  await click(screen.getByRole('button', { name: '작업 알림 닫기' }));
  expect(notification()).toBeEmptyDOMElement();
  expect(screen.getByRole('button', { name: '시작' })).toBeDisabled();
  await click(recent());
  expect(screen.getByText('작업 후 목록을 갱신하지 못했습니다. 최신 상태를 다시 확인하세요.')).toBeVisible();
});

it('dismisses an unknown result without releasing connection gates and reopens it from expanded logs', async () => {
  await mount();
  mock.mutateContainer.mockResolvedValueOnce({ ...success, outcome: 'resultUnknown', reconciliation: 'failed', mutationBlocked: true });
  await click(screen.getByRole('button', { name: '시작' }));
  await click(screen.getByRole('button', { name: '작업 알림 닫기' }));
  expect(screen.getByRole('button', { name: '시작' })).toBeDisabled();
  await click(screen.getByRole('button', { name: '로그 확대 보기' }));
  const dialog = within(screen.getByRole('dialog'));
  await click(dialog.getByRole('button', { name: '최근 작업 결과 상세 보기' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByText('결과 불명 · 시작 · database')).toBeVisible();
  expect(screen.getByRole('button', { name: '최근 작업 결과 상세 닫기' })).toHaveFocus();
  expect(screen.getByRole('button', { name: '시작' })).toBeDisabled();
});
