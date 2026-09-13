import { installSnapshotStreams } from './test/snapshotStreams';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { api } from './api';
import type { Container, ContainerList, Environment, RecentLogs } from './api';
import { frontendErrorMessages } from './messages/errors';
import { PREFERENCES_KEY } from './preferences';

vi.mock('./api', async importOriginal => ({
  ...await importOriginal<typeof import('./api')>(),
  api: { getEnvironment: vi.fn(), listContainers: vi.fn(), getRecentLogs: vi.fn(), startLogStream: vi.fn(), readLogStream: vi.fn(), stopLogStream: vi.fn(), getContainerStats: vi.fn(), mutateContainer: vi.fn(), mutateContainers: vi.fn() },
}));
const mock = vi.mocked(api);
const container: Container = { handle: 'backend-handle', fullId: 'a'.repeat(64), shortId: 'a'.repeat(12), name: 'backend', image: 'local/api:1', state: 'exited', health: null, healthConfigured: null, ports: [], composeProject: null, composeService: null, createdAt: '2026-09-06T00:00:00Z' };
const environment: Environment = { status: 'ready', sessionId: 'session-1', contextName: 'local', endpoint: 'unix:///local.sock', dockerPath: '/local/docker', dockerConfigPath: '/local/config', clientVersion: '29', serverVersion: '29', apiVersion: '1.54', engineId: 'engine-1', osType: 'linux', architecture: 'arm64', mutationAllowed: true, error: null, diagnostics: [] };
const snapshot: ContainerList = { sessionId: 'session-1', generation: 1, containers: [container], refreshedAt: '2026-09-06T00:00:00Z', stale: false };
const logs: RecentLogs = { sessionId: 'session-1', generation: 1, handle: container.handle, text: 'retained original log', truncated: false, byteCount: 21, command: 'docker logs exact-id', stderr: '' };
let generation = 0;
function calls() { return Object.values(mock).map(method => method.mock.calls.length); }
async function changeLanguage(user: ReturnType<typeof userEvent.setup>, from: 'ko' | 'en', to: 'ko' | 'en') {
  await user.click(screen.getByRole('button', { name: from === 'ko' ? '설정' : 'Settings' }));
  const dialog = within(screen.getByRole('dialog'));
  await user.selectOptions(dialog.getByRole('combobox', { name: from === 'ko' ? '언어' : 'Language' }), to);
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
}
beforeEach(() => {
  vi.resetAllMocks();
  installSnapshotStreams(mock);
  generation = 0;
  window.localStorage.clear();
  window.localStorage.setItem(PREFERENCES_KEY, JSON.stringify({ theme: 'dark', language: 'ko' }));
  mock.getEnvironment.mockResolvedValue(environment);
  mock.listContainers.mockImplementation(async () => ({ ...snapshot, generation: ++generation }));
  mock.getRecentLogs.mockImplementation(async () => ({ ...logs, generation }));
});

describe('retained frontend errors follow language changes without Docker requests', () => {
  it.each(['staleInventory', 'staleLogs', 'invalidBulkResponse'] as const)('localizes %s after it is recorded', async key => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText(logs.text);
    if (key === 'staleInventory') {
      mock.listContainers.mockResolvedValueOnce({ ...snapshot, generation: 0 });
      await user.click(screen.getByRole('button', { name: '새로고침' }));
    } else if (key === 'staleLogs') {
      mock.getRecentLogs.mockResolvedValueOnce({ ...logs, generation: 0 });
      await user.click(screen.getByRole('button', { name: '로그 조회' }));
    } else {
      mock.mutateContainers.mockResolvedValueOnce({ sessionId: 'session-1', generation, action: 'start', items: [], mutationBlocked: false });
      await user.click(screen.getByRole('checkbox', { name: '보이는 컨테이너 전체 선택' }));
      await user.click(screen.getByRole('button', { name: '시작 (1)' }));
      await user.click(await screen.findByRole('button', { name: '최근 작업 결과 상세 보기' }));
    }
    const code = key === 'invalidBulkResponse' ? 'INVALID_BULK_RESPONSE' : 'STALE_RESPONSE';
    await user.click(await screen.findByText(`진단 상세 · ${code}`));
    expect(screen.getByText(frontendErrorMessages[key].ko)).toBeVisible();
    await waitFor(() => expect(screen.getByRole('button', { name: '새로고침' })).toBeEnabled());
    const before = calls();
    await changeLanguage(user, 'ko', 'en');
    expect(screen.getByText(frontendErrorMessages[key].en)).toBeVisible();
    expect(screen.queryByText(frontendErrorMessages[key].ko)).not.toBeInTheDocument();
    expect(calls()).toEqual(before);
    await changeLanguage(user, 'en', 'ko');
    expect(screen.getByText(frontendErrorMessages[key].ko)).toBeVisible();
    expect(calls()).toEqual(before);
  });

  it('retains the generated IPC message descriptor through a single mutation result', async () => {
    const user = userEvent.setup();
    mock.mutateContainer.mockRejectedValueOnce(null);
    render(<App />);
    await screen.findByText(logs.text);
    const recovery = screen.getByRole('region', { name: '서비스 복구' });
    await user.click(within(recovery).getByRole('button', { name: '시작' }));
    await user.click(await screen.findByRole('button', { name: '최근 작업 결과 상세 보기' }));
    const result = await screen.findByRole('region', { name: '최근 작업 결과' });
    await user.click(within(result).getByText('실행 상세'));
    expect(within(result).getByText(frontendErrorMessages.ipcFailure.ko)).toBeVisible();
    await waitFor(() => expect(screen.getByRole('button', { name: '새로고침' })).toBeEnabled());
    const before = calls();
    await changeLanguage(user, 'ko', 'en');
    expect(within(result).getByText(frontendErrorMessages.ipcFailure.en)).toBeVisible();
    expect(within(result).getByRole('heading')).toHaveTextContent('Result unknown');
    expect(mock.mutateContainer).toHaveBeenCalledExactlyOnceWith('session-1', container.handle, 'start');
    expect(calls()).toEqual(before);
    await changeLanguage(user, 'en', 'ko');
    expect(within(result).getByText(frontendErrorMessages.ipcFailure.ko)).toBeVisible();
    expect(calls()).toEqual(before);
  });
});
