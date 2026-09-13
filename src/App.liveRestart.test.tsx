import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import App from './App';
import { api, type Container, type ContainerList, type LogStreamRead, type MutationResult } from './api';

vi.mock('./api', async original => ({ ...await original<typeof import('./api')>(), api: { getEnvironment: vi.fn(), listContainers: vi.fn(), getRecentLogs: vi.fn(), startLogStream: vi.fn(), readLogStream: vi.fn(), stopLogStream: vi.fn(), getContainerStats: vi.fn(), mutateContainer: vi.fn(), mutateContainers: vi.fn() } }));
const mock = vi.mocked(api);
const alpha: Container = { handle: 'alpha', fullId: 'a'.repeat(64), shortId: 'a'.repeat(12), name: 'alpha', image: 'fixture', state: 'running', health: null, healthConfigured: null, ports: [], composeProject: null, composeService: null, createdAt: '' };
const beta: Container = { ...alpha, handle: 'beta', fullId: 'b'.repeat(64), shortId: 'b'.repeat(12), name: 'beta' };
const inventory = (generation: number): ContainerList => ({ sessionId: 'one', generation, containers: [alpha, beta].map(container => ({ ...container, handle: `${container.name}-g${generation}` })), refreshedAt: '', stale: false });
const succeeded: MutationResult = { outcome: 'succeeded', message: 'done', command: 'fixture restart', stderr: '', reconciliation: 'succeeded', mutationBlocked: false };
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const frame = (streamId: string, text: string): LogStreamRead => ({ sessionId: 'one', streamId, sequence: 1, text, truncated: false, terminal: true, error: null });
let initialRead: ReturnType<typeof deferred<LogStreamRead>>;
beforeEach(() => {
  vi.resetAllMocks();
  localStorage.setItem('docker2u.preferences.v1', JSON.stringify({ theme: 'dark', language: 'ko' }));
  mock.getEnvironment.mockResolvedValue({ status: 'ready', sessionId: 'one', contextName: 'fixture', endpoint: 'unix:///fixture.sock', dockerPath: '/fixture/docker', dockerConfigPath: '/fixture/config', clientVersion: '1', serverVersion: '1', apiVersion: '1', engineId: 'one', osType: 'linux', architecture: 'arm64', mutationAllowed: true, error: null, diagnostics: [] });
  let generation = 0;
  mock.listContainers.mockImplementation(async () => inventory(++generation));
  mock.getContainerStats.mockImplementation(async (sessionId, currentGeneration) => ({ sessionId, generation: currentGeneration, sampledAt: '', error: null, items: [] }));
  mock.startLogStream.mockImplementation(async (sessionId, currentGeneration, handle) => ({ sessionId, streamId: `stream-${handle}`, fullId: inventory(currentGeneration).containers.find(container => container.handle === handle)!.fullId }));
  initialRead = deferred<LogStreamRead>();
  mock.readLogStream.mockImplementation(async (_sessionId, streamId) => streamId === 'stream-alpha-g1' ? initialRead.promise : frame(streamId, `fresh ${streamId}`));
  mock.stopLogStream.mockResolvedValue();
  mock.mutateContainer.mockResolvedValue(succeeded);
  mock.mutateContainers.mockImplementation(async (sessionId, currentGeneration, handles, action) => ({ sessionId, generation: currentGeneration, action, mutationBlocked: false, items: inventory(currentGeneration).containers.filter(container => handles.includes(container.handle)).map(container => ({ handle: container.handle, fullId: container.fullId, name: container.name, outcome: 'succeeded', message: 'done', result: succeeded })) }));
});
async function connected() {
  await screen.findByRole('treeitem', { name: 'alpha 상세' });
  await waitFor(() => expect(mock.readLogStream).toHaveBeenCalledWith('one', 'stream-alpha-g1'));
}
async function restart(user: ReturnType<typeof userEvent.setup>, bulk = false) {
  await user.click(screen.getByRole('button', { name: bulk ? '재시작 (1)' : '재시작' }));
  await user.click(screen.getByRole('button', { name: '재시작 확인' }));
}
it('replaces a selected Restart tail only after accepted inventory, ignoring a delayed old terminal', async () => {
  const user = userEvent.setup(); render(<App />); await connected();
  const refreshed = deferred<ContainerList>(); mock.listContainers.mockReturnValueOnce(refreshed.promise);
  await restart(user);
  await waitFor(() => expect(mock.listContainers).toHaveBeenCalledTimes(2));
  expect(mock.startLogStream).toHaveBeenCalledTimes(1); expect(mock.stopLogStream).not.toHaveBeenCalled();
  await act(async () => refreshed.resolve(inventory(2)));
  await waitFor(() => expect(mock.startLogStream).toHaveBeenCalledTimes(2));
  expect(mock.startLogStream).toHaveBeenCalledTimes(2);
  expect(mock.startLogStream).toHaveBeenLastCalledWith('one', 2, 'alpha-g2');
  expect(mock.stopLogStream).toHaveBeenCalledWith('one', 'stream-alpha-g1');
  await act(async () => initialRead.resolve(frame('stream-alpha-g1', 'obsolete tail')));
  await screen.findByText('fresh stream-alpha-g2');
  expect(screen.queryByText('obsolete tail')).not.toBeInTheDocument();
  expect(mock.startLogStream).toHaveBeenCalledTimes(2);
});
it.each(['failure', 'unknown', 'inventory failure'])('does not replace logs after %s', async kind => {
  const user = userEvent.setup(); render(<App />); await connected();
  if (kind === 'inventory failure') mock.listContainers.mockRejectedValueOnce({ code: 'CommandFailed', message: 'inventory failed' });
  else mock.mutateContainer.mockResolvedValueOnce({ ...succeeded, outcome: kind === 'failure' ? 'failed' : 'resultUnknown' });
  await restart(user);
  await waitFor(() => expect(screen.getByRole('button', { name: '새로고침' })).toBeEnabled());
  await act(async () => initialRead.resolve(frame('stream-alpha-g1', 'last original tail')));
  expect(mock.startLogStream).toHaveBeenCalledTimes(1);
  if (kind !== 'inventory failure') expect(mock.stopLogStream).toHaveBeenCalledExactlyOnceWith('one', 'stream-alpha-g1');
});
it.each(['clear', 'selection'])('respects %s during a pending Restart', async change => {
  const user = userEvent.setup(); render(<App />); await connected();
  const mutation = deferred<MutationResult>(); mock.mutateContainer.mockReturnValueOnce(mutation.promise);
  await restart(user);
  if (change === 'clear') await user.click(screen.getByRole('button', { name: '로그 화면 비우기' }));
  else await user.click(screen.getByRole('treeitem', { name: 'beta 상세' }));
  await act(async () => mutation.resolve(succeeded));
  await waitFor(() => expect(screen.getByRole('button', { name: '새로고침' })).toBeEnabled());
  await act(async () => initialRead.resolve(frame('stream-alpha-g1', 'obsolete tail')));
  expect(screen.queryByText('obsolete tail')).not.toBeInTheDocument();
  if (change === 'clear') expect(mock.startLogStream).toHaveBeenCalledTimes(1);
  else {
    expect(mock.startLogStream).toHaveBeenCalledTimes(2);
    expect(mock.startLogStream).toHaveBeenLastCalledWith('one', 2, 'beta-g2');
  }
});
it.each([true, false])('replaces only a successful selected bulk Restart (selected=%s)', async selected => {
  const user = userEvent.setup(); render(<App />); await connected();
  await user.click(screen.getByRole('checkbox', { name: `${selected ? 'alpha' : 'beta'} 작업 대상으로 선택` }));
  await restart(user, true);
  await waitFor(() => expect(screen.getByRole('button', { name: '새로고침' })).toBeEnabled());
  await act(async () => initialRead.resolve(frame('stream-alpha-g1', 'last original tail')));
  expect(mock.startLogStream).toHaveBeenCalledTimes(selected ? 2 : 1);
  if (selected) expect(mock.startLogStream).toHaveBeenLastCalledWith('one', 2, 'alpha-g2');
});
