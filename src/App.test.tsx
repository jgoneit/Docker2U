import { StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { api } from './api';
import type { Container, ContainerList, Environment, MutationResult, RecentLogs } from './api';

vi.mock('./api', async importOriginal => ({
  ...await importOriginal<typeof import('./api')>(),
  api: { getEnvironment: vi.fn(), listContainers: vi.fn(), getRecentLogs: vi.fn(), mutateContainer: vi.fn() },
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
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}
async function connected() {
  await screen.findByRole('option', { name: /backend/ });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled());
}
beforeEach(() => {
  vi.resetAllMocks();
  let generation = 0;
  mock.getEnvironment.mockResolvedValue(environment);
  mock.listContainers.mockImplementation(async sessionId => list(++generation, [backend, redis], sessionId));
  mock.getRecentLogs.mockImplementation(async (sessionId, handle) => log(sessionId, handle));
  mock.mutateContainer.mockResolvedValue(succeeded);
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
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.getByRole('option')).toHaveTextContent('backend');
    await user.clear(screen.getByRole('textbox', { name: 'Container 검색' }));
    await user.type(screen.getByRole('textbox'), 'missing');
    expect(screen.getByText('검색 결과가 없습니다.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '검색·필터 초기화' }));
    await user.click(screen.getByRole('button', { name: '중지' }));
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.getByRole('option')).toHaveTextContent('redis');
    mock.listContainers.mockResolvedValueOnce(list(2, []));
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByRole('heading', { name: '아직 Container가 없습니다.' })).toBeVisible();
    expect(screen.getByText('현재 Engine에 Container가 없습니다.')).toBeVisible();
  });
  it('moves selection and focus with arrows, Home, and End', async () => {
    const user = userEvent.setup();
    render(<App />);
    await connected();
    const first = screen.getByRole('option', { name: /backend/ });
    first.focus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('option', { name: /redis/ })).toHaveFocus();
    expect(screen.getByRole('option', { name: /redis/ })).toHaveAttribute('aria-selected', 'true');
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
    expect(screen.getAllByRole('option')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Stop' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Recent Logs' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(screen.queryByText('Stale · 마지막 정상 목록입니다.')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled();
  });
  it('coalesces refresh clicks and ignores an older session list after reconnect', async () => {
    const user = userEvent.setup();
    render(<App />);
    await connected();
    const old = deferred<ContainerList>();
    mock.listContainers.mockImplementationOnce(() => old.promise);
    const refreshButton = screen.getByRole('button', { name: 'Refresh' });
    fireEvent.click(refreshButton);
    fireEvent.click(refreshButton);
    expect(mock.listContainers).toHaveBeenCalledTimes(2);
    expect(screen.getAllByRole('option')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Stop' })).toBeDisabled();
    mock.getEnvironment.mockResolvedValueOnce({ ...environment, sessionId: 'session-2' });
    mock.listContainers.mockResolvedValueOnce(list(1, [{ ...redis, name: 'new-session-container' }], 'session-2'));
    await user.click(screen.getByRole('button', { name: 'Reconnect' }));
    await screen.findByRole('option', { name: /new-session-container/ });
    await act(async () => { old.resolve(list(99, [{ ...backend, name: 'stale-session-container' }])); });
    expect(screen.queryByRole('option', { name: /stale-session-container/ })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: /new-session-container/ })).toBeVisible();
  });
  it('rejects stale generations without replacing the last successful snapshot', async () => {
    const user = userEvent.setup();
    render(<App />);
    await connected();
    mock.listContainers.mockResolvedValueOnce(list(1, [{ ...backend, name: 'stale-generation' }]));
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText('Stale · 마지막 정상 목록입니다.')).toBeVisible();
    expect(screen.queryByRole('option', { name: /stale-generation/ })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: /backend/ })).toBeVisible();
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
    await user.click(screen.getByRole('option', { name: /redis/ }));
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
    await user.click(screen.getByRole('option', { name: /redis/ }));
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
    await user.click(screen.getByRole('option', { name: /redis/ }));
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
    await user.click(screen.getByRole('option', { name: /redis/ }));
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
