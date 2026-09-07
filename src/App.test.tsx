import { installSnapshotStreams } from './test/snapshotStreams';
import { StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { api } from './api';
import type { Action, BulkMutationResult, Container, ContainerList, Environment, MutationResult, RecentLogs } from './api';

vi.mock('./api', async importOriginal => ({
  ...await importOriginal<typeof import('./api')>(),
  api: { getEnvironment: vi.fn(), listContainers: vi.fn(), getRecentLogs: vi.fn(), startLogStream: vi.fn(), readLogStream: vi.fn(), stopLogStream: vi.fn(), getContainerStats: vi.fn(), mutateContainer: vi.fn(), mutateContainers: vi.fn() },
}));
const mock = vi.mocked(api);
const actionName = (action: string) => ({ Start: '시작', Stop: '중지', Restart: '재시작' } as Record<string, string>)[action] ?? action;
const recovery = () => within(screen.getByRole('region', { name: '서비스 복구' }));
const environment: Environment = {
  status: 'ready', sessionId: 'session-1', contextName: 'colima-docker2u', endpoint: 'unix:///Users/test/.colima/docker2u/docker.sock',
  dockerPath: '/opt/homebrew/bin/docker', dockerConfigPath: '/Users/test/.docker', clientVersion: '29.8.0',
  serverVersion: '29.8.0', apiVersion: '1.54', engineId: 'engine-1', osType: 'linux', architecture: 'aarch64', mutationAllowed: true, error: null, diagnostics: [],
};
const backend: Container = { handle: 'handle-1', fullId: 'a'.repeat(64), shortId: 'a'.repeat(12), name: 'backend', image: 'company-api:1', state: 'running', health: 'healthy', ports: ['127.0.0.1:8080->8080/tcp'], composeProject: null, composeService: null, createdAt: '2026-09-05T03:00:00Z' };
const redis: Container = { ...backend, handle: 'handle-2', fullId: 'b'.repeat(64), shortId: 'b'.repeat(12), name: 'redis', image: 'redis:7', state: 'exited', health: 'none', ports: [] };
function list(generation = 1, containers = [backend, redis], sessionId = 'session-1'): ContainerList {
  return { sessionId, generation, containers: containers.map(container => ({ ...container, handle: `${container.handle}-g${generation}` })), refreshedAt: '2026-09-05T04:20:00Z', stale: false };
}
function log(sessionId: string, handle: string, text = 'service ready', overrides: Partial<RecentLogs> = {}): RecentLogs {
  return { sessionId, handle, generation: Number(handle.split('-g').at(-1)) || 1, text, truncated: false, byteCount: text.length, command: 'docker --host unix:///fixed container logs --tail 300 target', stderr: '', ...overrides };
}
const succeeded: MutationResult = { outcome: 'succeeded', message: '명령이 완료되었습니다.', command: 'docker --host unix:///fixed container start target', stderr: '', reconciliation: 'notNeeded', mutationBlocked: false, exitCode: 0, durationMs: 200, observedState: null };
function batch(action: Action, containers = list().containers, overrides: Partial<BulkMutationResult> = {}): BulkMutationResult {
  return { sessionId: 'session-1', generation: 1, action, mutationBlocked: false, items: containers.map(container => {
    const allowed = action === 'start' ? ['created', 'exited'].includes(container.state) : container.state === 'running';
    return { handle: container.handle, fullId: container.fullId, name: container.name, outcome: allowed ? 'succeeded' : 'skipped', message: allowed ? '명령이 완료되었습니다.' : '현재 상태에서는 작업할 수 없습니다.', result: allowed ? succeeded : null };
  }), ...overrides };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}
async function connected() {
  await screen.findByRole('button', { name: /backend/ });
  await waitFor(() => expect(screen.getByRole('button', { name: '새로고침' })).toBeEnabled());
}
async function confirmBulkWithKeyboard(user: ReturnType<typeof userEvent.setup>, action: 'Stop' | 'Restart') {
  screen.getByRole('checkbox', { name: '보이는 컨테이너 전체 선택' }).focus();
  await user.keyboard(' ');
  const trigger = screen.getByRole('button', { name: `${actionName(action)} (1)` });
  trigger.focus();
  await user.keyboard('{Enter}');
  const dialog = within(screen.getByRole('dialog', { name: `컨테이너 1개 ${actionName(action)} 확인` }));
  expect(dialog.getByRole('button', { name: '취소' })).toHaveFocus();
  await user.tab();
  expect(dialog.getByRole('button', { name: `${actionName(action)} 확인` })).toHaveFocus();
  await user.keyboard('{Enter}');
  return trigger;
}
beforeEach(() => {
  vi.resetAllMocks();
  installSnapshotStreams(mock);
  localStorage.setItem('docker2u.preferences.v1', JSON.stringify({ theme: 'dark', language: 'ko' }));
  let generation = 0;
  mock.getEnvironment.mockResolvedValue(environment);
  mock.listContainers.mockImplementation(async sessionId => list(++generation, [backend, redis], sessionId));
  mock.getRecentLogs.mockImplementation(async (sessionId, handle) => log(sessionId, handle));
  mock.mutateContainer.mockResolvedValue(succeeded);
  mock.mutateContainers.mockImplementation(async (sessionId, generation, handles, action) => batch(action, list(generation).containers.filter(container => handles.includes(container.handle)), { sessionId, generation }));
});

describe('bulk selection and recovery', () => {
  it('keeps checkbox selection separate from detail selection and supports Space', async () => {
    const user = userEvent.setup();
    render(<App />);
    await connected();
    const checkbox = screen.getByRole('checkbox', { name: 'redis 작업 대상으로 선택' });
    checkbox.focus();
    await user.keyboard(' ');
    expect(checkbox).toBeChecked();
    expect(screen.getByRole('button', { name: 'backend 상세' })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('checkbox', { name: '보이는 컨테이너 전체 선택' })).toBePartiallyChecked();
    expect(screen.getByRole('button', { name: '시작 (1)' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '중지 (0)' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'redis 상세' }));
    expect(checkbox).toBeChecked();
    expect(screen.getByRole('button', { name: 'redis 상세' })).toHaveAttribute('aria-current', 'true');
    await user.click(screen.getByRole('button', { name: '선택 해제' }));
    expect(checkbox).not.toBeChecked();
    expect(screen.queryByRole('button', { name: /시작 \(/ })).not.toBeInTheDocument();
  });
  it('selects only visible containers and clears selection after search and filter changes', async () => {
    const user = userEvent.setup();
    render(<App />);
    await connected();
    const all = screen.getByRole('checkbox', { name: '보이는 컨테이너 전체 선택' });
    await user.click(all);
    expect(all).toBeChecked();
    expect(screen.getByText('2개 선택')).toBeVisible();
    await user.type(screen.getByRole('textbox', { name: '컨테이너 검색' }), 'redis');
    expect(all).not.toBeChecked();
    expect(screen.queryByText('2개 선택')).not.toBeInTheDocument();
    await user.click(all);
    expect(screen.getByText('1개 선택')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '시작 (1)' }));
    await waitFor(() => expect(mock.mutateContainers).toHaveBeenCalledExactlyOnceWith('session-1', 1, ['handle-2-g1'], 'start'));
    await waitFor(() => expect(screen.getByRole('button', { name: '새로고침' })).toBeEnabled());
    expect(all).not.toBeChecked();
    await user.clear(screen.getByRole('textbox', { name: '컨테이너 검색' }));
    await user.click(all);
    await user.click(screen.getByRole('button', { name: '실행 중' }));
    expect(all).not.toBeChecked();
    expect(screen.queryByText('2개 선택')).not.toBeInTheDocument();
    await user.click(all);
    expect(screen.getByRole('button', { name: '시작 (0)' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '중지 (1)' })).toBeEnabled();
  });
  it('clears checked targets at refresh start, including a failed refresh, and on reconnect', async () => {
    const user = userEvent.setup();
    render(<App />);
    await connected();
    await user.click(screen.getByRole('checkbox', { name: '보이는 컨테이너 전체 선택' }));
    const pending = deferred<ContainerList>();
    mock.listContainers.mockReturnValueOnce(pending.promise);
    await user.click(screen.getByRole('button', { name: '새로고침' }));
    expect(screen.getByRole('checkbox', { name: 'redis 작업 대상으로 선택' })).not.toBeChecked();
    await act(async () => pending.reject({ code: 'MalformedOutput', message: 'list failed' }));
    expect(screen.getByRole('checkbox', { name: 'redis 작업 대상으로 선택' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '다시 연결' }));
    await connected();
    await user.click(screen.getByRole('checkbox', { name: '보이는 컨테이너 전체 선택' }));
    await user.click(screen.getByRole('button', { name: '다시 연결' }));
    await connected();
    expect(screen.getByRole('checkbox', { name: '보이는 컨테이너 전체 선택' })).not.toBeChecked();
  });
  it('counts compatible states and exposes each excluded target and reason', async () => {
    const user = userEvent.setup();
    const paused = { ...redis, fullId: 'c'.repeat(64), shortId: 'c'.repeat(12), handle: 'handle-3', name: 'worker', state: 'paused' };
    mock.listContainers.mockResolvedValueOnce(list(1, [backend, redis, paused]));
    render(<App />);
    await connected();
    await user.click(screen.getByRole('checkbox', { name: '보이는 컨테이너 전체 선택' }));
    expect(screen.getByText('3개 선택')).toBeVisible();
    expect(screen.getByRole('button', { name: '시작 (1)' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '중지 (1)' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '재시작 (1)' })).toBeEnabled();
    await user.click(screen.getByText('작업별 제외 대상과 이유'));
    const bulk = within(screen.getByRole('region', { name: '컨테이너 일괄 제어' }));
    expect(bulk.getByRole('heading', { name: '시작 · 2개 제외' })).toBeVisible();
    expect(bulk.getByText('일시 중지 상태 · 생성됨 / 중지됨에서만 시작 가능')).toBeVisible();
    expect(bulk.getByText('중지됨 상태 · 실행 중일 때만 중지 가능')).toBeVisible();
  });
  it.each(['Stop', 'Restart'])('confirms bulk %s once with all targets, exclusions and restored focus', async actionLabel => {
    const user = userEvent.setup();
    render(<App />);
    await connected();
    await user.click(screen.getByRole('checkbox', { name: '보이는 컨테이너 전체 선택' }));
    const trigger = screen.getByRole('button', { name: `${actionName(actionLabel)} (1)` });
    screen.getByRole('button', { name: '새로고침' }).focus();
    fireEvent.click(trigger);
    const dialog = within(screen.getByRole('dialog', { name: `컨테이너 1개 ${actionName(actionLabel)} 확인` }));
    expect(dialog.getByText('실행 대상 · 1개')).toBeVisible();
    expect(dialog.getByText('제외 대상 · 1개')).toBeVisible();
    expect(dialog.getByText(backend.fullId)).toBeVisible();
    expect(dialog.getByText(redis.fullId)).toBeVisible();
    expect(dialog.getByText('colima-docker2u')).toBeVisible();
    expect(dialog.getByText(environment.endpoint!)).toBeVisible();
    expect(dialog.getByText(environment.engineId!)).toBeVisible();
    const cancel = dialog.getByRole('button', { name: '취소' });
    expect(cancel).toHaveFocus();
    await user.tab({ shift: true });
    expect(dialog.getByRole('button', { name: `${actionName(actionLabel)} 확인` })).toHaveFocus();
    await user.tab();
    expect(cancel).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(trigger).toHaveFocus();
    expect(mock.mutateContainers).not.toHaveBeenCalled();
    await user.click(trigger);
    await user.click(screen.getByRole('button', { name: `${actionName(actionLabel)} 확인` }));
    await waitFor(() => expect(mock.mutateContainers).toHaveBeenCalledExactlyOnceWith('session-1', 1, ['handle-1-g1', 'handle-2-g1'], actionLabel.toLowerCase()));
  });
  it('sends all checked handles in list order immediately for Start and locks all execution controls', async () => {
    const user = userEvent.setup();
    const pending = deferred<BulkMutationResult>();
    mock.mutateContainers.mockReturnValueOnce(pending.promise);
    render(<App />);
    await connected();
    // Select in the opposite order to prove that execution order follows the list.
    await user.click(screen.getByRole('checkbox', { name: 'redis 작업 대상으로 선택' }));
    await user.click(screen.getByRole('checkbox', { name: 'backend 작업 대상으로 선택' }));
    const start = screen.getByRole<HTMLButtonElement>('button', { name: '시작 (1)' });
    const refresh = screen.getByRole<HTMLButtonElement>('button', { name: '새로고침' });
    const reconnect = screen.getByRole<HTMLButtonElement>('button', { name: '다시 연결' });
    const singleStop = recovery().getByRole<HTMLButtonElement>('button', { name: '중지' });
    act(() => { start.click(); start.click(); refresh.click(); reconnect.click(); singleStop.click(); });
    expect(mock.mutateContainers).toHaveBeenCalledExactlyOnceWith('session-1', 1, ['handle-1-g1', 'handle-2-g1'], 'start');
    expect(mock.mutateContainer).not.toHaveBeenCalled();
    expect(mock.listContainers).toHaveBeenCalledTimes(1);
    expect(mock.getEnvironment).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    for (const name of ['새로고침', '다시 연결', '시작 (1)', '중지 (1)', '재시작 (1)', '전체', '선택 해제']) expect(screen.getByRole('button', { name })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: '컨테이너 검색' })).toBeDisabled();
    screen.getAllByRole('checkbox').forEach(checkbox => expect(checkbox).toBeDisabled());
    expect(recovery().getByRole('button', { name: '중지' })).toBeDisabled();
    expect(screen.getByText('시작 · 1개 대상 순서대로 처리 및 상태 재조회 중…')).toBeVisible();
    await act(async () => pending.resolve(batch('start')));
    expect(await screen.findByRole('region', { name: '최근 일괄 작업 결과' })).toBeVisible();
    expect(mock.listContainers).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(refresh).toBeEnabled());
    expect(screen.getByRole('checkbox', { name: '보이는 컨테이너 전체 선택' })).not.toBeChecked();
  });
  it('uses the same synchronous guard when a single action starts before bulk', async () => {
    const user = userEvent.setup();
    const pending = deferred<MutationResult>();
    mock.mutateContainer.mockReturnValueOnce(pending.promise);
    render(<App />);
    await connected();
    await user.click(screen.getByRole('checkbox', { name: '보이는 컨테이너 전체 선택' }));
    await user.click(screen.getByRole('button', { name: 'redis 상세' }));
    const single = recovery().getByRole<HTMLButtonElement>('button', { name: '시작' });
    const bulk = screen.getByRole<HTMLButtonElement>('button', { name: '시작 (1)' });
    act(() => { single.click(); bulk.click(); single.click(); });
    expect(mock.mutateContainer).toHaveBeenCalledTimes(1);
    expect(mock.mutateContainers).not.toHaveBeenCalled();
    expect(screen.getByRole('checkbox', { name: 'redis 작업 대상으로 선택' })).toBeDisabled();
    await act(async () => pending.resolve(succeeded));
  });
  it('preserves every outcome across final refresh, detail selection and another refresh', async () => {
    const user = userEvent.setup();
    const containers = [backend, redis, ...['c', 'd', 'e'].map((letter, index) => ({ ...redis, fullId: letter.repeat(64), shortId: letter.repeat(12), handle: `handle-${index + 3}`, name: `worker-${index + 3}` }))];
    let generation = 0;
    mock.listContainers.mockImplementation(async () => list(++generation, containers));
    const result = batch('start', list(1, containers).containers);
    result.items[2] = { ...result.items[2]!, outcome: 'failed', message: '확정 실패', result: { ...succeeded, outcome: 'failed', reconciliation: 'succeeded', exitCode: 1 } };
    result.items[3] = { ...result.items[3]!, outcome: 'resultUnknown', message: '명령 응답 유실', result: { ...succeeded, outcome: 'resultUnknown', reconciliation: 'succeeded', observedState: 'running', mutationBlocked: true } };
    result.items[4] = { ...result.items[4]!, outcome: 'notExecuted', message: '앞선 결과 불명으로 미실행', result: null };
    result.mutationBlocked = true;
    mock.mutateContainers.mockResolvedValueOnce(result);
    render(<App />);
    await connected();
    await user.click(screen.getByRole('checkbox', { name: '보이는 컨테이너 전체 선택' }));
    await user.click(screen.getByRole('button', { name: '시작 (4)' }));
    const report = within(await screen.findByRole('region', { name: '최근 일괄 작업 결과' }));
    for (const label of ['성공', '실패', '결과 불명', '제외', '미실행']) expect(report.getByText(`${label} 1개`)).toBeVisible();
    await user.click(report.getByText('항목별 결과 · 5개'));
    for (const container of containers) expect(report.getByText(container.fullId)).toBeVisible();
    expect(report.getByText(/현재 상태 재조회는 원래 명령의 성공을 의미하지 않습니다/)).toBeVisible();
    await waitFor(() => expect(screen.getByRole('button', { name: '새로고침' })).toBeEnabled());
    expect(mock.listContainers).toHaveBeenCalledTimes(2);
    await user.click(screen.getByRole('button', { name: 'redis 상세' }));
    expect(report.getByText('결과 불명 1개')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '새로고침' }));
    await waitFor(() => expect(mock.listContainers).toHaveBeenCalledTimes(3));
    expect(report.getByText('결과 불명 1개')).toBeVisible();
    expect(recovery().getByRole('button', { name: '시작' })).toBeDisabled();
    expect(mock.mutateContainers).toHaveBeenCalledTimes(1);
  });
  it.each([new Error('response lost'), { code: 'WorkerFailed', message: 'worker response lost' }])('treats missing IPC replies as aggregate unknown and requires reconnect', async failure => {
    const user = userEvent.setup();
    mock.mutateContainers.mockRejectedValueOnce(failure);
    render(<App />);
    await connected();
    await user.click(screen.getByRole('checkbox', { name: '보이는 컨테이너 전체 선택' }));
    await user.click(screen.getByRole('button', { name: '시작 (1)' }));
    const report = within(await screen.findByRole('region', { name: '최근 일괄 작업 결과' }));
    expect(report.getByRole('heading', { name: '시작 · 일괄 작업 결과 불명' })).toBeVisible();
    expect(report.getByText(/개별 대상의 결과를 확정할 수 없습니다/)).toBeVisible();
    expect(report.queryByText(/성공 \d+개/)).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: '새로고침' })).toBeEnabled());
    expect(mock.listContainers).toHaveBeenCalledTimes(2);
    await user.click(screen.getByRole('button', { name: '새로고침' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '다시 연결' })).toBeEnabled());
    expect(recovery().getByRole('button', { name: '중지' })).toBeDisabled();
    expect(mock.mutateContainers).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: '다시 연결' }));
    await waitFor(() => expect(recovery().getByRole('button', { name: '중지' })).toBeEnabled());
  });
  it.each(['Busy', 'StaleHandle', 'InvalidSelection'])('recovers bulk %s rejection through Refresh and explicit reselection without retrying', async code => {
    const user = userEvent.setup();
    const refreshed = deferred<ContainerList>();
    mock.mutateContainers.mockRejectedValueOnce({ code, message: '실행 전에 요청이 거절되었습니다.' });
    render(<App />);
    await connected();
    mock.listContainers.mockReturnValueOnce(refreshed.promise);
    await user.click(screen.getByRole('checkbox', { name: '보이는 컨테이너 전체 선택' }));
    await user.click(screen.getByRole('button', { name: '시작 (1)' }));
    const report = within(await screen.findByRole('region', { name: '최근 일괄 작업 결과' }));
    expect(report.getByRole('heading', { name: '시작 · 일괄 작업 요청 거절' })).toBeVisible();
    await user.click(report.getByRole('button', { name: '결과 펼치기' }));
    expect(report.getByText(/실행 전에 요청이 거절되어 이 요청의 조작은 실행되지 않았습니다/)).toBeVisible();
    expect(report.queryByText(/성공 \d+개/)).not.toBeInTheDocument();
    expect(recovery().getByRole('button', { name: '중지' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: '보이는 컨테이너 전체 선택' })).not.toBeChecked();
    expect(mock.mutateContainers).toHaveBeenCalledExactlyOnceWith('session-1', 1, ['handle-1-g1', 'handle-2-g1'], 'start');
    await act(async () => refreshed.resolve(list(2)));
    await waitFor(() => expect(recovery().getByRole('button', { name: '중지' })).toBeEnabled());
    expect(report.getByText('새로고침 후 대상을 다시 선택하세요.')).toBeVisible();
    expect(report.queryByText(/재연결|다시 연결/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '시작 (1)' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: '보이는 컨테이너 전체 선택' }));
    expect(screen.getByRole('button', { name: '시작 (1)' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '중지 (1)' })).toBeEnabled();
    expect(mock.mutateContainers).toHaveBeenCalledTimes(1);
    expect(mock.getEnvironment).toHaveBeenCalledTimes(1);
    expect(mock.listContainers).toHaveBeenCalledTimes(2);
  });
  it('keeps a recoverable bulk rejection stale only until a failed final Refresh later succeeds', async () => {
    const user = userEvent.setup();
    mock.mutateContainers.mockRejectedValueOnce({ code: 'StaleHandle', message: '목록 세대가 변경되었습니다.' });
    render(<App />);
    await connected();
    mock.listContainers.mockRejectedValueOnce({ code: 'TimedOut', message: '마지막 목록 조회 시간 초과' });
    await user.click(screen.getByRole('checkbox', { name: '보이는 컨테이너 전체 선택' }));
    await user.click(screen.getByRole('button', { name: '시작 (1)' }));
    expect(await screen.findByText('오래된 정보 · 마지막 정상 목록입니다.')).toBeVisible();
    expect(screen.getByRole('checkbox', { name: '보이는 컨테이너 전체 선택' })).toBeDisabled();
    expect(recovery().getByRole('button', { name: '중지' })).toBeDisabled();
    const report = within(screen.getByRole('region', { name: '최근 일괄 작업 결과' }));
    await user.click(report.getByRole('button', { name: '결과 펼치기' }));
    expect(report.getByText('새로고침 후 대상을 다시 선택하세요.')).toBeVisible();
    expect(report.queryByText(/재연결|다시 연결/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '새로고침' }));
    await waitFor(() => expect(recovery().getByRole('button', { name: '중지' })).toBeEnabled());
    expect(screen.queryByText('오래된 정보 · 마지막 정상 목록입니다.')).not.toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'redis 작업 대상으로 선택' }));
    expect(screen.getByRole('button', { name: '시작 (1)' })).toBeEnabled();
    expect(mock.getEnvironment).toHaveBeenCalledTimes(1);
    expect(mock.mutateContainers).toHaveBeenCalledTimes(1);
  });
  it.each(['NeedsValidation', 'StaleSession'])('keeps bulk %s rejection latched through successful Refresh until Reconnect', async code => {
    const user = userEvent.setup();
    mock.mutateContainers.mockRejectedValueOnce({ code, message: '연결 재검증이 필요합니다.' });
    render(<App />);
    await connected();
    await user.click(screen.getByRole('checkbox', { name: '보이는 컨테이너 전체 선택' }));
    await user.click(screen.getByRole('button', { name: '시작 (1)' }));
    const report = within(await screen.findByRole('region', { name: '최근 일괄 작업 결과' }));
    expect(report.getByRole('heading', { name: '시작 · 일괄 작업 요청 거절' })).toBeVisible();
    expect(report.getByText('이 작업 뒤 연결 재확인이 필요해졌습니다. 재연결해도 이 작업 결과는 바뀌지 않습니다.')).toBeVisible();
    await waitFor(() => expect(screen.getByRole('button', { name: '새로고침' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: '새로고침' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '새로고침' })).toBeEnabled());
    await user.click(screen.getByRole('checkbox', { name: '보이는 컨테이너 전체 선택' }));
    expect(screen.getByRole('button', { name: '시작 (1)' })).toBeDisabled();
    expect(recovery().getByRole('button', { name: '중지' })).toBeDisabled();
    expect(mock.mutateContainers).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: '다시 연결' }));
    await waitFor(() => expect(recovery().getByRole('button', { name: '중지' })).toBeEnabled());
    expect(screen.getByRole('region', { name: '최근 일괄 작업 결과' })).toBeVisible();
  });
  it('retains a reconciled bulk ResultUnknown warning without requiring Reconnect or retrying', async () => {
    const user = userEvent.setup();
    const result = batch('start', [list().containers[1]!]);
    result.items[0] = { ...result.items[0]!, outcome: 'resultUnknown', message: '명령 응답 유실', result: { ...succeeded, outcome: 'resultUnknown', reconciliation: 'succeeded', observedState: 'running' } };
    mock.mutateContainers.mockResolvedValueOnce(result);
    render(<App />);
    await connected();
    await user.click(screen.getByRole('checkbox', { name: 'redis 작업 대상으로 선택' }));
    await user.click(screen.getByRole('button', { name: '시작 (1)' }));
    const report = await screen.findByRole('region', { name: '최근 일괄 작업 결과' });
    expect(report).toHaveClass('outcome-resultUnknown');
    expect(within(report).getByText('결과 불명 1개')).toBeVisible();
    await user.click(within(report).getByText('항목별 결과 · 1개'));
    expect(within(report).getByText(/대상 상태 재조회 완료 · 실행 중/)).toBeVisible();
    expect(within(report).queryByText(/재연결|다시 연결/)).not.toBeInTheDocument();
    await waitFor(() => expect(recovery().getByRole('button', { name: '중지' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: '새로고침' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '새로고침' })).toBeEnabled());
    await user.click(screen.getByRole('checkbox', { name: 'redis 작업 대상으로 선택' }));
    expect(screen.getByRole('button', { name: '시작 (1)' })).toBeEnabled();
    expect(within(report).getByText('결과 불명 1개')).toBeVisible();
    expect(mock.mutateContainers).toHaveBeenCalledTimes(1);
    expect(mock.getEnvironment).toHaveBeenCalledTimes(1);
  });
  it.each(['session', 'generation', 'action', 'fullId', 'missingItem', 'duplicateItem', 'outcome', 'missingResult', 'observedState'] as const)('rejects a bulk reply with incorrect %s binding', async kind => {
    const user = userEvent.setup();
    const result = batch('start');
    if (kind === 'session') result.sessionId = 'old-session';
    if (kind === 'generation') result.generation = 0;
    if (kind === 'action') result.action = 'restart';
    if (kind === 'fullId') result.items[0]!.fullId = 'f'.repeat(64);
    if (kind === 'missingItem') result.items.pop();
    if (kind === 'duplicateItem') result.items[1] = result.items[0]!;
    if (kind === 'outcome') result.items[1]!.outcome = 'failed';
    if (kind === 'missingResult') result.items[1]!.result = null;
    if (kind === 'observedState') result.items[1]!.result = { ...succeeded, reconciliation: 'succeeded', observedState: { invalid: true } as unknown as string };
    mock.mutateContainers.mockResolvedValueOnce(result);
    render(<App />);
    await connected();
    await user.click(screen.getByRole('checkbox', { name: '보이는 컨테이너 전체 선택' }));
    await user.click(screen.getByRole('button', { name: '시작 (1)' }));
    expect(await screen.findByRole('heading', { name: '시작 · 일괄 작업 결과 불명' })).toBeVisible();
    await user.click(screen.getByText('진단 상세 · INVALID_BULK_RESPONSE'));
    expect(screen.getByText(/요청 대상과 일치하는 전체 일괄 응답/)).toBeVisible();
    await waitFor(() => expect(screen.getByRole('button', { name: '새로고침' })).toBeEnabled());
    expect(recovery().getByRole('button', { name: '중지' })).toBeDisabled();
    expect(mock.mutateContainers).toHaveBeenCalledTimes(1);
  });
});

describe('confirmed bulk focus recovery', () => {
  it.each(['Stop', 'Restart'] as const)('restores keyboard %s focus only after mutation and final Refresh finish without selecting or retrying', async action => {
    const user = userEvent.setup();
    const mutation = deferred<BulkMutationResult>();
    const finalRefresh = deferred<ContainerList>();
    mock.mutateContainers.mockReturnValueOnce(mutation.promise);
    render(<App />);
    await connected();
    mock.listContainers.mockReturnValueOnce(finalRefresh.promise);
    const all = screen.getByRole('checkbox', { name: '보이는 컨테이너 전체 선택' });
    const region = screen.getByRole('region', { name: '컨테이너 일괄 제어' });
    const trigger = await confirmBulkWithKeyboard(user, action);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(all).toBeDisabled();
    expect(all).not.toHaveFocus();
    expect(region).not.toHaveFocus();
    expect(trigger).not.toHaveFocus();
    expect(mock.mutateContainers).toHaveBeenCalledExactlyOnceWith('session-1', 1, ['handle-1-g1', 'handle-2-g1'], action.toLowerCase());
    await act(async () => mutation.resolve(batch(action.toLowerCase() as Action)));
    expect(mock.listContainers).toHaveBeenCalledTimes(2);
    expect(all).toBeDisabled();
    expect(all).not.toBeChecked();
    expect(all).not.toHaveFocus();
    expect(region).not.toHaveFocus();
    await act(async () => finalRefresh.resolve(list(2)));
    await waitFor(() => expect(all).toHaveFocus());
    expect(all).toBeEnabled();
    screen.getAllByRole('checkbox').forEach(checkbox => expect(checkbox).not.toBeChecked());
    expect(screen.queryByRole('button', { name: `${actionName(action)} (1)` })).not.toBeInTheDocument();
    expect(mock.mutateContainers).toHaveBeenCalledTimes(1);
    expect(mock.mutateContainer).not.toHaveBeenCalled();
  });
  it.each(['empty', 'failed'] as const)('focuses the bulk region when the final Refresh is %s', async outcome => {
    const user = userEvent.setup();
    const finalRefresh = deferred<ContainerList>();
    render(<App />);
    await connected();
    mock.listContainers.mockReturnValueOnce(finalRefresh.promise);
    await confirmBulkWithKeyboard(user, 'Stop');
    const region = screen.getByRole('region', { name: '컨테이너 일괄 제어' });
    expect(region).not.toHaveFocus();
    await act(async () => {
      if (outcome === 'empty') finalRefresh.resolve(list(2, []));
      else finalRefresh.reject({ code: 'TimedOut', message: '최종 목록 확인 실패' });
    });
    await waitFor(() => expect(region).toHaveFocus());
    expect(region).toHaveAttribute('tabindex', '-1');
    const all = screen.getByRole('checkbox', { name: '보이는 컨테이너 전체 선택' });
    expect(all).toBeDisabled();
    expect(all).not.toBeChecked();
    expect(mock.mutateContainers).toHaveBeenCalledTimes(1);
    expect(mock.mutateContainer).not.toHaveBeenCalled();
  });
  it.each([
    { name: 'recoverable preflight', failure: { code: 'Busy', message: '다른 작업 실행 중' }, blocked: false },
    { name: 'required validation', failure: { code: 'NeedsValidation', message: '환경 재검증 필요' }, blocked: true },
    { name: 'lost IPC response', failure: new Error('response lost'), blocked: true },
  ])('restores selection focus after $name without changing the action gate', async ({ failure, blocked }) => {
    const user = userEvent.setup();
    const finalRefresh = deferred<ContainerList>();
    mock.mutateContainers.mockRejectedValueOnce(failure);
    render(<App />);
    await connected();
    mock.listContainers.mockReturnValueOnce(finalRefresh.promise);
    await confirmBulkWithKeyboard(user, 'Restart');
    const all = screen.getByRole('checkbox', { name: '보이는 컨테이너 전체 선택' });
    expect(all).toBeDisabled();
    expect(all).not.toHaveFocus();
    await act(async () => finalRefresh.resolve(list(2)));
    await waitFor(() => expect(all).toHaveFocus());
    expect(all).toBeEnabled();
    expect(all).not.toBeChecked();
    expect(recovery().getByRole('button', { name: '중지' }).hasAttribute('disabled')).toBe(blocked);
    expect(mock.mutateContainers).toHaveBeenCalledTimes(1);
    expect(mock.getEnvironment).toHaveBeenCalledTimes(1);
  });
  it.each(['diagnostics', 'summary'] as const)('preserves focus the user moves to %s while the bulk operation is pending', async destination => {
    const user = userEvent.setup();
    const mutation = deferred<BulkMutationResult>();
    const finalRefresh = deferred<ContainerList>();
    mock.mutateContainers.mockReturnValueOnce(mutation.promise);
    render(<App />);
    await connected();
    mock.listContainers.mockReturnValueOnce(finalRefresh.promise);
    await confirmBulkWithKeyboard(user, 'Stop');
    let chosen: HTMLElement;
    if (destination === 'diagnostics') {
      chosen = screen.getByRole('button', { name: '환경 진단 보기' });
      await user.click(chosen);
      expect(chosen).toHaveFocus();
      await act(async () => mutation.resolve(batch('stop')));
    } else {
      await act(async () => mutation.resolve(batch('stop')));
      chosen = screen.getByText('항목별 결과 · 2개');
      chosen.focus();
      expect(chosen).toHaveFocus();
    }
    await act(async () => finalRefresh.resolve(list(2)));
    await waitFor(() => expect(screen.getByRole('button', { name: '새로고침' })).toBeEnabled());
    expect(chosen).toHaveFocus();
    expect(screen.getByRole('checkbox', { name: '보이는 컨테이너 전체 선택' })).not.toBeChecked();
    expect(mock.mutateContainers).toHaveBeenCalledTimes(1);
  });
  it('does not transfer pending focus restoration into a remounted App', async () => {
    const user = userEvent.setup();
    const oldRefresh = deferred<ContainerList>();
    const first = render(<App />);
    await connected();
    mock.listContainers.mockReturnValueOnce(oldRefresh.promise);
    await confirmBulkWithKeyboard(user, 'Stop');
    expect(mock.listContainers).toHaveBeenCalledTimes(2);
    first.unmount();
    mock.getEnvironment.mockResolvedValueOnce({ ...environment, sessionId: 'new-session' });
    mock.listContainers.mockResolvedValueOnce(list(1, [backend, redis], 'new-session'));
    render(<App />);
    await connected();
    const chosen = screen.getByRole('button', { name: '환경 진단 보기' });
    await user.click(chosen);
    await act(async () => oldRefresh.resolve(list(2)));
    expect(chosen).toHaveFocus();
    expect(screen.getByRole('checkbox', { name: '보이는 컨테이너 전체 선택' })).not.toHaveFocus();
    expect(screen.queryByRole('region', { name: '최근 일괄 작업 결과' })).not.toBeInTheDocument();
    expect(mock.mutateContainers).toHaveBeenCalledTimes(1);
    expect(mock.listContainers).toHaveBeenCalledTimes(3);
  });
});

describe('environment and inventory', () => {
  it('opens exactly one environment session in StrictMode and renders real response state', async () => {
    render(<StrictMode><App /></StrictMode>);
    await connected();
    expect(mock.getEnvironment).toHaveBeenCalledTimes(1);
    expect(mock.listContainers).toHaveBeenCalledWith('session-1');
    expect(screen.getByRole('heading', { name: 'Docker2U' })).toBeVisible();
    expect(within(screen.getByRole('region', { name: '컨테이너 상세' })).getByText('정상')).toBeVisible();
    expect(screen.getByText(/목록 갱신 시각/)).not.toBeVisible();
    fireEvent.click(screen.getByText('컨테이너 정보'));
    expect(screen.getByText(/목록 갱신 시각/)).toBeVisible();
    expect(within(screen.getByRole('table', { name: '컨테이너 목록' })).queryByRole('button', { name: '중지' })).not.toBeInTheDocument();
  });
  it.each([
    ['CliNotFound', 'Docker CLI를 확인할 수 없습니다.'],
    ['Configuration', 'Docker 설정을 읽지 못했습니다.'],
    ['ContextSelection', 'Docker 연결 대상을 해석하지 못했습니다.'],
    ['SocketMissing', '로컬 Docker 소켓을 확인할 수 없습니다.'],
    ['PermissionDenied', 'Docker 연결 권한이 부족합니다.'],
    ['RemoteEndpoint', '원격 Docker 연결은 지원하지 않습니다.'],
    ['EndpointMismatch', '안전한 로컬 Docker 소켓이 아닙니다.'],
    ['UnsupportedRuntime', '지원하는 로컬 환경이 아닙니다.'],
    ['MalformedOutput', 'Docker 응답 형식이 호환되지 않습니다.'],
    ['EnvironmentChanged', '연결 환경이 변경되었습니다.'],
    ['CommandFailed', '로컬 환경에 연결하지 못했습니다.'],
  ] as const)('uses structured %s errors even before the Docker path is available', async (code, title) => {
    mock.getEnvironment.mockResolvedValue({ ...environment, status: 'unavailable', dockerPath: null, sessionId: null, mutationAllowed: false, error: { code, message: '실패한 검사 내용', command: 'docker context inspect', stderr: 'context error detail' }, diagnostics: ['환경을 준비한 뒤 다시 시도하세요.'] });
    render(<App />);
    expect(await screen.findByRole('heading', { name: title })).toBeVisible();
    expect(mock.listContainers).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '새로고침' })).toBeDisabled();
    expect(screen.getByText('환경을 준비한 뒤 다시 시도하세요.')).not.toBeVisible();
    fireEvent.click(screen.getByText('원문 진단'));
    expect(screen.getByText('환경을 준비한 뒤 다시 시도하세요.')).toBeVisible();
    fireEvent.click(screen.getByText(`진단 상세 · ${code}`));
    expect(screen.getByText('실패한 검사 내용')).toBeVisible();
    expect(screen.getByText('docker context inspect')).toBeVisible();
    expect(screen.getByText('context error detail')).toBeVisible();
    expect(screen.queryByText(/daemon.*중지|Colima의 docker2u/)).not.toBeInTheDocument();
  });
  it('keeps unknown connection failures generic when no structured cause exists', async () => {
    mock.getEnvironment.mockResolvedValue({ ...environment, status: 'unavailable', dockerPath: null, sessionId: null, mutationAllowed: false, error: null });
    render(<App />);
    expect(await screen.findByRole('heading', { name: '로컬 환경에 연결하지 못했습니다.' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Docker CLI를 확인할 수 없습니다.' })).not.toBeInTheDocument();
  });
  it.each(['default', 'desktop-linux', null])('shows the CLI context %s and selected endpoint without a runtime fallback', async contextName => {
    mock.getEnvironment.mockResolvedValueOnce({ ...environment, contextName, endpoint: 'unix:///Users/test/.docker/run/docker.sock' });
    render(<App />);
    await connected();
    const connection = within(screen.getByRole('region', { name: '연결 환경' }));
    expect(connection.getByText(contextName ?? 'Context 확인 전')).toBeVisible();
    expect(connection.getByText(contextName ?? 'Context 확인 전')).toHaveAttribute('title', 'unix:///Users/test/.docker/run/docker.sock');
    expect(screen.queryByText('새로고침은 현재 연결 갱신 · 다시 연결은 CLI 설정 다시 적용')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '환경 진단 보기' }));
    expect(screen.getByText('새로고침은 현재 연결 갱신 · 다시 연결은 CLI 설정 다시 적용')).toBeVisible();
    expect(screen.getByText('unix:///Users/test/.docker/run/docker.sock')).toBeVisible();
    expect(screen.queryByText('colima-docker2u')).not.toBeInTheDocument();
  });
  it('renders a recoverable transport failure and reconnects', async () => {
    const user = userEvent.setup();
    mock.getEnvironment.mockRejectedValueOnce({ code: 'NativeRequired', message: '앱에서 연결하세요.' });
    render(<App />);
    await user.click(await screen.findByText('진단 상세 · NativeRequired'));
    expect(screen.getByText('앱에서 연결하세요.')).toBeVisible();
    await user.click(within(screen.getByRole('region', { name: '연결 환경' })).getByRole('button', { name: '다시 연결' }));
    await connected();
    expect(mock.getEnvironment).toHaveBeenCalledTimes(2);
  });
  it('distinguishes empty inventory from no search results and searches ports', async () => {
    const user = userEvent.setup();
    render(<App />);
    await connected();
    await user.type(screen.getByRole('textbox', { name: '컨테이너 검색' }), '8080');
    expect(within(screen.getByRole('table', { name: '컨테이너 목록' })).getAllByRole('button')).toHaveLength(1);
    expect(within(screen.getByRole('table', { name: '컨테이너 목록' })).getByRole('button')).toHaveTextContent('backend');
    await user.clear(screen.getByRole('textbox', { name: '컨테이너 검색' }));
    await user.type(screen.getByRole('textbox'), 'missing');
    expect(screen.getByText('검색 결과가 없습니다.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '검색·필터 초기화' }));
    await user.click(within(screen.getByLabelText('컨테이너 필터')).getByRole('button', { name: '중지' }));
    expect(within(screen.getByRole('table', { name: '컨테이너 목록' })).getAllByRole('button')).toHaveLength(1);
    expect(within(screen.getByRole('table', { name: '컨테이너 목록' })).getByRole('button')).toHaveTextContent('redis');
    mock.listContainers.mockResolvedValueOnce(list(2, []));
    await user.click(screen.getByRole('button', { name: '새로고침' }));
    expect(await screen.findByRole('heading', { name: '아직 컨테이너가 없습니다.' })).toBeVisible();
    expect(screen.getByText('현재 Engine에 컨테이너가 없습니다.')).toBeVisible();
  });
  it('moves selection and focus with arrows, Home, and End', async () => {
    const user = userEvent.setup();
    render(<App />);
    await connected();
    const first = screen.getByRole('button', { name: /backend/ });
    first.focus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('button', { name: /redis/ })).toHaveFocus();
    expect(screen.getByRole('button', { name: /redis/ })).toHaveAttribute('aria-current', 'true');
    expect(recovery().getByRole('button', { name: '시작' })).toBeEnabled();
    await user.keyboard('{Home}');
    expect(first).toHaveFocus();
    await user.keyboard('{End}{ArrowUp}');
    expect(first).toHaveFocus();
  });
  it('preserves the last complete list on refresh failure and blocks actions until a newer snapshot', async () => {
    const user = userEvent.setup();
    render(<App />);
    await connected();
    mock.listContainers.mockRejectedValueOnce({ code: 'MalformedOutput', message: '전체 목록을 해석하지 못했습니다.' });
    await user.click(screen.getByRole('button', { name: '새로고침' }));
    expect(await screen.findByText('오래된 정보 · 마지막 정상 목록입니다.')).toBeVisible();
    expect(within(screen.getByRole('table', { name: '컨테이너 목록' })).getAllByRole('button')).toHaveLength(2);
    expect(recovery().getByRole('button', { name: '중지' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '로그 조회' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '새로고침' }));
    await waitFor(() => expect(screen.queryByText('오래된 정보 · 마지막 정상 목록입니다.')).not.toBeInTheDocument());
    expect(recovery().getByRole('button', { name: '중지' })).toBeEnabled();
  });
  it('blocks reconnect during a pending refresh and reconnects after it succeeds', async () => {
    const user = userEvent.setup();
    render(<App />);
    await connected();
    const pending = deferred<ContainerList>();
    mock.listContainers.mockReturnValueOnce(pending.promise);
    const refreshButton = screen.getByRole('button', { name: '새로고침' });
    const reconnectButton = screen.getByRole('button', { name: '다시 연결' });
    await user.click(refreshButton);
    expect(refreshButton).toBeDisabled();
    expect(reconnectButton).toBeDisabled();
    await user.click(refreshButton);
    await user.click(reconnectButton);
    expect(mock.getEnvironment).toHaveBeenCalledTimes(1);
    expect(mock.listContainers).toHaveBeenCalledTimes(2);
    expect(within(screen.getByRole('table', { name: '컨테이너 목록' })).getAllByRole('button')).toHaveLength(2);
    expect(screen.getByRole('button', { name: /backend/ })).toBeVisible();
    expect(screen.getByRole('button', { name: /redis/ })).toBeVisible();
    expect(recovery().getByRole('button', { name: '중지' })).toBeDisabled();
    await act(async () => { pending.resolve(list(2, [{ ...backend, name: 'refreshed-container' }])); });
    expect(screen.getByRole('button', { name: /refreshed-container/ })).toBeVisible();
    expect(reconnectButton).toBeEnabled();
    mock.getEnvironment.mockResolvedValueOnce({ ...environment, sessionId: 'session-2' });
    mock.listContainers.mockResolvedValueOnce(list(1, [{ ...redis, name: 'new-session-container' }], 'session-2'));
    await user.click(reconnectButton);
    expect(await screen.findByRole('button', { name: /new-session-container/ })).toBeVisible();
    expect(mock.getEnvironment).toHaveBeenCalledTimes(2);
    expect(mock.listContainers).toHaveBeenCalledTimes(3);
    expect(mock.listContainers).toHaveBeenLastCalledWith('session-2');
  });
  it.each([
    { code: 'MalformedOutput', message: '전체 목록을 해석하지 못했습니다.' },
    { code: 'TimedOut', message: '목록 조회 시간이 초과되었습니다.' },
  ])('reenables reconnect after a pending refresh rejects with $code', async failure => {
    const user = userEvent.setup();
    render(<App />);
    await connected();
    const pending = deferred<ContainerList>();
    mock.listContainers.mockReturnValueOnce(pending.promise);
    const refreshButton = screen.getByRole('button', { name: '새로고침' });
    const reconnectButton = screen.getByRole('button', { name: '다시 연결' });
    await user.click(refreshButton);
    expect(refreshButton).toBeDisabled();
    expect(reconnectButton).toBeDisabled();
    await user.click(refreshButton);
    await user.click(reconnectButton);
    expect(mock.getEnvironment).toHaveBeenCalledTimes(1);
    expect(mock.listContainers).toHaveBeenCalledTimes(2);
    expect(within(screen.getByRole('table', { name: '컨테이너 목록' })).getAllByRole('button')).toHaveLength(2);
    expect(screen.getByRole('button', { name: /backend/ })).toBeVisible();
    expect(screen.getByRole('button', { name: /redis/ })).toBeVisible();
    await act(async () => { pending.reject(failure); });
    await user.click(screen.getByText(`진단 상세 · ${failure.code}`));
    expect(screen.getByText(failure.message)).toBeVisible();
    expect(screen.getByText('오래된 정보 · 마지막 정상 목록입니다.')).toBeVisible();
    expect(within(screen.getByRole('table', { name: '컨테이너 목록' })).getAllByRole('button')).toHaveLength(2);
    expect(refreshButton).toBeEnabled();
    expect(reconnectButton).toBeEnabled();
    mock.getEnvironment.mockResolvedValueOnce({ ...environment, sessionId: 'session-2' });
    mock.listContainers.mockResolvedValueOnce(list(1, [{ ...redis, name: 'new-session-container' }], 'session-2'));
    await user.click(reconnectButton);
    expect(await screen.findByRole('button', { name: /new-session-container/ })).toBeVisible();
    expect(mock.getEnvironment).toHaveBeenCalledTimes(2);
    expect(mock.listContainers).toHaveBeenCalledTimes(3);
    expect(mock.listContainers).toHaveBeenLastCalledWith('session-2');
    expect(screen.queryByText('오래된 정보 · 마지막 정상 목록입니다.')).not.toBeInTheDocument();
  });
  it('guards immediate reconnect and duplicate refresh clicks before React disables the buttons', async () => {
    render(<App />);
    await connected();
    const pending = deferred<ContainerList>();
    mock.listContainers.mockReturnValueOnce(pending.promise);
    const refreshButton = screen.getByRole<HTMLButtonElement>('button', { name: '새로고침' });
    const reconnectButton = screen.getByRole<HTMLButtonElement>('button', { name: '다시 연결' });
    act(() => {
      refreshButton.click();
      // Native clicks share one React batch, so only the refs can stop these requests.
      expect(refreshButton).toBeEnabled();
      expect(reconnectButton).toBeEnabled();
      reconnectButton.click();
      refreshButton.click();
    });
    expect(mock.getEnvironment).toHaveBeenCalledTimes(1);
    expect(mock.listContainers).toHaveBeenCalledTimes(2);
    expect(within(screen.getByRole('table', { name: '컨테이너 목록' })).getAllByRole('button')).toHaveLength(2);
    expect(screen.getByRole('button', { name: /backend/ })).toBeVisible();
    expect(screen.getByRole('button', { name: /redis/ })).toBeVisible();
    expect(reconnectButton).toBeDisabled();
    await act(async () => { pending.resolve(list(2)); });
    expect(reconnectButton).toBeEnabled();
  });
  it('rejects stale generations without replacing the last successful snapshot', async () => {
    const user = userEvent.setup();
    render(<App />);
    await connected();
    mock.listContainers.mockResolvedValueOnce(list(1, [{ ...backend, name: 'stale-generation' }]));
    await user.click(screen.getByRole('button', { name: '새로고침' }));
    expect(await screen.findByText('오래된 정보 · 마지막 정상 목록입니다.')).toBeVisible();
    expect(screen.queryByRole('button', { name: /stale-generation/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /backend/ })).toBeVisible();
  });
});

describe('container recovery policy and confirmation', () => {
  it.each([
    ['created', true, false, true], ['running', false, true, true], ['exited', true, false, true],
    ['paused', false, false, true], ['restarting', false, false, true], ['removing', false, false, false],
    ['dead', false, false, true], ['unknown', false, false, false],
  ] as const)('gates %s actions and recent logs', async (state, start, stopRestart, readable) => {
    mock.listContainers.mockResolvedValueOnce(list(1, [{ ...backend, state }]));
    render(<App />);
    await connected();
    await waitFor(() => expect(screen.getByRole('button', { name: '로그 조회' }).hasAttribute('disabled')).toBe(!readable));
    expect(recovery().getByRole('button', { name: '시작' }).hasAttribute('disabled')).toBe(!start);
    expect(recovery().getByRole('button', { name: '중지' }).hasAttribute('disabled')).toBe(!stopRestart);
    expect(recovery().getByRole('button', { name: '재시작' }).hasAttribute('disabled')).toBe(!stopRestart);
  });
  it.each(['Stop', 'Restart'])('confirms %s with the pinned target, focus trap, Escape and focus restoration', async action => {
    const user = userEvent.setup();
    render(<App />);
    await connected();
    const trigger = recovery().getByRole('button', { name: actionName(action) });
    await user.click(trigger);
    const dialog = screen.getByRole('dialog', { name: `backend ${actionName(action)} 확인` });
    expect(within(dialog).getByText('colima-docker2u')).toBeVisible();
    expect(within(dialog).getByText(environment.endpoint!)).toBeVisible();
    expect(within(dialog).getByText(environment.engineId!)).toBeVisible();
    expect(within(dialog).getByText(backend.shortId)).toBeVisible();
    const cancel = within(dialog).getByRole('button', { name: '취소' });
    const confirm = within(dialog).getByRole('button', { name: `${actionName(action)} 확인` });
    expect(cancel).toHaveFocus();
    await user.tab({ shift: true });
    expect(confirm).toHaveFocus();
    await user.tab();
    expect(cancel).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(mock.mutateContainer).not.toHaveBeenCalled();
  });
  it('sends only session, handle, and action once, and refreshes after successful mutation', async () => {
    const user = userEvent.setup();
    const mutation = deferred<MutationResult>();
    mock.mutateContainer.mockReturnValueOnce(mutation.promise);
    render(<App />);
    await connected();
    await user.click(recovery().getByRole('button', { name: '재시작' }));
    const confirm = screen.getByRole('button', { name: '재시작 확인' });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(mock.mutateContainer).toHaveBeenCalledExactlyOnceWith('session-1', 'handle-1-g1', 'restart');
    expect(recovery().getByRole('button', { name: '재시작' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '다시 연결' })).toBeDisabled();
    await act(async () => { mutation.resolve(succeeded); });
    expect(await screen.findByRole('heading', { name: /^성공 ·/ })).toBeVisible();
    expect(mock.listContainers).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(recovery().getByRole('button', { name: '재시작' })).toBeEnabled());
  });
  it('refreshes after a known failure without claiming success', async () => {
    const user = userEvent.setup();
    mock.mutateContainer.mockResolvedValueOnce({ ...succeeded, outcome: 'failed', message: 'CLI가 종료 코드 1을 반환했습니다.', stderr: 'container failure', exitCode: 1 });
    render(<App />);
    await connected();
    await user.click(screen.getByRole('button', { name: /redis/ }));
    await user.click(recovery().getByRole('button', { name: '시작' }));
    expect(await screen.findByRole('heading', { name: /^실패 ·/ })).toBeVisible();
    expect(mock.listContainers).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('heading', { name: /^성공 ·/ })).not.toBeInTheDocument();
  });
  it('keeps ResultUnknown after successful exact-target reconciliation and never retries it', async () => {
    const user = userEvent.setup();
    mock.mutateContainer.mockResolvedValueOnce({ ...succeeded, outcome: 'resultUnknown', message: '명령 응답 시간이 초과되었습니다.', reconciliation: 'succeeded', observedState: 'running' });
    render(<App />);
    await connected();
    await user.click(recovery().getByRole('button', { name: '재시작' }));
    await user.click(screen.getByRole('button', { name: '재시작 확인' }));
    expect(await screen.findByRole('heading', { name: /^결과 불명 ·/ })).toBeVisible();
    expect(screen.getByText(/대상 상태 재조회 완료 · 실행 중/)).toBeVisible();
    expect(mock.mutateContainer).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByRole('button', { name: '새로고침' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: '새로고침' }));
    expect(screen.getByRole('heading', { name: /^결과 불명 ·/ })).toBeVisible();
    expect(mock.mutateContainer).toHaveBeenCalledTimes(1);
  });
  it('keeps mutations blocked after reconciliation failure until an explicit reconnect', async () => {
    const user = userEvent.setup();
    mock.mutateContainer.mockResolvedValueOnce({ ...succeeded, outcome: 'resultUnknown', message: '연결이 중단되었습니다.', reconciliation: 'failed', mutationBlocked: true });
    render(<App />);
    await connected();
    await user.click(recovery().getByRole('button', { name: '중지' }));
    await user.click(screen.getByRole('button', { name: '중지 확인' }));
    expect(await screen.findByText('이 작업 뒤 대상 상태를 재조회하지 못했습니다. 재연결해도 원래 작업 결과는 유지됩니다.')).toBeVisible();
    await waitFor(() => expect(screen.getByRole('button', { name: '새로고침' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: '새로고침' }));
    await waitFor(() => expect(mock.listContainers).toHaveBeenCalledTimes(3));
    expect(recovery().getByRole('button', { name: '중지' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '다시 연결' }));
    await waitFor(() => expect(recovery().getByRole('button', { name: '중지' })).toBeEnabled());
    expect(screen.getByRole('region', { name: '최근 작업 결과' })).toBeVisible();
    expect(screen.getByRole('heading', { name: /^결과 불명 · 중지 · backend$/ })).toBeVisible();
  });
  it.each([new Error('response lost'), { code: 'WorkerFailed', message: 'worker response lost' }])('treats lost mutation replies as uncertain and blocked', async failure => {
    const user = userEvent.setup();
    mock.mutateContainer.mockRejectedValueOnce(failure);
    render(<App />);
    await connected();
    await user.click(screen.getByRole('button', { name: /redis/ }));
    await user.click(recovery().getByRole('button', { name: '시작' }));
    expect(await screen.findByRole('heading', { name: /^결과 불명 ·/ })).toBeVisible();
    expect(within(screen.getByRole('region', { name: '최근 작업 결과' })).getByText(/이 작업 뒤 대상 상태를 재조회하지 못했습니다/)).toBeVisible();
    expect(mock.mutateContainer).toHaveBeenCalledTimes(1);
  });
  it('requires environment validation after a native mutation rejection', async () => {
    const user = userEvent.setup();
    mock.mutateContainer.mockRejectedValueOnce({ code: 'TargetChanged', message: '대상이 변경되었습니다.' });
    render(<App />);
    await connected();
    await user.click(screen.getByRole('button', { name: /redis/ }));
    await user.click(recovery().getByRole('button', { name: '시작' }));
    expect(await screen.findByRole('heading', { name: /^실패 ·/ })).toBeVisible();
    expect(within(screen.getByRole('region', { name: '최근 작업 결과' })).getByText(/이 작업 뒤 연결 재확인/)).toBeVisible();
    expect(recovery().getByRole('button', { name: '시작' })).toBeDisabled();
  });
});

describe('recent log snapshots and diagnostics', () => {
  it('ignores late logs after selection changes', async () => {
    const user = userEvent.setup();
    const old = deferred<RecentLogs>();
    mock.getRecentLogs.mockImplementationOnce(() => old.promise);
    render(<App />);
    await connected();
    await user.click(screen.getByRole('button', { name: /redis/ }));
    expect(mock.getRecentLogs).toHaveBeenCalledTimes(1);
    await act(async () => { old.resolve(log('session-1', 'handle-1-g1', 'old container logs')); });
    await screen.findByText('service ready');
    expect(screen.queryByText('old container logs')).not.toBeInTheDocument();
    expect(screen.getByLabelText('최근 로그 내용')).toHaveTextContent('service ready');
  });
  it('rejects a log response from a stale generation', async () => {
    const user = userEvent.setup();
    mock.getRecentLogs.mockResolvedValueOnce(log('session-1', 'handle-1-g1', 'stale log', { generation: 0 }));
    render(<App />);
    await connected();
    await user.click(await screen.findByText('진단 상세 · STALE_RESPONSE'));
    expect(screen.getByText('이전 로그 응답입니다. Recent Logs로 다시 조회하세요.')).toBeVisible();
    expect(screen.queryByText('stale log')).not.toBeInTheDocument();
  });
  it('renders text safely, marks truncation, copies only displayed logs and clears only the UI buffer', async () => {
    const user = userEvent.setup();
    const write = vi.spyOn(navigator.clipboard, 'writeText');
    const content = '<img src=x onerror="alert(1)">\nlast retained logs';
    mock.getRecentLogs.mockImplementationOnce(async (sessionId, handle) => log(sessionId, handle, content, { truncated: true }));
    render(<App />);
    await connected();
    expect(await screen.findByText(/로그 앞부분이 잘렸습니다/)).toBeVisible();
    const output = screen.getByLabelText('최근 로그 내용');
    expect(output).toHaveTextContent('<img src=x onerror="alert(1)">');
    expect(output.querySelector('img')).toBeNull();
    await user.click(screen.getByRole('button', { name: '표시된 로그 복사' }));
    expect(write).toHaveBeenCalledWith(content);
    await user.click(screen.getByRole('button', { name: '로그 화면 비우기' }));
    expect(screen.getByLabelText('최근 로그 내용')).not.toHaveTextContent('last retained logs');
    expect(mock.mutateContainer).not.toHaveBeenCalled();
    expect(mock.getRecentLogs).toHaveBeenCalledTimes(1);
  });
  it('shows an explicit log error and can manually fetch an empty log', async () => {
    const user = userEvent.setup();
    mock.getRecentLogs.mockRejectedValueOnce({ code: 'LogsUnavailable', message: '현재 logging driver는 로그 읽기를 지원하지 않습니다.' });
    render(<App />);
    await connected();
    expect(await screen.findByText('최근 로그를 읽지 못했습니다.')).toBeVisible();
    mock.getRecentLogs.mockImplementationOnce(async (sessionId, handle) => log(sessionId, handle, ''));
    await user.click(screen.getByRole('button', { name: '로그 조회' }));
    expect(await screen.findByText('최근 로그가 없습니다.')).toBeVisible();
  });
  it('copies only explicitly allowed environment fields after user action', async () => {
    const user = userEvent.setup();
    const write = vi.spyOn(navigator.clipboard, 'writeText');
    mock.getEnvironment.mockResolvedValueOnce({ ...environment, diagnostics: ['private diagnostic output'] });
    render(<App />);
    await connected();
    expect(write).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '환경 진단 보기' }));
    await user.click(screen.getByRole('button', { name: '진단 정보 복사' }));
    expect(write).toHaveBeenCalledTimes(1);
    const copied = String(write.mock.calls[0]?.[0]);
    expect(copied).toContain(environment.endpoint);
    expect(copied).not.toContain('private diagnostic output');
    expect(copied).not.toContain('session-1');
    expect(copied).not.toContain('service ready');
    expect(await screen.findByText('환경 진단 복사됨')).toBeVisible();
  });
  it('shows the effective config and ignored configuration diagnostics without copying raw details', async () => {
    const user = userEvent.setup();
    const write = vi.spyOn(navigator.clipboard, 'writeText');
    mock.getEnvironment.mockResolvedValueOnce({ ...environment, diagnostics: ['runtime.json dockerConfig 적용 제외 · private-setting-detail'] });
    render(<App />);
    await connected();
    await user.click(screen.getByRole('button', { name: '환경 진단 보기' }));
    expect(screen.getByText(environment.dockerConfigPath!)).toBeVisible();
    await user.click(screen.getByText('원문 진단'));
    expect(screen.getByText('runtime.json dockerConfig 적용 제외 · private-setting-detail')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '진단 정보 복사' }));
    const copied = String(write.mock.calls[0]?.[0]);
    expect(JSON.parse(copied)).toMatchObject({ contextName: environment.contextName, dockerConfigPath: environment.dockerConfigPath, errorCode: null });
    expect(copied).not.toContain('private-setting-detail');
  });
});

describe('latest operation survives detail selection independently', () => {
  it('keeps one compact result through deselection and replaces it when switching between single and bulk work', async () => {
    const user = userEvent.setup();
    render(<App />);
    await connected();
    await user.click(recovery().getByRole('button', { name: '중지' }));
    await user.click(screen.getByRole('button', { name: '중지 확인' }));
    const result = await screen.findByRole('region', { name: '최근 작업 결과' });
    expect(within(result).getByRole('button', { name: '결과 펼치기' })).toHaveAttribute('aria-expanded', 'false');
    await waitFor(() => expect(screen.getByRole('button', { name: '새로고침' })).toBeEnabled());
    await user.type(screen.getByRole('textbox', { name: '컨테이너 검색' }), 'redis');
    expect(result).toBeVisible();
    expect(screen.queryByRole('region', { name: '서비스 복구' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'redis 작업 대상으로 선택' }));
    await user.click(screen.getByRole('button', { name: '시작 (1)' }));
    expect(await screen.findByRole('region', { name: '최근 일괄 작업 결과' })).toBeVisible();
    expect(screen.queryByRole('region', { name: '최근 작업 결과' })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: '새로고침' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'redis 상세' }));
    await user.click(recovery().getByRole('button', { name: '시작' }));
    expect(await screen.findByRole('region', { name: '최근 작업 결과' })).toBeVisible();
    expect(screen.queryByRole('region', { name: '최근 일괄 작업 결과' })).not.toBeInTheDocument();
    expect(document.querySelectorAll('.latest-operation .operation-result')).toHaveLength(1);
  });

  it('preserves an uncollapsed unknown result after deselection and a successful reconnect without labeling it successful', async () => {
    const user = userEvent.setup();
    mock.mutateContainer.mockResolvedValueOnce({ ...succeeded, outcome: 'resultUnknown', reconciliation: 'failed', mutationBlocked: true });
    render(<App />);
    await connected();
    await user.click(recovery().getByRole('button', { name: '중지' }));
    await user.click(screen.getByRole('button', { name: '중지 확인' }));
    const result = await screen.findByRole('region', { name: '최근 작업 결과' });
    await waitFor(() => expect(screen.getByRole('button', { name: '새로고침' })).toBeEnabled());
    await user.type(screen.getByRole('textbox', { name: '컨테이너 검색' }), 'redis');
    expect(result).toBeVisible();
    expect(within(result).queryByRole('button', { name: '결과 펼치기' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: '서비스 복구' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '다시 연결' }));
    await waitFor(() => expect(recovery().getByRole('button', { name: '시작' })).toBeEnabled());
    expect(within(result).getByRole('heading', { name: '결과 불명 · 중지 · backend' })).toBeVisible();
    expect(within(result).getByText(/재연결해도 원래 작업 결과는 유지됩니다/)).toBeVisible();
    expect(within(result).queryByRole('heading', { name: /^성공/ })).not.toBeInTheDocument();
  });
});

describe('CLI connection session replacement', () => {
  it.each(['EnvironmentChanged', 'SocketMissing'])('keeps log verification %s blocked through log retries and Refresh until Reconnect', async code => {
    const user = userEvent.setup();
    render(<App />);
    await connected();
    await waitFor(() => expect(screen.getByRole('button', { name: '로그 조회' })).toBeEnabled());
    mock.getRecentLogs.mockRejectedValueOnce({ code, message: '로그 연결 검증 실패' });
    await user.click(screen.getByRole('button', { name: '로그 조회' }));
    await user.click(await screen.findByText(`진단 상세 · ${code}`));
    expect(screen.getByText('로그 연결 검증 실패')).toBeVisible();
    expect(screen.getByText('추가 복구 작업이 차단되었습니다. 재연결로 환경을 다시 검증하세요.')).toBeVisible();
    expect(recovery().getByRole('button', { name: '중지' })).toBeDisabled();
    const beforeRetry = mock.startLogStream.mock.calls.length;
    await user.click(screen.getByRole('button', { name: '로그 조회' }));
    expect(mock.startLogStream).toHaveBeenCalledTimes(beforeRetry);
    await user.click(screen.getByRole('button', { name: '새로고침' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '새로고침' })).toBeEnabled());
    expect(recovery().getByRole('button', { name: '중지' })).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: '보이는 컨테이너 전체 선택' }));
    expect(screen.getByRole('button', { name: '시작 (1)' })).toBeDisabled();
    expect(mock.mutateContainer).not.toHaveBeenCalled();
    expect(mock.mutateContainers).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '다시 연결' }));
    await waitFor(() => expect(recovery().getByRole('button', { name: '중지' })).toBeEnabled());
  });
  it('blocks a queued bulk request as soon as background log verification fails after a successful Refresh', async () => {
    const user = userEvent.setup();
    const backgroundLogs = deferred<Awaited<ReturnType<typeof api.startLogStream>>>();
    render(<App />);
    await connected();
    await waitFor(() => expect(screen.getByRole('button', { name: '로그 조회' })).toBeEnabled());
    mock.startLogStream.mockReturnValueOnce(backgroundLogs.promise);
    await user.click(screen.getByRole('button', { name: '새로고침' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '새로고침' })).toBeEnabled());
    await user.click(screen.getByRole('checkbox', { name: '보이는 컨테이너 전체 선택' }));
    const start = screen.getByRole<HTMLButtonElement>('button', { name: '시작 (1)' });
    expect(start).toBeEnabled();
    await act(async () => {
      backgroundLogs.reject({ code: 'EnvironmentChanged', message: '백그라운드 연결 검증 실패' });
      await Promise.resolve();
      // The ref gate must reject this before React renders disabled controls.
      expect(start).toBeEnabled();
      start.click();
    });
    await user.click(screen.getByText('진단 상세 · EnvironmentChanged'));
    expect(screen.getByText('백그라운드 연결 검증 실패')).toBeVisible();
    expect(start).toBeDisabled();
    expect(mock.mutateContainers).not.toHaveBeenCalled();
  });
  it.each(['EnvironmentChanged', 'Disconnected', 'SocketMissing', 'PermissionDenied', 'Configuration', 'EndpointMismatch', 'RemoteEndpoint'])('keeps %s failures blocked after Refresh recovers until explicit Reconnect', async code => {
    const user = userEvent.setup();
    render(<App />);
    await connected();
    mock.listContainers.mockRejectedValueOnce({ code, message: '연결 검증 실패' });
    await user.click(screen.getByRole('button', { name: '새로고침' }));
    expect(await screen.findByText('연결을 다시 검증해야 합니다. 다시 연결을 실행하세요.')).toBeVisible();
    await waitFor(() => expect(screen.getByRole('button', { name: '새로고침' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: '새로고침' }));
    await waitFor(() => expect(screen.queryByText('오래된 정보 · 마지막 정상 목록입니다.')).not.toBeInTheDocument());
    expect(screen.getByText('추가 복구 작업이 차단되었습니다. 재연결로 환경을 다시 검증하세요.')).toBeVisible();
    expect(recovery().getByRole('button', { name: '중지' })).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: '보이는 컨테이너 전체 선택' }));
    expect(screen.getByRole('button', { name: '시작 (1)' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '중지 (1)' })).toBeDisabled();
    await user.click(recovery().getByRole('button', { name: '중지' }));
    expect(mock.mutateContainer).not.toHaveBeenCalled();
    expect(mock.mutateContainers).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '다시 연결' }));
    await waitFor(() => expect(recovery().getByRole('button', { name: '중지' })).toBeEnabled());
    expect(screen.queryByText('추가 복구 작업이 차단되었습니다. 재연결로 환경을 다시 검증하세요.')).not.toBeInTheDocument();
  });
  it('preserves the previous result but clears selection and confirmation before connecting B and ignores late A logs', async () => {
    const user = userEvent.setup();
    const nextConnection = deferred<Environment>();
    const oldLogs = deferred<RecentLogs>();
    render(<App />);
    await connected();
    await user.click(recovery().getByRole('button', { name: '중지' }));
    await user.click(screen.getByRole('button', { name: '중지 확인' }));
    const result = await screen.findByRole('region', { name: '최근 작업 결과' });
    const expand = within(result).queryByRole('button', { name: '결과 펼치기' });
    if (expand) await user.click(expand);
    await user.click(within(result).getByText('실행 상세'));
    expect(within(result).getByText(environment.contextName!)).toBeVisible();
    expect(within(result).getByText(environment.endpoint!)).toBeVisible();
    expect(within(result).getByText(environment.engineId!)).toBeVisible();
    await waitFor(() => expect(screen.getByRole('button', { name: '로그 조회' })).toBeEnabled());
    mock.getRecentLogs.mockReturnValueOnce(oldLogs.promise);
    await user.click(screen.getByRole('button', { name: '로그 조회' }));
    await user.click(screen.getByRole('checkbox', { name: 'backend 작업 대상으로 선택' }));
    mock.getEnvironment.mockReturnValueOnce(nextConnection.promise);
    const reconnect = screen.getByRole<HTMLButtonElement>('button', { name: '다시 연결' });
    const stop = recovery().getByRole<HTMLButtonElement>('button', { name: '중지' });
    // Exercise same-turn events before React applies the dialog's inert background.
    act(() => { stop.click(); reconnect.click(); });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: '최근 작업 결과' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'backend 상세' })).not.toBeInTheDocument();
    mock.listContainers.mockResolvedValueOnce(list(1, [{ ...backend, handle: 'engine-b-handle', name: 'backend-on-b' }], 'session-b'));
    mock.getRecentLogs.mockImplementation(async (sessionId, handle) => log(sessionId, handle, 'Engine B logs'));
    await act(async () => nextConnection.resolve({ ...environment, sessionId: 'session-b', contextName: 'desktop-linux', endpoint: 'unix:///Users/test/.docker/run/docker.sock', engineId: 'engine-b' }));
    expect(await screen.findByRole('button', { name: 'backend-on-b 상세' })).toBeVisible();
    expect(mock.getRecentLogs).not.toHaveBeenCalledWith('session-b', 'engine-b-handle-g1');
    await act(async () => oldLogs.resolve(log('session-1', 'handle-1-g2', 'late Engine A logs')));
    expect(await screen.findByText('Engine B logs')).toBeVisible();
    expect(screen.queryByText('late Engine A logs')).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: '최근 작업 결과' })).toBeVisible();
    expect(screen.getByRole('checkbox', { name: 'backend-on-b 작업 대상으로 선택' })).not.toBeChecked();
    expect(mock.mutateContainer).toHaveBeenCalledTimes(1);
    await user.click(recovery().getByRole('button', { name: '재시작' }));
    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByText('desktop-linux')).toBeVisible();
    expect(dialog.getByText('unix:///Users/test/.docker/run/docker.sock')).toBeVisible();
    expect(dialog.getByText('engine-b')).toBeVisible();
    expect(dialog.queryByText(environment.engineId!)).not.toBeInTheDocument();
    await user.click(dialog.getByRole('button', { name: '재시작 확인' }));
    await waitFor(() => expect(mock.mutateContainer).toHaveBeenLastCalledWith('session-b', 'engine-b-handle-g1', 'restart'));
  });
  it('preserves the historical bulk execution target through Refresh and Reconnect before another Engine loads', async () => {
    const user = userEvent.setup();
    render(<App />);
    await connected();
    await user.click(screen.getByRole('checkbox', { name: '보이는 컨테이너 전체 선택' }));
    await user.click(screen.getByRole('button', { name: '시작 (1)' }));
    const result = await screen.findByRole('region', { name: '최근 일괄 작업 결과' });
    const expand = within(result).queryByRole('button', { name: '결과 펼치기' });
    if (expand) await user.click(expand);
    await user.click(within(result).getByText('항목별 결과 · 2개'));
    expect(within(result).getByText(environment.contextName!)).toBeVisible();
    expect(within(result).getByText(environment.endpoint!)).toBeVisible();
    expect(within(result).getByText(environment.engineId!)).toBeVisible();
    await waitFor(() => expect(screen.getByRole('button', { name: '새로고침' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: '새로고침' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '새로고침' })).toBeEnabled());
    expect(screen.getByRole('region', { name: '최근 일괄 작업 결과' })).toBeVisible();
    mock.getEnvironment.mockResolvedValueOnce({ ...environment, status: 'unavailable', sessionId: null, mutationAllowed: false, error: { code: 'SocketMissing', message: '선택한 socket 없음' } });
    await user.click(screen.getByRole('button', { name: '다시 연결' }));
    expect(await screen.findByRole('heading', { name: '로컬 Docker 소켓을 확인할 수 없습니다.' })).toBeVisible();
    expect(screen.getByRole('region', { name: '최근 일괄 작업 결과' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'backend 상세' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('최근 로그 내용')).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: '보이는 컨테이너 전체 선택' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '새로고침' })).toBeDisabled();
    expect(screen.queryByRole('region', { name: '서비스 복구' })).not.toBeInTheDocument();
    mock.getEnvironment.mockResolvedValueOnce({ ...environment, sessionId: 'session-b', contextName: 'default', endpoint: 'unix:///other/docker.sock', engineId: 'engine-b' });
    mock.listContainers.mockResolvedValueOnce(list(1, [backend, redis], 'session-b'));
    await user.click(within(screen.getByRole('region', { name: '연결 환경' })).getByRole('button', { name: '다시 연결' }));
    await connected();
    expect(screen.getByRole('region', { name: '최근 일괄 작업 결과' })).toBeVisible();
    expect(screen.getByRole('checkbox', { name: '보이는 컨테이너 전체 선택' })).not.toBeChecked();
    expect(recovery().getByRole('button', { name: '중지' })).toBeEnabled();
    expect(mock.mutateContainers).toHaveBeenCalledTimes(1);
  });
});
