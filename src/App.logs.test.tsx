import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { api } from './api';
import type { Container, ContainerList, Environment, MutationResult, RecentLogs } from './api';

vi.mock('./api', async importOriginal => ({ ...await importOriginal<typeof import('./api')>(), api: { getEnvironment: vi.fn(), listContainers: vi.fn(), getRecentLogs: vi.fn(), mutateContainer: vi.fn(), mutateContainers: vi.fn() } }));
const mock = vi.mocked(api);
const environment: Environment = { status: 'ready', sessionId: 'session-1', contextName: 'local', endpoint: 'unix:///local.sock', dockerPath: '/local/docker', dockerConfigPath: '/local/config', clientVersion: '29', serverVersion: '29', apiVersion: '1.54', engineId: 'engine-1', osType: 'linux', architecture: 'arm64', mutationAllowed: true, error: null, diagnostics: [] };
const containers: Container[] = ['alpha', 'beta', 'gamma'].map((name, index) => ({ handle: name, fullId: String(index + 1).repeat(64), shortId: String(index + 1).repeat(12), name, image: 'local/service:1', state: 'running', health: 'healthy', ports: [], createdAt: '2026-09-06T00:00:00Z' }));
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
  mock.getRecentLogs.mockImplementation((sessionId, handle) => {
    const pending = { ...deferred<RecentLogs>(), sessionId, handle };
    requests.push(pending);
    maximumActive = Math.max(maximumActive, ++active);
    return pending.promise.finally(() => { --active; });
  });
  return {
    requests,
    maximumActive: () => maximumActive,
    async succeed(index: number, text = `accepted ${requests[index]!.handle}`) {
      const request = requests[index]!;
      await act(async () => request.resolve({ sessionId: request.sessionId, generation: Number(request.handle.split('-').at(-1)), handle: request.handle, text, byteCount: text.length, truncated: false, command: 'docker logs', stderr: '' }));
    },
    async fail(index: number) {
      await act(async () => requests[index]!.reject({ code: 'EnvironmentChanged', message: 'discarded old connection failure' }));
    },
  };
}
const fetchLogs = () => screen.getByRole('button', { name: '로그 조회' });
const clearLogs = () => screen.getByRole('button', { name: '로그 화면 비우기' });
const output = () => screen.getByLabelText('최근 로그 내용');
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
  mock.listContainers.mockImplementation(async sessionId => list(++generation, containers, sessionId));
});

describe('native log request lifetime', () => {
  it.each(['success', 'failure'] as const)('keeps the execution slot after clearing and discards late %s without automatically reloading', async outcome => {
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
    expect(screen.queryByText('연결 재확인 필요')).not.toBeInTheDocument();
    expect(screen.queryByText('최근 로그를 읽지 못했습니다.')).not.toBeInTheDocument();
    expect(logs.requests).toHaveLength(1);

    await user.click(fetchLogs());
    expect(logs.requests).toHaveLength(2);
    await logs.succeed(1);
    expect(output()).toHaveTextContent('accepted alpha-1');
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
    await logs.fail(0);
    expect(logs.requests.map(request => request.handle)).toEqual(['alpha-1', 'gamma-1']);
    expect(screen.queryByText('연결 재확인 필요')).not.toBeInTheDocument();
    await logs.succeed(1);
    expect(output()).toHaveTextContent('accepted gamma-1');
    expect(logs.maximumActive()).toBe(1);
  });

  it.each(['clear', 'hide'] as const)('drops the queued target when the user chooses to %s', async action => {
    const user = userEvent.setup();
    const logs = controlledLogs();
    render(<App />);
    await waitFor(() => expect(logs.requests).toHaveLength(1));
    await select(user, 'beta');
    if (action === 'clear') await user.click(clearLogs());
    else await user.type(screen.getByRole('textbox', { name: '컨테이너 검색' }), 'no match');
    await logs.succeed(0);
    expect(logs.requests).toHaveLength(1);
    if (action === 'clear') expect(output()).toHaveAttribute('aria-busy', 'false');
    else expect(screen.queryByLabelText('최근 로그 내용')).not.toBeInTheDocument();
  });

  it('replaces pending refresh requests with the latest generation and handle', async () => {
    const user = userEvent.setup();
    const logs = controlledLogs();
    render(<App />);
    await waitFor(() => expect(logs.requests).toHaveLength(1));
    await refresh(user);
    await refresh(user);
    expect(logs.requests).toHaveLength(1);
    await logs.succeed(0, 'discarded generation 1');
    expect(logs.requests.map(request => request.handle)).toEqual(['alpha-1', 'alpha-3']);
    await logs.succeed(1);
    expect(output()).toHaveTextContent('accepted alpha-3');
    expect(logs.maximumActive()).toBe(1);
  });

  it('does not drain a request while its replacement inventory is still loading', async () => {
    const user = userEvent.setup();
    const logs = controlledLogs();
    const inventory = deferred<ContainerList>();
    render(<App />);
    await waitFor(() => expect(logs.requests).toHaveLength(1));
    mock.listContainers.mockReturnValueOnce(inventory.promise);
    await user.click(screen.getByRole('button', { name: '새로고침' }));
    await logs.succeed(0);
    expect(logs.requests).toHaveLength(1);
    expect(fetchLogs()).toBeDisabled();
    await act(async () => inventory.resolve(list(2)));
    expect(logs.requests.map(request => request.handle)).toEqual(['alpha-1', 'alpha-2']);
    await logs.succeed(1);
    expect(logs.maximumActive()).toBe(1);
  });

  it.each(['removing', 'unknown', 'removed', 'stale'] as const)('does not execute a queued target that becomes %s', async state => {
    const user = userEvent.setup();
    const logs = controlledLogs();
    render(<App />);
    await waitFor(() => expect(logs.requests).toHaveLength(1));
    await select(user, 'beta');
    if (state === 'stale') mock.listContainers.mockRejectedValueOnce({ code: 'CommandFailed', message: 'list unavailable' });
    else mock.listContainers.mockResolvedValueOnce(list(2, state === 'removed' ? containers.filter(container => container.name !== 'beta') : containers.map(container => container.name === 'beta' ? { ...container, state } : container)));
    await refresh(user);
    await logs.succeed(0);
    expect(logs.requests).toHaveLength(1);
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

  it('waits for a mutation and its refresh before starting a pending target', async () => {
    const user = userEvent.setup();
    const logs = controlledLogs();
    const mutation = deferred<MutationResult>();
    mock.mutateContainer.mockReturnValueOnce(mutation.promise);
    render(<App />);
    await waitFor(() => expect(logs.requests).toHaveLength(1));
    await select(user, 'beta');
    await user.click(within(screen.getByRole('region', { name: '서비스 복구' })).getByRole('button', { name: '중지' }));
    await user.click(screen.getByRole('button', { name: '중지 확인' }));
    await logs.succeed(0);
    expect(logs.requests).toHaveLength(1);
    await act(async () => mutation.resolve({ outcome: 'succeeded', message: 'completed', command: 'docker stop', stderr: '', reconciliation: 'notNeeded', mutationBlocked: false }));
    expect(logs.requests.map(request => request.handle)).toEqual(['alpha-1', 'beta-2']);
    await logs.succeed(1);
    expect(logs.maximumActive()).toBe(1);
  });

  it('releases a failed current request and rejects duplicate clicks before React disables the button', async () => {
    const logs = controlledLogs();
    render(<App />);
    await waitFor(() => expect(logs.requests).toHaveLength(1));
    await logs.fail(0);
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
