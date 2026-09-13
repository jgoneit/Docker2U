import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import App from './App';
import { api, type Container, type ContainerList, type RecentLogs } from './api';

vi.mock('./api', async original => ({ ...await original<typeof import('./api')>(), api: {
  getEnvironment: vi.fn(), listContainers: vi.fn(), getRecentLogs: vi.fn(), startLogStream: vi.fn(),
  readLogStream: vi.fn(), stopLogStream: vi.fn(), getContainerStats: vi.fn(), mutateContainer: vi.fn(), mutateContainers: vi.fn(),
} }));
const mock = vi.mocked(api);
const container: Container = { handle: 'snapshot-target', fullId: 'a'.repeat(64), shortId: 'a'.repeat(12), name: 'snapshot-target', image: 'fixture', state: 'exited', health: null, healthConfigured: null, ports: [], composeProject: null, composeService: null, createdAt: '' };
const snapshot: ContainerList = { sessionId: 'one', generation: 1, containers: [container], refreshedAt: '2026-09-08T00:00:00Z', stale: false };
const receipt = (text: string): RecentLogs => ({ sessionId: 'one', generation: 1, handle: container.handle, text, truncated: false, byteCount: text.length, command: 'fixture recent logs', stderr: '' });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.setItem('docker2u.preferences.v1', JSON.stringify({ theme: 'dark', language: 'ko' }));
  mock.getEnvironment.mockResolvedValue({ status: 'ready', sessionId: 'one', contextName: 'fixture', endpoint: 'unix:///fixture.sock', dockerPath: '/fixture/docker', dockerConfigPath: '/fixture/config', clientVersion: '1', serverVersion: '1', apiVersion: '1', engineId: 'one', osType: 'linux', architecture: 'arm64', mutationAllowed: true, error: null, diagnostics: [] });
  mock.stopLogStream.mockResolvedValue();
});

it.each(['created', 'exited', 'dead'])('keeps %s logs as one-shot snapshots through a pending search and reload', async state => {
  mock.listContainers.mockResolvedValue({ ...snapshot, containers: [{ ...container, state }] });
  const initial = deferred<RecentLogs>(), reloaded = deferred<RecentLogs>();
  mock.getRecentLogs.mockReturnValueOnce(initial.promise).mockReturnValueOnce(reloaded.promise);
  const user = userEvent.setup();
  render(<App />);
  await waitFor(() => expect(mock.getRecentLogs).toHaveBeenCalledExactlyOnceWith('one', container.handle));
  expect(screen.queryByRole('button', { name: '일시정지' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '재개' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '최신 로그로' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '맨 아래로' })).toBeDisabled();
  expect(screen.getByText('최대 300줄 · 2 MiB')).toBeVisible();
  expect(document.querySelector('.log-stream-status')).toBeNull();
  expect(document.querySelector('.log-fetched-at')).toBeNull();

  await user.click(screen.getByRole('button', { name: '로그 검색 열기' }));
  const search = screen.getByRole('searchbox', { name: '로그 검색' });
  await user.type(search, 'error');
  await act(async () => initial.resolve(receipt('ERROR first\nerror second')));
  const content = screen.getByLabelText('최근 로그 내용');
  expect(content.textContent).toBe('ERROR first\nerror second');
  expect(await screen.findByText('1 / 2건')).toBeVisible();
  expect(screen.getByRole('button', { name: '맨 아래로' })).toBeEnabled();
  expect(document.querySelector('.log-fetched-at')).toHaveTextContent('로그 조회 완료');
  expect(screen.queryByText('최근 2 MiB')).not.toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: '로그 조회' }));
  expect(mock.getRecentLogs).toHaveBeenCalledTimes(2);
  expect(search).toHaveValue('error');
  expect(content).not.toHaveTextContent('ERROR first');
  await act(async () => reloaded.resolve(receipt('only one ERROR after reload')));
  expect(content.textContent).toBe('only one ERROR after reload');
  expect(await screen.findByText('1 / 1건')).toBeVisible();
  expect(screen.getByRole('searchbox', { name: '로그 검색' })).toBe(search);
  expect(document.querySelector('.log-stream-status')).toBeNull();
  expect(document.querySelector('.log-fetched-at')).toHaveTextContent('로그 조회 완료');
  expect(mock.startLogStream).not.toHaveBeenCalled();
  expect(mock.readLogStream).not.toHaveBeenCalled();
  expect(mock.stopLogStream).not.toHaveBeenCalled();
  expect(mock.getEnvironment).toHaveBeenCalledTimes(1);
  expect(mock.listContainers).toHaveBeenCalledTimes(1);
  expect(mock.mutateContainer).not.toHaveBeenCalled();
  expect(mock.mutateContainers).not.toHaveBeenCalled();
});
