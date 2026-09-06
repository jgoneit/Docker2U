import { StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { api } from './api';
import type { Action, BulkMutationResult, Container, ContainerList, Environment, MutationResult, RecentLogs } from './api';

vi.mock('./api', async importOriginal => ({
  ...await importOriginal<typeof import('./api')>(),
  api: { getEnvironment: vi.fn(), listContainers: vi.fn(), getRecentLogs: vi.fn(), mutateContainer: vi.fn(), mutateContainers: vi.fn() },
}));
const mock = vi.mocked(api);
const environment: Environment = {
  status: 'ready', sessionId: 'session-1', profile: 'colima-docker2u', endpoint: 'unix:///Users/test/.colima/docker2u/docker.sock',
  dockerPath: '/opt/homebrew/bin/docker', colimaPath: '/opt/homebrew/bin/colima', clientVersion: '29.8.0', runtimeVersion: '0.10.3',
  serverVersion: '29.8.0', apiVersion: '1.54', engineId: 'engine-1', osType: 'linux', architecture: 'aarch64', mutationAllowed: true, diagnostics: [],
};
const backend: Container = { handle: 'handle-1', fullId: 'a'.repeat(64), shortId: 'a'.repeat(12), name: 'backend', image: 'company-api:1', state: 'running', health: 'healthy', ports: ['127.0.0.1:8080->8080/tcp'], createdAt: '2026-09-05T03:00:00Z' };
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
  await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled());
}
beforeEach(() => {
  vi.resetAllMocks();
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
    expect(screen.getByRole('checkbox', { name: '보이는 Container 전체 선택' })).toBePartiallyChecked();
    expect(screen.getByRole('button', { name: 'Start (1)' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Stop (0)' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'redis 상세' }));
    expect(checkbox).toBeChecked();
    expect(screen.getByRole('button', { name: 'redis 상세' })).toHaveAttribute('aria-current', 'true');
    await user.click(screen.getByRole('button', { name: '선택 해제' }));
    expect(checkbox).not.toBeChecked();
    expect(screen.queryByRole('button', { name: /Start \(/ })).not.toBeInTheDocument();
  });
  it('selects only visible containers and clears selection after search and filter changes', async () => {
    const user = userEvent.setup();
    render(<App />);
    await connected();
    const all = screen.getByRole('checkbox', { name: '보이는 Container 전체 선택' });
    await user.click(all);
    expect(all).toBeChecked();
    expect(screen.getByText('2개 선택')).toBeVisible();
    await user.type(screen.getByRole('textbox', { name: 'Container 검색' }), 'redis');
    expect(all).not.toBeChecked();
    expect(screen.queryByText('2개 선택')).not.toBeInTheDocument();
    await user.click(all);
    expect(screen.getByText('1개 선택')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Start (1)' }));
    await waitFor(() => expect(mock.mutateContainers).toHaveBeenCalledExactlyOnceWith('session-1', 1, ['handle-2-g1'], 'start'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled());
    expect(all).not.toBeChecked();
    await user.clear(screen.getByRole('textbox', { name: 'Container 검색' }));
    await user.click(all);
    await user.click(screen.getByRole('button', { name: '실행 중' }));
    expect(all).not.toBeChecked();
    expect(screen.queryByText('2개 선택')).not.toBeInTheDocument();
    await user.click(all);
    expect(screen.getByRole('button', { name: 'Start (0)' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Stop (1)' })).toBeEnabled();
  });
  it('clears checked targets at refresh start, including a failed refresh, and on reconnect', async () => {
    const user = userEvent.setup();
    render(<App />);
    await connected();
    await user.click(screen.getByRole('checkbox', { name: '보이는 Container 전체 선택' }));
    const pending = deferred<ContainerList>();
    mock.listContainers.mockReturnValueOnce(pending.promise);
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(screen.getByRole('checkbox', { name: 'redis 작업 대상으로 선택' })).not.toBeChecked();
    await act(async () => pending.reject({ code: 'MalformedOutput', message: 'list failed' }));
    expect(screen.getByRole('checkbox', { name: 'redis 작업 대상으로 선택' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Reconnect' }));
    await connected();
    await user.click(screen.getByRole('checkbox', { name: '보이는 Container 전체 선택' }));
    await user.click(screen.getByRole('button', { name: 'Reconnect' }));
    await connected();
    expect(screen.getByRole('checkbox', { name: '보이는 Container 전체 선택' })).not.toBeChecked();
  });
  it('counts compatible states and exposes each excluded target and reason', async () => {
    const user = userEvent.setup();
    const paused = { ...redis, fullId: 'c'.repeat(64), shortId: 'c'.repeat(12), handle: 'handle-3', name: 'worker', state: 'paused' };
    mock.listContainers.mockResolvedValueOnce(list(1, [backend, redis, paused]));
    render(<App />);
    await connected();
    await user.click(screen.getByRole('checkbox', { name: '보이는 Container 전체 선택' }));
    expect(screen.getByText('3개 선택')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Start (1)' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Stop (1)' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Restart (1)' })).toBeEnabled();
    await user.click(screen.getByText('작업별 제외 대상과 이유'));
    const bulk = within(screen.getByRole('region', { name: 'Container 일괄 제어' }));
    expect(bulk.getByRole('heading', { name: 'Start · 2개 제외' })).toBeVisible();
    expect(bulk.getByText('Paused 상태 · Created / Stopped에서만 Start 가능')).toBeVisible();
    expect(bulk.getByText('Stopped 상태 · Running에서만 Stop 가능')).toBeVisible();
  });
  it.each(['Stop', 'Restart'])('confirms bulk %s once with all targets, exclusions and restored focus', async actionLabel => {
    const user = userEvent.setup();
    render(<App />);
    await connected();
    await user.click(screen.getByRole('checkbox', { name: '보이는 Container 전체 선택' }));
    const trigger = screen.getByRole('button', { name: `${actionLabel} (1)` });
    screen.getByRole('button', { name: 'Refresh' }).focus();
    fireEvent.click(trigger);
    const dialog = within(screen.getByRole('dialog', { name: `${actionLabel} 1개 Container?` }));
    expect(dialog.getByText('실행 대상 · 1개')).toBeVisible();
    expect(dialog.getByText('제외 대상 · 1개')).toBeVisible();
    expect(dialog.getByText(backend.fullId)).toBeVisible();
    expect(dialog.getByText(redis.fullId)).toBeVisible();
    expect(dialog.getByText('colima-docker2u')).toBeVisible();
    expect(dialog.getByText(environment.endpoint!)).toBeVisible();
    const cancel = dialog.getByRole('button', { name: '취소' });
    expect(cancel).toHaveFocus();
    await user.tab({ shift: true });
    expect(dialog.getByRole('button', { name: `${actionLabel} 확인` })).toHaveFocus();
    await user.tab();
    expect(cancel).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(trigger).toHaveFocus();
    expect(mock.mutateContainers).not.toHaveBeenCalled();
    await user.click(trigger);
    await user.click(screen.getByRole('button', { name: `${actionLabel} 확인` }));
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
    const start = screen.getByRole<HTMLButtonElement>('button', { name: 'Start (1)' });
    const refresh = screen.getByRole<HTMLButtonElement>('button', { name: 'Refresh' });
    const reconnect = screen.getByRole<HTMLButtonElement>('button', { name: 'Reconnect' });
    const singleStop = screen.getByRole<HTMLButtonElement>('button', { name: 'Stop' });
    act(() => { start.click(); start.click(); refresh.click(); reconnect.click(); singleStop.click(); });
    expect(mock.mutateContainers).toHaveBeenCalledExactlyOnceWith('session-1', 1, ['handle-1-g1', 'handle-2-g1'], 'start');
    expect(mock.mutateContainer).not.toHaveBeenCalled();
    expect(mock.listContainers).toHaveBeenCalledTimes(1);
    expect(mock.getEnvironment).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    for (const name of ['Refresh', 'Reconnect', 'Stop', 'Start (1)', 'Stop (1)', 'Restart (1)', '전체', '선택 해제']) expect(screen.getByRole('button', { name })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Container 검색' })).toBeDisabled();
    screen.getAllByRole('checkbox').forEach(checkbox => expect(checkbox).toBeDisabled());
    expect(screen.getByText('Start · 1개 대상 순서대로 처리 및 상태 재조회 중…')).toBeVisible();
    await act(async () => pending.resolve(batch('start')));
    expect(await screen.findByRole('region', { name: '최근 일괄 작업 결과' })).toBeVisible();
    expect(mock.listContainers).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(refresh).toBeEnabled());
    expect(screen.getByRole('checkbox', { name: '보이는 Container 전체 선택' })).not.toBeChecked();
  });
  it('uses the same synchronous guard when a single action starts before bulk', async () => {
    const user = userEvent.setup();
    const pending = deferred<MutationResult>();
    mock.mutateContainer.mockReturnValueOnce(pending.promise);
    render(<App />);
    await connected();
    await user.click(screen.getByRole('checkbox', { name: '보이는 Container 전체 선택' }));
    await user.click(screen.getByRole('button', { name: 'redis 상세' }));
    const single = screen.getByRole<HTMLButtonElement>('button', { name: 'Start' });
    const bulk = screen.getByRole<HTMLButtonElement>('button', { name: 'Start (1)' });
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
    await user.click(screen.getByRole('checkbox', { name: '보이는 Container 전체 선택' }));
    await user.click(screen.getByRole('button', { name: 'Start (4)' }));
    const report = within(await screen.findByRole('region', { name: '최근 일괄 작업 결과' }));
    for (const label of ['성공', '실패', '결과 불명', '제외', '미실행']) expect(report.getByText(`${label} 1개`)).toBeVisible();
    for (const container of containers) expect(report.getByText(container.fullId)).toBeVisible();
    expect(report.getByText(/현재 상태 재조회는 원래 명령의 성공을 의미하지 않습니다/)).toBeVisible();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled());
    expect(mock.listContainers).toHaveBeenCalledTimes(2);
    await user.click(screen.getByRole('button', { name: 'redis 상세' }));
    expect(report.getByText('결과 불명 1개')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(mock.listContainers).toHaveBeenCalledTimes(3));
    expect(report.getByText('결과 불명 1개')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Start' })).toBeDisabled();
    expect(mock.mutateContainers).toHaveBeenCalledTimes(1);
  });
  it.each([new Error('response lost'), { code: 'WorkerFailed', message: 'worker response lost' }])('treats missing IPC replies as aggregate unknown and requires reconnect', async failure => {
    const user = userEvent.setup();
    mock.mutateContainers.mockRejectedValueOnce(failure);
    render(<App />);
    await connected();
    await user.click(screen.getByRole('checkbox', { name: '보이는 Container 전체 선택' }));
    await user.click(screen.getByRole('button', { name: 'Start (1)' }));
    const report = within(await screen.findByRole('region', { name: '최근 일괄 작업 결과' }));
    expect(report.getByRole('heading', { name: 'Start · 일괄 작업 결과 불명' })).toBeVisible();
    expect(report.getByText(/개별 대상의 결과를 확정할 수 없습니다/)).toBeVisible();
    expect(report.queryByText(/성공 \d+개/)).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled());
    expect(mock.listContainers).toHaveBeenCalledTimes(2);
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reconnect' })).toBeEnabled());
    expect(screen.getByRole('button', { name: 'Stop' })).toBeDisabled();
    expect(mock.mutateContainers).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Reconnect' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled());
  });
  it.each(['Busy', 'StaleHandle', 'InvalidSelection'])('recovers bulk %s rejection through Refresh and explicit reselection without retrying', async code => {
    const user = userEvent.setup();
    const refreshed = deferred<ContainerList>();
    mock.mutateContainers.mockRejectedValueOnce({ code, message: '실행 전에 요청이 거절되었습니다.' });
    render(<App />);
    await connected();
    mock.listContainers.mockReturnValueOnce(refreshed.promise);
    await user.click(screen.getByRole('checkbox', { name: '보이는 Container 전체 선택' }));
    await user.click(screen.getByRole('button', { name: 'Start (1)' }));
    const report = within(await screen.findByRole('region', { name: '최근 일괄 작업 결과' }));
    expect(report.getByRole('heading', { name: 'Start · 일괄 작업 요청 거절' })).toBeVisible();
    expect(report.getByText(/실행 전에 요청이 거절되어 이 요청의 조작은 실행되지 않았습니다/)).toBeVisible();
    expect(report.queryByText(/성공 \d+개/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: '보이는 Container 전체 선택' })).not.toBeChecked();
    expect(mock.mutateContainers).toHaveBeenCalledExactlyOnceWith('session-1', 1, ['handle-1-g1', 'handle-2-g1'], 'start');
    await act(async () => refreshed.resolve(list(2)));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled());
    expect(report.getByText('Refresh 후 대상을 다시 선택하세요.')).toBeVisible();
    expect(report.queryByText(/Reconnect/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start (1)' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: '보이는 Container 전체 선택' }));
    expect(screen.getByRole('button', { name: 'Start (1)' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Stop (1)' })).toBeEnabled();
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
    await user.click(screen.getByRole('checkbox', { name: '보이는 Container 전체 선택' }));
    await user.click(screen.getByRole('button', { name: 'Start (1)' }));
    expect(await screen.findByText('Stale · 마지막 정상 목록입니다.')).toBeVisible();
    expect(screen.getByRole('checkbox', { name: '보이는 Container 전체 선택' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeDisabled();
    const report = within(screen.getByRole('region', { name: '최근 일괄 작업 결과' }));
    expect(report.getByText('Refresh 후 대상을 다시 선택하세요.')).toBeVisible();
    expect(report.queryByText(/Reconnect/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled());
    expect(screen.queryByText('Stale · 마지막 정상 목록입니다.')).not.toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'redis 작업 대상으로 선택' }));
    expect(screen.getByRole('button', { name: 'Start (1)' })).toBeEnabled();
    expect(mock.getEnvironment).toHaveBeenCalledTimes(1);
    expect(mock.mutateContainers).toHaveBeenCalledTimes(1);
  });
  it.each(['NeedsValidation', 'StaleSession'])('keeps bulk %s rejection latched through successful Refresh until Reconnect', async code => {
    const user = userEvent.setup();
    mock.mutateContainers.mockRejectedValueOnce({ code, message: '연결 재검증이 필요합니다.' });
    render(<App />);
    await connected();
    await user.click(screen.getByRole('checkbox', { name: '보이는 Container 전체 선택' }));
    await user.click(screen.getByRole('button', { name: 'Start (1)' }));
    const report = within(await screen.findByRole('region', { name: '최근 일괄 작업 결과' }));
    expect(report.getByRole('heading', { name: 'Start · 일괄 작업 요청 거절' })).toBeVisible();
    expect(report.getByText('추가 작업이 차단되었습니다. Reconnect로 환경을 다시 검증하세요.')).toBeVisible();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled());
    await user.click(screen.getByRole('checkbox', { name: '보이는 Container 전체 선택' }));
    expect(screen.getByRole('button', { name: 'Start (1)' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeDisabled();
    expect(mock.mutateContainers).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Reconnect' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled());
    expect(screen.queryByRole('region', { name: '최근 일괄 작업 결과' })).not.toBeInTheDocument();
  });
  it('retains a reconciled bulk ResultUnknown warning without requiring Reconnect or retrying', async () => {
    const user = userEvent.setup();
    const result = batch('start', [list().containers[1]!]);
    result.items[0] = { ...result.items[0]!, outcome: 'resultUnknown', message: '명령 응답 유실', result: { ...succeeded, outcome: 'resultUnknown', reconciliation: 'succeeded', observedState: 'running' } };
    mock.mutateContainers.mockResolvedValueOnce(result);
    render(<App />);
    await connected();
    await user.click(screen.getByRole('checkbox', { name: 'redis 작업 대상으로 선택' }));
    await user.click(screen.getByRole('button', { name: 'Start (1)' }));
    const report = await screen.findByRole('region', { name: '최근 일괄 작업 결과' });
    expect(report).toHaveClass('outcome-resultUnknown');
    expect(within(report).getByText('결과 불명 1개')).toBeVisible();
    expect(within(report).getByText(/대상 상태 재조회 완료 · Running/)).toBeVisible();
    expect(within(report).queryByText(/Reconnect/)).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled());
    await user.click(screen.getByRole('checkbox', { name: 'redis 작업 대상으로 선택' }));
    expect(screen.getByRole('button', { name: 'Start (1)' })).toBeEnabled();
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
    await user.click(screen.getByRole('checkbox', { name: '보이는 Container 전체 선택' }));
    await user.click(screen.getByRole('button', { name: 'Start (1)' }));
    expect(await screen.findByRole('heading', { name: 'Start · 일괄 작업 결과 불명' })).toBeVisible();
    expect(screen.getByText(/요청 대상과 일치하는 전체 일괄 응답/)).toBeVisible();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled());
    expect(screen.getByRole('button', { name: 'Stop' })).toBeDisabled();
    expect(mock.mutateContainers).toHaveBeenCalledTimes(1);
  });
});

describe('environment and inventory', () => {
  it('opens exactly one environment session in StrictMode and renders real response state', async () => {
    render(<StrictMode><App /></StrictMode>);
    await connected();
    expect(mock.getEnvironment).toHaveBeenCalledTimes(1);
    expect(mock.listContainers).toHaveBeenCalledWith('session-1');
    expect(screen.getByRole('heading', { name: 'Docker2U' })).toBeVisible();
    expect(within(screen.getByRole('region', { name: 'Container 상세' })).getByText('Healthy')).toBeVisible();
    expect(screen.getByText(/최근 갱신/)).toBeVisible();
    expect(within(screen.getByRole('complementary')).queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument();
  });
  it.each([
    ['unavailable', null, 'Docker CLI를 확인할 수 없습니다.'],
    ['unsupported', '/opt/homebrew/bin/docker', '지원하는 로컬 환경이 아닙니다.'],
    ['unavailable', '/opt/homebrew/bin/docker', '로컬 환경에 연결하지 못했습니다.'],
  ] as const)('distinguishes %s environment with Docker path %s', async (status, dockerPath, title) => {
    mock.getEnvironment.mockResolvedValue({ ...environment, status, dockerPath, sessionId: null, mutationAllowed: false, diagnostics: ['환경을 준비한 뒤 다시 시도하세요.'] });
    render(<App />);
    expect(await screen.findByRole('heading', { name: title })).toBeVisible();
    expect(mock.listContainers).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeDisabled();
    expect(screen.getByText('환경을 준비한 뒤 다시 시도하세요.')).toBeVisible();
  });
  it('renders a recoverable transport failure and reconnects', async () => {
    const user = userEvent.setup();
    mock.getEnvironment.mockRejectedValueOnce({ code: 'NativeRequired', message: '앱에서 연결하세요.' });
    render(<App />);
    expect(await screen.findByText('앱에서 연결하세요.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '다시 연결' }));
    await connected();
    expect(mock.getEnvironment).toHaveBeenCalledTimes(2);
  });
  it('distinguishes empty inventory from no search results and searches ports', async () => {
    const user = userEvent.setup();
    render(<App />);
    await connected();
    await user.type(screen.getByRole('textbox', { name: 'Container 검색' }), '8080');
    expect(within(screen.getByRole('list', { name: 'Container 목록' })).getAllByRole('button')).toHaveLength(1);
    expect(within(screen.getByRole('list', { name: 'Container 목록' })).getByRole('button')).toHaveTextContent('backend');
    await user.clear(screen.getByRole('textbox', { name: 'Container 검색' }));
    await user.type(screen.getByRole('textbox'), 'missing');
    expect(screen.getByText('검색 결과가 없습니다.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '검색·필터 초기화' }));
    await user.click(screen.getByRole('button', { name: '중지' }));
    expect(within(screen.getByRole('list', { name: 'Container 목록' })).getAllByRole('button')).toHaveLength(1);
    expect(within(screen.getByRole('list', { name: 'Container 목록' })).getByRole('button')).toHaveTextContent('redis');
    mock.listContainers.mockResolvedValueOnce(list(2, []));
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByRole('heading', { name: '아직 Container가 없습니다.' })).toBeVisible();
    expect(screen.getByText('현재 Engine에 Container가 없습니다.')).toBeVisible();
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
    expect(screen.getByRole('button', { name: 'Start' })).toBeEnabled();
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
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText('Stale · 마지막 정상 목록입니다.')).toBeVisible();
    expect(within(screen.getByRole('list', { name: 'Container 목록' })).getAllByRole('button')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Stop' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Recent Logs' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(screen.queryByText('Stale · 마지막 정상 목록입니다.')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled();
  });
  it('blocks reconnect during a pending refresh and reconnects after it succeeds', async () => {
    const user = userEvent.setup();
    render(<App />);
    await connected();
    const pending = deferred<ContainerList>();
    mock.listContainers.mockReturnValueOnce(pending.promise);
    const refreshButton = screen.getByRole('button', { name: 'Refresh' });
    const reconnectButton = screen.getByRole('button', { name: 'Reconnect' });
    await user.click(refreshButton);
    expect(refreshButton).toBeDisabled();
    expect(reconnectButton).toBeDisabled();
    await user.click(refreshButton);
    await user.click(reconnectButton);
    expect(mock.getEnvironment).toHaveBeenCalledTimes(1);
    expect(mock.listContainers).toHaveBeenCalledTimes(2);
    expect(within(screen.getByRole('list', { name: 'Container 목록' })).getAllByRole('button')).toHaveLength(2);
    expect(screen.getByRole('button', { name: /backend/ })).toBeVisible();
    expect(screen.getByRole('button', { name: /redis/ })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeDisabled();
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
    const refreshButton = screen.getByRole('button', { name: 'Refresh' });
    const reconnectButton = screen.getByRole('button', { name: 'Reconnect' });
    await user.click(refreshButton);
    expect(refreshButton).toBeDisabled();
    expect(reconnectButton).toBeDisabled();
    await user.click(refreshButton);
    await user.click(reconnectButton);
    expect(mock.getEnvironment).toHaveBeenCalledTimes(1);
    expect(mock.listContainers).toHaveBeenCalledTimes(2);
    expect(within(screen.getByRole('list', { name: 'Container 목록' })).getAllByRole('button')).toHaveLength(2);
    expect(screen.getByRole('button', { name: /backend/ })).toBeVisible();
    expect(screen.getByRole('button', { name: /redis/ })).toBeVisible();
    await act(async () => { pending.reject(failure); });
    expect(screen.getByText(failure.message)).toBeVisible();
    expect(screen.getByText('Stale · 마지막 정상 목록입니다.')).toBeVisible();
    expect(within(screen.getByRole('list', { name: 'Container 목록' })).getAllByRole('button')).toHaveLength(2);
    expect(refreshButton).toBeEnabled();
    expect(reconnectButton).toBeEnabled();
    mock.getEnvironment.mockResolvedValueOnce({ ...environment, sessionId: 'session-2' });
    mock.listContainers.mockResolvedValueOnce(list(1, [{ ...redis, name: 'new-session-container' }], 'session-2'));
    await user.click(reconnectButton);
    expect(await screen.findByRole('button', { name: /new-session-container/ })).toBeVisible();
    expect(mock.getEnvironment).toHaveBeenCalledTimes(2);
    expect(mock.listContainers).toHaveBeenCalledTimes(3);
    expect(mock.listContainers).toHaveBeenLastCalledWith('session-2');
    expect(screen.queryByText('Stale · 마지막 정상 목록입니다.')).not.toBeInTheDocument();
  });
  it('guards immediate reconnect and duplicate refresh clicks before React disables the buttons', async () => {
    render(<App />);
    await connected();
    const pending = deferred<ContainerList>();
    mock.listContainers.mockReturnValueOnce(pending.promise);
    const refreshButton = screen.getByRole<HTMLButtonElement>('button', { name: 'Refresh' });
    const reconnectButton = screen.getByRole<HTMLButtonElement>('button', { name: 'Reconnect' });
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
    expect(within(screen.getByRole('list', { name: 'Container 목록' })).getAllByRole('button')).toHaveLength(2);
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
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText('Stale · 마지막 정상 목록입니다.')).toBeVisible();
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
    await waitFor(() => expect(screen.getByRole('button', { name: 'Recent Logs' }).hasAttribute('disabled')).toBe(!readable));
    expect(screen.getByRole('button', { name: 'Start' }).hasAttribute('disabled')).toBe(!start);
    expect(screen.getByRole('button', { name: 'Stop' }).hasAttribute('disabled')).toBe(!stopRestart);
    expect(screen.getByRole('button', { name: 'Restart' }).hasAttribute('disabled')).toBe(!stopRestart);
  });
  it.each(['Stop', 'Restart'])('confirms %s with the pinned target, focus trap, Escape and focus restoration', async action => {
    const user = userEvent.setup();
    render(<App />);
    await connected();
    const trigger = screen.getByRole('button', { name: action });
    await user.click(trigger);
    const dialog = screen.getByRole('dialog', { name: `${action} backend?` });
    expect(within(dialog).getByText('colima-docker2u')).toBeVisible();
    expect(within(dialog).getByText(environment.endpoint!)).toBeVisible();
    expect(within(dialog).getByText(backend.shortId)).toBeVisible();
    const cancel = within(dialog).getByRole('button', { name: '취소' });
    const confirm = within(dialog).getByRole('button', { name: `${action} 확인` });
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
    await user.click(screen.getByRole('button', { name: 'Restart' }));
    const confirm = screen.getByRole('button', { name: 'Restart 확인' });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(mock.mutateContainer).toHaveBeenCalledExactlyOnceWith('session-1', 'handle-1-g1', 'restart');
    expect(screen.getByRole('button', { name: 'Restart' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeDisabled();
    await act(async () => { mutation.resolve(succeeded); });
    expect(await screen.findByRole('heading', { name: 'Succeeded' })).toBeVisible();
    expect(mock.listContainers).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Restart' })).toBeEnabled());
  });
  it('refreshes after a known failure without claiming success', async () => {
    const user = userEvent.setup();
    mock.mutateContainer.mockResolvedValueOnce({ ...succeeded, outcome: 'failed', message: 'CLI가 종료 코드 1을 반환했습니다.', stderr: 'container failure', exitCode: 1 });
    render(<App />);
    await connected();
    await user.click(screen.getByRole('button', { name: /redis/ }));
    await user.click(screen.getByRole('button', { name: 'Start' }));
    expect(await screen.findByRole('heading', { name: 'Failed' })).toBeVisible();
    expect(mock.listContainers).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('heading', { name: 'Succeeded' })).not.toBeInTheDocument();
  });
  it('keeps ResultUnknown after successful exact-target reconciliation and never retries it', async () => {
    const user = userEvent.setup();
    mock.mutateContainer.mockResolvedValueOnce({ ...succeeded, outcome: 'resultUnknown', message: '명령 응답 시간이 초과되었습니다.', reconciliation: 'succeeded', observedState: 'running' });
    render(<App />);
    await connected();
    await user.click(screen.getByRole('button', { name: 'Restart' }));
    await user.click(screen.getByRole('button', { name: 'Restart 확인' }));
    expect(await screen.findByRole('heading', { name: 'ResultUnknown · 결과 불확실' })).toBeVisible();
    expect(screen.getByText(/대상 상태 재조회 완료 · Running/)).toBeVisible();
    expect(mock.mutateContainer).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(screen.getByRole('heading', { name: 'ResultUnknown · 결과 불확실' })).toBeVisible();
    expect(mock.mutateContainer).toHaveBeenCalledTimes(1);
  });
  it('keeps mutations blocked after reconciliation failure until an explicit reconnect', async () => {
    const user = userEvent.setup();
    mock.mutateContainer.mockResolvedValueOnce({ ...succeeded, outcome: 'resultUnknown', message: '연결이 중단되었습니다.', reconciliation: 'failed', mutationBlocked: true });
    render(<App />);
    await connected();
    await user.click(screen.getByRole('button', { name: 'Stop' }));
    await user.click(screen.getByRole('button', { name: 'Stop 확인' }));
    expect(await screen.findByText('대상 상태 재조회 실패. Reconnect가 필요합니다.')).toBeVisible();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(mock.listContainers).toHaveBeenCalledTimes(3));
    expect(screen.getByRole('button', { name: 'Stop' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Reconnect' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled());
    expect(screen.queryByRole('region', { name: '최근 작업 결과' })).not.toBeInTheDocument();
  });
  it.each([new Error('response lost'), { code: 'WorkerFailed', message: 'worker response lost' }])('treats lost mutation replies as uncertain and blocked', async failure => {
    const user = userEvent.setup();
    mock.mutateContainer.mockRejectedValueOnce(failure);
    render(<App />);
    await connected();
    await user.click(screen.getByRole('button', { name: /redis/ }));
    await user.click(screen.getByRole('button', { name: 'Start' }));
    expect(await screen.findByRole('heading', { name: 'ResultUnknown · 결과 불확실' })).toBeVisible();
    expect(screen.getByText(/추가 복구 작업이 차단되었습니다/)).toBeVisible();
    expect(mock.mutateContainer).toHaveBeenCalledTimes(1);
  });
  it('requires environment validation after a native mutation rejection', async () => {
    const user = userEvent.setup();
    mock.mutateContainer.mockRejectedValueOnce({ code: 'TargetChanged', message: '대상이 변경되었습니다.' });
    render(<App />);
    await connected();
    await user.click(screen.getByRole('button', { name: /redis/ }));
    await user.click(screen.getByRole('button', { name: 'Start' }));
    expect(await screen.findByRole('heading', { name: 'Failed' })).toBeVisible();
    expect(screen.getByText(/추가 복구 작업이 차단되었습니다/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Start' })).toBeDisabled();
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
    await screen.findByText('service ready');
    await act(async () => { old.resolve(log('session-1', 'handle-1-g1', 'old container logs')); });
    expect(screen.queryByText('old container logs')).not.toBeInTheDocument();
    expect(screen.getByLabelText('최근 로그 내용')).toHaveTextContent('service ready');
  });
  it('rejects a log response from a stale generation', async () => {
    mock.getRecentLogs.mockResolvedValueOnce(log('session-1', 'handle-1-g1', 'stale log', { generation: 0 }));
    render(<App />);
    await connected();
    expect(await screen.findByText('이전 로그 응답입니다. Recent Logs로 다시 조회하세요.')).toBeVisible();
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
    await user.click(screen.getByRole('button', { name: 'Recent Logs' }));
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
    await user.click(screen.getByRole('button', { name: 'Copy diagnostics' }));
    expect(write).toHaveBeenCalledTimes(1);
    const copied = String(write.mock.calls[0]?.[0]);
    expect(copied).toContain(environment.endpoint);
    expect(copied).not.toContain('private diagnostic output');
    expect(copied).not.toContain('session-1');
    expect(copied).not.toContain('service ready');
    expect(await screen.findByText('진단 정보 복사됨')).toBeVisible();
  });
});
