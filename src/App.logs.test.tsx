import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { api } from './api';
import type { Container, ContainerList, ContainerStats, Environment, MutationResult, RecentLogs, LogStreamStart } from './api';
import type { FrontendSession } from './frontendSession';

vi.mock('./api', async importOriginal => ({ ...await importOriginal<typeof import('./api')>(), api: { getEnvironment: vi.fn(), listContainers: vi.fn(), getRecentLogs: vi.fn(), startLogStream: vi.fn(), readLogStream: vi.fn(), stopLogStream: vi.fn(), getContainerStats: vi.fn(), mutateContainer: vi.fn(), mutateContainers: vi.fn() } }));
const mock = vi.mocked(api);
const environment: Environment = { status: 'ready', sessionId: 'session-1', contextName: 'local', endpoint: 'unix:///local.sock', dockerPath: '/local/docker', dockerConfigPath: '/local/config', clientVersion: '29', serverVersion: '29', apiVersion: '1.54', engineId: 'engine-1', osType: 'linux', architecture: 'arm64', mutationAllowed: true, error: null, diagnostics: [] };
const containers: Container[] = ['alpha', 'beta', 'gamma'].map((name, index) => ({ handle: name, fullId: String(index + 1).repeat(64), shortId: String(index + 1).repeat(12), composeProject: null, composeService: null, name, image: 'local/service:1', state: 'running', health: 'healthy', ports: [], createdAt: '2026-09-06T00:00:00Z' }));
function list(generation = 1, rows = containers, sessionId = 'session-1'): ContainerList {
  return { sessionId, generation, containers: rows.map(container => ({ ...container, handle: `${container.handle}-${generation}` })), refreshedAt: '2026-09-06T00:00:00Z', stale: false };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function controlledLogs() {
  const requests: Array<ReturnType<typeof deferred<RecentLogs>> & { sessionId: string; handle: string }> = [];
  let active = 0;
  let maximumActive = 0;
  const frames = new Map<string, RecentLogs>();
  mock.startLogStream.mockImplementation((sessionId, _generation, handle) => {
    const pending = { ...deferred<RecentLogs>(), sessionId, handle };
    requests.push(pending);
    maximumActive = Math.max(maximumActive, ++active);
    return pending.promise.then(logs => {
      const streamId = `${sessionId}/${handle}`; frames.set(streamId, logs);
      return { sessionId, streamId, fullId: containers.find(container => handle.startsWith(container.handle))!.fullId };
    }).finally(() => { --active; });
  });
  mock.readLogStream.mockImplementation(async (sessionId, streamId) => ({ sessionId, streamId, sequence: 1, text: frames.get(streamId)?.text ?? '', terminal: false, truncated: false, error: null }));
  return {
    requests,
    maximumActive: () => maximumActive,
    async succeed(index: number, text = `accepted ${requests[index]!.handle}`) {
      const request = requests[index]!;
      await act(async () => request.resolve({ sessionId: request.sessionId, generation: Number(request.handle.split('-').at(-1)), handle: request.handle, text, byteCount: text.length, truncated: false, command: 'docker logs', stderr: '' }));
    },
    async fail(index: number, code = 'EnvironmentChanged') {
      await act(async () => requests[index]!.reject({ code, message: 'discarded old log failure' }));
    },
  };
}
const fetchLogs = () => screen.getByRole('button', { name: '로그 조회' });
const clearLogs = () => screen.getByRole('button', { name: '로그 화면 비우기' });
const output = () => screen.getByLabelText('최근 로그 내용');
async function diagnostic(user: ReturnType<typeof userEvent.setup>): Promise<FrontendSession> {
  const trigger = screen.getByRole('button', { name: '환경 진단 보기' });
  if (trigger.getAttribute('aria-expanded') !== 'true') await user.click(trigger);
  await user.click(screen.getByRole('button', { name: '진단 정보 복사' }));
  return JSON.parse(vi.mocked(navigator.clipboard.writeText).mock.lastCall![0]).frontendSession;
}
function expectConnection(warning: boolean) {
  const label = warning ? '연결 재확인 필요' : '로컬 · 연결됨';
  expect(within(screen.getByRole('region', { name: '연결 환경' })).getByRole('status')).toHaveTextContent(label);
}
function expectRecoveryBlocked() {
  const recovery = within(screen.getByRole('region', { name: '서비스 복구' }));
  expect(recovery.getByRole('button', { name: '중지' })).toBeDisabled();
  expect(recovery.getByRole('button', { name: '재시작' })).toBeDisabled();
}
async function select(user: ReturnType<typeof userEvent.setup>, name: string) { await user.click(screen.getByRole('button', { name: `${name} 상세` })); }
async function refresh(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: '새로고침' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '새로고침' })).toBeEnabled());
}
beforeEach(() => {
  vi.resetAllMocks();
  localStorage.setItem('docker2u.preferences.v1', JSON.stringify({ theme: 'dark', language: 'ko' }));
  let generation = 0;
  mock.getEnvironment.mockResolvedValue(environment);
  mock.stopLogStream.mockResolvedValue();
  mock.getContainerStats.mockReturnValue(new Promise(() => {}));
  mock.listContainers.mockImplementation(async sessionId => list(++generation, containers, sessionId));
});

describe('native log request lifetime', () => {
  it.each(['CommandFailed', 'StaleHandle'].flatMap(code => ['select', 'clear'].map(action => ({ code, action }))))('keeps the latest diagnostic after $action invalidates a pending request that later rejects with $code', async ({ code, action }) => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    const logs = controlledLogs();
    const stats = deferred<ContainerStats>();
    mock.getContainerStats.mockReturnValueOnce(stats.promise);
    render(<App />);
    await waitFor(() => expect(logs.requests).toHaveLength(1));
    await waitFor(() => expect(mock.getContainerStats).toHaveBeenCalledTimes(1));
    if (action === 'select') await select(user, 'beta');
    else await user.click(clearLogs());

    // This is a newer, accepted failure from the current view. The obsolete log
    // failure must not replace its code, stage, or occurrence time in diagnostics.
    await act(async () => stats.reject({ code: 'TimedOut', message: 'latest resource sample failed' }));
    const before = await diagnostic(user);
    expect(before).toMatchObject({ currentStatus: 'connected', effectiveMutationBlocked: false, reconnectRequired: false,
      issue: { stage: 'stats', origin: 'nativeError', code: 'TimedOut', requiresReconnect: false, scope: 'current' },
    });
    await logs.fail(0, code);

    expect(await diagnostic(user)).toEqual(before);
    expectConnection(false);
    expect(screen.queryByText('최근 로그를 읽지 못했습니다.')).not.toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: '서비스 복구' })).getByRole('button', { name: '중지' })).toBeEnabled();
    if (action === 'select') {
      expect(logs.requests.map(request => request.handle)).toEqual(['alpha-1', 'beta-1']);
      await logs.succeed(1, 'current beta logs');
      expect(output()).toHaveTextContent('current beta logs');
      expect(await diagnostic(user)).toEqual(before);
    } else {
      expect(logs.requests).toHaveLength(1);
      expect(output()).toHaveTextContent('로그 조회를 눌러 로그를 확인하세요.');
      expect(fetchLogs()).toBeEnabled();
    }
    expect(logs.maximumActive()).toBe(1);
  });

  it.each(['EnvironmentChanged', 'Disconnected', 'SocketMissing', 'PermissionDenied', 'Configuration', 'EndpointMismatch', 'RemoteEndpoint'])('latches current-session %s after Clear without restoring the log view or reloading', async code => {
    const user = userEvent.setup();
    const logs = controlledLogs();
    render(<App />);
    await waitFor(() => expect(logs.requests).toHaveLength(1));
    await user.click(clearLogs());
    expect(fetchLogs()).toBeDisabled();
    await logs.fail(0, code);

    expectConnection(true);
    expectRecoveryBlocked();
    expect(output()).toHaveTextContent('로그 조회를 눌러 로그를 확인하세요.');
    expect(output()).toHaveAttribute('aria-busy', 'false');
    expect(screen.queryByText('discarded old log failure')).not.toBeInTheDocument();
    expect(screen.queryByText('최근 로그를 읽지 못했습니다.')).not.toBeInTheDocument();
    expect(document.querySelector('.log-fetched-at')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '표시된 로그 복사' })).toBeDisabled();
    expect(fetchLogs()).toBeEnabled();
    expect(logs.requests).toHaveLength(1);
    expect(logs.maximumActive()).toBe(1);
    await user.click(screen.getByRole('checkbox', { name: '보이는 컨테이너 전체 선택' }));
    expect(screen.getByRole('button', { name: '중지 (3)' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '재시작 (3)' })).toBeDisabled();
    expect(mock.mutateContainer).not.toHaveBeenCalled();
    expect(mock.mutateContainers).not.toHaveBeenCalled();
  });

  it.each(['CommandFailed', 'TimedOut', 'StartFailed', 'StaleHandle', 'StaleSession', 'MalformedOutput', 'IPC_FAILURE'])('discards invalidated %s without treating it as a session invalidation', async code => {
    const user = userEvent.setup();
    const logs = controlledLogs();
    render(<App />);
    await waitFor(() => expect(logs.requests).toHaveLength(1));
    await user.click(clearLogs());
    await logs.fail(0, code);

    expectConnection(false);
    expect(within(screen.getByRole('region', { name: '서비스 복구' })).getByRole('button', { name: '중지' })).toBeEnabled();
    expect(screen.queryByText('최근 로그를 읽지 못했습니다.')).not.toBeInTheDocument();
    expect(output()).toHaveTextContent('로그 조회를 눌러 로그를 확인하세요.');
    expect(output()).toHaveAttribute('aria-busy', 'false');
    expect(fetchLogs()).toBeEnabled();
    expect(logs.requests).toHaveLength(1);
    expect(logs.maximumActive()).toBe(1);
  });

  it.each(['success', 'failure'] as const)('keeps the execution slot after clearing and discards the late %s log view without automatically reloading', async outcome => {
    const user = userEvent.setup();
    const logs = controlledLogs();
    render(<App />);
    await waitFor(() => expect(logs.requests).toHaveLength(1));
    await user.click(clearLogs());
    expect(output()).toHaveAttribute('aria-busy', 'false');
    expect(output()).toHaveTextContent('로그 조회를 눌러 로그를 확인하세요.');
    expect(fetchLogs()).toBeDisabled();
    await user.click(fetchLogs());
    await user.click(clearLogs());
    expect(logs.requests).toHaveLength(1);

    if (outcome === 'success') await logs.succeed(0, 'discarded old logs');
    else await logs.fail(0);
    expect(fetchLogs()).toBeEnabled();
    expect(output()).toHaveAttribute('aria-busy', 'false');
    expect(output()).toHaveTextContent('로그 조회를 눌러 로그를 확인하세요.');
    expectConnection(outcome === 'failure');
    expect(screen.queryByText('최근 로그를 읽지 못했습니다.')).not.toBeInTheDocument();
    expect(logs.requests).toHaveLength(1);

    await user.click(fetchLogs());
    if (outcome === 'failure') {
      // A connection-invalidating failure requires Reconnect before another stream.
      expect(logs.requests).toHaveLength(1); expectRecoveryBlocked();
    } else {
      expect(logs.requests).toHaveLength(2);
      await logs.succeed(1); expect(output()).toHaveTextContent('accepted alpha-1');
    }
    expectConnection(outcome === 'failure');
    expect(logs.maximumActive()).toBe(1);
  });

  it('coalesces alpha → beta → gamma into only the latest pending target', async () => {
    const user = userEvent.setup();
    const logs = controlledLogs();
    render(<App />);
    await waitFor(() => expect(logs.requests).toHaveLength(1));
    await select(user, 'beta');
    await select(user, 'gamma');
    expect(logs.requests).toHaveLength(1);
    expect(fetchLogs()).toBeDisabled();
    await logs.fail(0, 'TimedOut');
    expect(logs.requests.map(request => request.handle)).toEqual(['alpha-1', 'gamma-1']);
    expectConnection(false);
    expect(screen.queryByText('최근 로그를 읽지 못했습니다.')).not.toBeInTheDocument();
    await logs.succeed(1);
    expect(output()).toHaveTextContent('accepted gamma-1');
    expectConnection(false);
    expect(logs.maximumActive()).toBe(1);
  });

  it.each(['clear', 'hide', 'filter'].flatMap(action => ['success', 'failure'].map(outcome => ({ action, outcome }))))('drops the queued target after $action but preserves current-session warnings on $outcome', async ({ action, outcome }) => {
    const user = userEvent.setup();
    const logs = controlledLogs();
    render(<App />);
    await waitFor(() => expect(logs.requests).toHaveLength(1));
    await select(user, 'beta');
    if (action === 'clear') await user.click(clearLogs());
    else if (action === 'hide') await user.type(screen.getByRole('textbox', { name: '컨테이너 검색' }), 'no match');
    else await user.click(within(screen.getByLabelText('컨테이너 필터')).getByRole('button', { name: '중지' }));
    if (outcome === 'success') await logs.succeed(0);
    else await logs.fail(0);
    expect(logs.requests).toHaveLength(1);
    expectConnection(outcome === 'failure');
    expect(screen.queryByText('최근 로그를 읽지 못했습니다.')).not.toBeInTheDocument();
    if (action === 'clear') expect(output()).toHaveAttribute('aria-busy', 'false');
    else expect(screen.queryByLabelText('최근 로그 내용')).not.toBeInTheDocument();
  });

  it.each(['success', 'failure'])('keeps a pending stream pinned across repeated inventory refresh after %s', async outcome => {
    const user = userEvent.setup();
    const logs = controlledLogs();
    render(<App />);
    await waitFor(() => expect(logs.requests).toHaveLength(1));
    await refresh(user);
    await refresh(user);
    expect(logs.requests).toHaveLength(1);
    if (outcome === 'success') await logs.succeed(0, 'discarded generation 1');
    else await logs.fail(0);
    expect(logs.requests.map(request => request.handle)).toEqual(['alpha-1']);
    if (outcome === 'success') expect(output()).toHaveTextContent('discarded generation 1');
    expectConnection(outcome === 'failure');
    if (outcome === 'failure') expectRecoveryBlocked();
    expect(logs.maximumActive()).toBe(1);
  });

  it.each(['success', 'failure'])('preserves the existing stream while replacement inventory loads after %s', async outcome => {
    const user = userEvent.setup();
    const logs = controlledLogs();
    const inventory = deferred<ContainerList>();
    render(<App />);
    await waitFor(() => expect(logs.requests).toHaveLength(1));
    mock.listContainers.mockReturnValueOnce(inventory.promise);
    await user.click(screen.getByRole('button', { name: '새로고침' }));
    if (outcome === 'success') await logs.succeed(0);
    else await logs.fail(0);
    expectConnection(outcome === 'failure');
    expect(logs.requests).toHaveLength(1);
    expect(fetchLogs()).toBeDisabled();
    await act(async () => inventory.resolve(list(2)));
    expect(logs.requests.map(request => request.handle)).toEqual(['alpha-1']);
    if (outcome === 'success') expect(output()).toHaveTextContent('accepted alpha-1');
    expectConnection(outcome === 'failure');
    if (outcome === 'failure') expectRecoveryBlocked();
    expect(logs.maximumActive()).toBe(1);
  });

  it.each(['removing', 'unknown', 'removed', 'stale'].flatMap(state => ['success', 'failure'].map(outcome => ({ state, outcome }))))('does not execute a queued $state target after old $outcome', async ({ state, outcome }) => {
    const user = userEvent.setup();
    const logs = controlledLogs();
    render(<App />);
    await waitFor(() => expect(logs.requests).toHaveLength(1));
    await select(user, 'beta');
    if (state === 'stale') mock.listContainers.mockRejectedValueOnce({ code: 'CommandFailed', message: 'list unavailable' });
    else mock.listContainers.mockResolvedValueOnce(list(2, state === 'removed' ? containers.filter(container => container.name !== 'beta') : containers.map(container => container.name === 'beta' ? { ...container, state } : container)));
    await refresh(user);
    if (outcome === 'success') await logs.succeed(0);
    else await logs.fail(0);
    expect(logs.requests).toHaveLength(1);
    expectConnection(outcome === 'failure');
    expect(screen.queryByText('최근 로그를 읽지 못했습니다.')).not.toBeInTheDocument();
    if (state === 'removed') expect(screen.queryByLabelText('최근 로그 내용')).not.toBeInTheDocument();
    else {
      expect(fetchLogs()).toBeDisabled();
      expect(output()).toHaveAttribute('aria-busy', 'false');
    }
  });

  it('retains the old native slot through reconnect and then loads only the new session', async () => {
    const user = userEvent.setup();
    const logs = controlledLogs();
    render(<App />);
    await waitFor(() => expect(logs.requests).toHaveLength(1));
    mock.getEnvironment.mockResolvedValueOnce({ ...environment, sessionId: 'session-2' });
    mock.listContainers.mockResolvedValueOnce(list(1, containers, 'session-2'));
    await user.click(screen.getByRole('button', { name: '다시 연결' }));
    await waitFor(() => expect(mock.listContainers).toHaveBeenCalledWith('session-2'));
    expect(logs.requests).toHaveLength(1);
    await logs.fail(0);
    expect(logs.requests.map(request => [request.sessionId, request.handle])).toEqual([['session-1', 'alpha-1'], ['session-2', 'alpha-1']]);
    expect(screen.queryByText('연결 재확인 필요')).not.toBeInTheDocument();
    await logs.succeed(1, 'new session logs');
    expect(output()).toHaveTextContent('new session logs');
    expect(logs.maximumActive()).toBe(1);
  });

  it.each(['unavailable', 'rejected'])('ignores an old connection error while reconnect has no session and then becomes %s', async outcome => {
    const user = userEvent.setup();
    const logs = controlledLogs();
    const connection = deferred<Environment>();
    render(<App />);
    await waitFor(() => expect(logs.requests).toHaveLength(1));
    expectConnection(false);
    mock.getEnvironment.mockReturnValueOnce(connection.promise);
    await user.click(screen.getByRole('button', { name: '다시 연결' }));
    await logs.fail(0);
    expect(within(screen.getByRole('region', { name: '연결 환경' })).getByRole('status')).toHaveTextContent('환경 확인 중');

    await act(async () => {
      if (outcome === 'unavailable') connection.resolve({ ...environment, status: 'unavailable', sessionId: null, mutationAllowed: false });
      else connection.reject({ code: 'CliNotFound', message: 'new connection could not start' });
    });
    // A successful reconnect clears the latch, and "checking" has display priority;
    // ending without a session proves that neither concealed an old-request latch.
    expect(within(screen.getByRole('region', { name: '연결 환경' })).getByRole('status')).toHaveTextContent('연결되지 않음');
    expect(document.querySelector('.connection-status')).toHaveTextContent('연결되지 않음');
    expect(screen.queryByText('연결 재확인 필요')).not.toBeInTheDocument();
    expect(screen.queryByText('discarded old log failure')).not.toBeInTheDocument();
    expect(screen.queryByText('최근 로그를 읽지 못했습니다.')).not.toBeInTheDocument();
    expect(logs.requests).toHaveLength(1);
    expect(mock.listContainers).toHaveBeenCalledTimes(1);
  });

  it.each(['single', 'bulk'])('blocks an already-open %s confirmation before React renders an invalidated log connection failure', async mode => {
    const user = userEvent.setup();
    const pending = deferred<LogStreamStart>();
    mock.startLogStream.mockReturnValueOnce(pending.promise);
    mock.mutateContainer.mockReturnValue(new Promise(() => {}));
    mock.mutateContainers.mockReturnValue(new Promise(() => {}));
    render(<App />);
    await waitFor(() => expect(mock.startLogStream).toHaveBeenCalledTimes(1));
    await user.click(clearLogs());
    if (mode === 'bulk') {
      await user.click(screen.getByRole('checkbox', { name: '보이는 컨테이너 전체 선택' }));
      await user.click(screen.getByRole('button', { name: '중지 (3)' }));
    } else await user.click(within(screen.getByRole('region', { name: '서비스 복구' })).getByRole('button', { name: '중지' }));
    const confirm = within(screen.getByRole('dialog')).getByRole<HTMLButtonElement>('button', { name: '중지 확인' });
    confirm.focus();

    await act(async () => {
      pending.reject({ code: 'EnvironmentChanged', message: 'invalidated request detected an engine change' });
      await Promise.resolve();
      // Direct deferred IPC keeps the catch before this microtask and React's render after it.
      expect(confirm).toBeEnabled();
      confirm.click();
    });
    expect(mock.mutateContainer).not.toHaveBeenCalled();
    expect(mock.mutateContainers).not.toHaveBeenCalled();
    expect(confirm).toBeDisabled();
    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByRole('alert')).toHaveTextContent('취소한 뒤 다시 연결하세요.');
    expect(dialog.getByRole('button', { name: '취소' })).toHaveFocus();
    await user.tab();
    expect(dialog.getByRole('button', { name: '취소' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: '다시 연결' })).toHaveFocus();
    expectConnection(true);
    expectRecoveryBlocked();
    expect(output()).toHaveTextContent('로그 조회를 눌러 로그를 확인하세요.');
    expect(mock.startLogStream).toHaveBeenCalledTimes(1);
  });

  it.each(['success', 'failure'])('waits for a mutation and refresh while preserving an old log %s', async outcome => {
    const user = userEvent.setup();
    const logs = controlledLogs();
    const mutation = deferred<MutationResult>();
    mock.mutateContainer.mockReturnValueOnce(mutation.promise);
    render(<App />);
    await waitFor(() => expect(logs.requests).toHaveLength(1));
    await select(user, 'beta');
    await user.click(within(screen.getByRole('region', { name: '서비스 복구' })).getByRole('button', { name: '중지' }));
    await user.click(screen.getByRole('button', { name: '중지 확인' }));
    if (outcome === 'success') await logs.succeed(0);
    else await logs.fail(0);
    expect(logs.requests).toHaveLength(1);
    expectConnection(outcome === 'failure');
    await act(async () => mutation.resolve({ outcome: 'succeeded', message: 'completed', command: 'docker stop', stderr: '', reconciliation: 'notNeeded', mutationBlocked: false }));
    if (outcome === 'success') {
      expect(logs.requests.map(request => request.handle)).toEqual(['alpha-1', 'beta-2']); await logs.succeed(1);
    } else expect(logs.requests.map(request => request.handle)).toEqual(['alpha-1']);
    expectConnection(outcome === 'failure');
    if (outcome === 'failure') expectRecoveryBlocked();
    expect(logs.maximumActive()).toBe(1);
  });

  it('releases a failed current request and rejects duplicate clicks before React disables the button', async () => {
    const logs = controlledLogs();
    render(<App />);
    await waitFor(() => expect(logs.requests).toHaveLength(1));
    await logs.fail(0, 'TimedOut');
    expect(fetchLogs()).toBeEnabled();
    expect(screen.getByText('최근 로그를 읽지 못했습니다.')).toBeVisible();
    const fetch = fetchLogs();
    act(() => { fetch.click(); fetch.click(); });
    expect(logs.requests).toHaveLength(2);
    await logs.succeed(1);
    expect(output()).toHaveTextContent('accepted alpha-1');
    expect(logs.maximumActive()).toBe(1);
  });

  it('discards the queued request on unmount', async () => {
    const user = userEvent.setup();
    const logs = controlledLogs();
    const view = render(<App />);
    await waitFor(() => expect(logs.requests).toHaveLength(1));
    await select(user, 'beta');
    view.unmount();
    await logs.succeed(0);
    expect(logs.requests).toHaveLength(1);
  });
});
