import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { api } from './api';
import type { Container, ContainerList, Environment, RecentLogs } from './api';
import { PREFERENCES_KEY } from './preferences';

vi.mock('./api', async importOriginal => ({
  ...await importOriginal<typeof import('./api')>(),
  api: { getEnvironment: vi.fn(), listContainers: vi.fn(), getRecentLogs: vi.fn(), mutateContainer: vi.fn(), mutateContainers: vi.fn() },
}));
const mock = vi.mocked(api);
const container: Container = { handle: 'private-handle', fullId: 'a'.repeat(64), shortId: 'a'.repeat(12), name: 'backend', image: 'local/api:1', state: 'exited', health: null, ports: [], createdAt: '2026-09-06T00:00:00Z' };
const environment: Environment = { status: 'ready', sessionId: 'private-session', contextName: 'local', endpoint: 'unix:///local.sock', dockerPath: '/local/docker', dockerConfigPath: '/local/config', clientVersion: '29', serverVersion: '29', apiVersion: '1.54', engineId: 'engine-1', osType: 'linux', architecture: 'arm64', mutationAllowed: true, error: null, diagnostics: [] };
const snapshot: ContainerList = { sessionId: 'private-session', generation: 1, containers: [container], refreshedAt: '2026-09-06T00:00:00Z', stale: false };
const logs: RecentLogs = { sessionId: 'private-session', generation: 1, handle: container.handle, text: 'private log content', truncated: false, byteCount: 19, command: 'private command', stderr: '' };
let generation = 0;
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function calls() { return Object.values(mock).map(method => method.mock.calls.length); }
function setup() {
  const user = userEvent.setup();
  const clipboard = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
  async function diagnostic(language = 'ko') {
    const trigger = screen.getByRole('button', { name: language === 'ko' ? '환경 진단 보기' : 'Show environment diagnostics' });
    if (trigger.getAttribute('aria-expanded') !== 'true') await user.click(trigger);
    await user.click(screen.getByRole('button', { name: language === 'ko' ? '진단 정보 복사' : 'Copy diagnostics' }));
    return JSON.parse(clipboard.mock.lastCall![0]);
  }
  return { user, clipboard, diagnostic };
}
beforeEach(() => {
  vi.resetAllMocks();
  generation = 0;
  window.localStorage.clear();
  window.localStorage.setItem(PREFERENCES_KEY, JSON.stringify({ theme: 'dark', language: 'ko' }));
  mock.getEnvironment.mockResolvedValue(environment);
  mock.listContainers.mockImplementation(async sessionId => ({ ...snapshot, sessionId, generation: ++generation }));
  mock.getRecentLogs.mockImplementation(async sessionId => ({ ...logs, sessionId, generation }));
});

describe('current frontend diagnostics', () => {
  it.each([true, false])('distinguishes the connected environment snapshot from mutationAllowed=%s without extra requests', async mutationAllowed => {
    const { user, diagnostic } = setup();
    mock.getEnvironment.mockResolvedValue({ ...environment, mutationAllowed });
    render(<App />);
    await screen.findByText(logs.text);
    const before = calls();
    const exported = await diagnostic();
    expect(exported).toMatchObject({ status: 'ready', mutationAllowed, frontendSession: {
      currentStatus: 'connected', effectiveMutationBlocked: !mutationAllowed, reconnectRequired: false,
      inventoryStale: false, inventoryRefreshedAt: snapshot.refreshedAt, issue: null,
    } });
    expect(screen.getByRole('heading', { name: '연결 시점의 환경 진단' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: '설정' }));
    await user.selectOptions(screen.getByRole('combobox', { name: '언어' }), 'en');
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(await diagnostic('en')).toEqual(exported);
    expect(calls()).toEqual(before);
  });

  it('keeps a current-session invalidation after clearing the log display, successful reads and ordinary errors', async () => {
    const { user, diagnostic } = setup();
    const pending = deferred<RecentLogs>();
    mock.getRecentLogs.mockReturnValueOnce(pending.promise);
    render(<App />);
    await waitFor(() => expect(mock.getRecentLogs).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole('button', { name: '로그 화면 비우기' }));
    await act(async () => pending.reject({ code: 'EnvironmentChanged', message: 'private engine failure', stderr: 'private stderr' }));
    const first = await diagnostic();
    expect(first.frontendSession).toMatchObject({ currentStatus: 'reconnectRequired', effectiveMutationBlocked: true, reconnectRequired: true,
      issue: { stage: 'logs', origin: 'nativeError', code: 'EnvironmentChanged', requiresReconnect: true, scope: 'current' },
    });
    expect(Number.isNaN(Date.parse(first.frontendSession.issue.occurredAt))).toBe(false);
    await user.click(screen.getByRole('button', { name: '새로고침' }));
    await screen.findByText(logs.text);
    expect((await diagnostic()).frontendSession.issue).toEqual(first.frontendSession.issue);
    mock.listContainers.mockRejectedValueOnce({ code: 'CommandFailed', message: 'ordinary list failure' });
    await user.click(screen.getByRole('button', { name: '새로고침' }));
    const later = await diagnostic();
    expect(later.frontendSession.inventoryStale).toBe(true);
    expect(later.frontendSession.issue).toEqual(first.frontendSession.issue);
    expect(JSON.stringify(later)).not.toMatch(/private|command|stderr/);
  });

  it.each(['native', 'frontend'] as const)('records %s list failures with their actual origin and inventory age', async origin => {
    const { user, diagnostic } = setup();
    render(<App />);
    await screen.findByText(logs.text);
    if (origin === 'native') mock.listContainers.mockRejectedValueOnce({ code: 'CommandFailed', message: 'raw native error' });
    else mock.listContainers.mockResolvedValueOnce({ ...snapshot, generation: 0 });
    await user.click(screen.getByRole('button', { name: '새로고침' }));
    const exported = await diagnostic();
    expect(exported.frontendSession).toMatchObject({ currentStatus: 'connected', effectiveMutationBlocked: true, reconnectRequired: false, inventoryStale: true, inventoryRefreshedAt: snapshot.refreshedAt,
      issue: { stage: 'list', origin: origin === 'native' ? 'nativeError' : 'frontendError', code: origin === 'native' ? 'CommandFailed' : 'STALE_RESPONSE', requiresReconnect: false },
    });
    expect(within(screen.getByRole('region', { name: '서비스 복구' })).getByRole('button', { name: '시작' })).toBeDisabled();
  });

  it('copies a thrown connection exception with no environment and no invented native code', async () => {
    const { user, diagnostic } = setup();
    mock.getEnvironment.mockRejectedValueOnce(new Error('private transport failure'));
    render(<App />);
    await screen.findByText('진단 상세 · IPC_FAILURE');
    const exported = await diagnostic();
    expect(exported).toMatchObject({ status: null, mutationAllowed: null, errorCode: null, frontendSession: {
      currentStatus: 'disconnected', effectiveMutationBlocked: true,
      issue: { stage: 'connect', origin: 'exception', code: null, requiresReconnect: true, scope: 'current' },
    } });
    expect(screen.getByText('코드 없음')).toBeVisible();
    const before = calls();
    await user.click(screen.getByRole('button', { name: '설정' }));
    await user.selectOptions(screen.getByRole('combobox', { name: '언어' }), 'en');
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(await diagnostic('en')).toEqual(exported);
    expect(screen.getByText('No error code')).toBeVisible();
    expect(calls()).toEqual(before);
    expect(JSON.stringify(exported)).not.toContain('private');
  });

  it('labels the previous cause during reconnect, replaces it on failure and clears it for a valid new session', async () => {
    const { user, diagnostic } = setup();
    mock.getRecentLogs.mockRejectedValueOnce({ code: 'EnvironmentChanged', message: 'old failure' });
    render(<App />);
    await screen.findByText('진단 상세 · EnvironmentChanged');
    const first = (await diagnostic()).frontendSession.issue;
    const pending = deferred<Environment>();
    mock.getEnvironment.mockReturnValueOnce(pending.promise);
    await user.click(screen.getByRole('button', { name: '다시 연결' }));
    const checking = (await diagnostic()).frontendSession;
    expect(checking.currentStatus).toBe('checking');
    expect(checking.issue).toEqual({ ...first, scope: 'previous' });
    expect(screen.getByText(/이전 연결의 문제입니다/)).toBeVisible();
    await act(async () => pending.reject({ code: 'CliNotFound', message: 'new failure' }));
    const failed = (await diagnostic()).frontendSession;
    expect(failed.issue).toMatchObject({ stage: 'connect', origin: 'nativeError', code: 'CliNotFound', scope: 'current' });
    mock.getEnvironment.mockResolvedValueOnce({ ...environment, sessionId: 'new-session' });
    await user.click(within(screen.getByRole('region', { name: '연결 환경' })).getByRole('button', { name: '다시 연결' }));
    await screen.findByText(logs.text);
    expect((await diagnostic()).frontendSession).toMatchObject({ currentStatus: 'connected', effectiveMutationBlocked: false, reconnectRequired: false, issue: null });
  });

  it('ignores a late old-session error while a new connection attempt fails', async () => {
    const { user, diagnostic } = setup();
    const oldLogs = deferred<RecentLogs>();
    const pending = deferred<Environment>();
    mock.getRecentLogs.mockReturnValueOnce(oldLogs.promise);
    render(<App />);
    await waitFor(() => expect(mock.getRecentLogs).toHaveBeenCalledTimes(1));
    mock.getEnvironment.mockReturnValueOnce(pending.promise);
    await user.click(screen.getByRole('button', { name: '다시 연결' }));
    await act(async () => pending.reject({ code: 'CliNotFound', message: 'new attempt' }));
    const first = await diagnostic();
    await act(async () => oldLogs.reject({ code: 'EnvironmentChanged', message: 'old session' }));
    expect(await diagnostic()).toEqual(first);
  });

  it.each(['single', 'bulk'] as const)('preserves a code-less %s native result through the final refresh', async mode => {
    const { user, diagnostic } = setup();
    const result = { outcome: 'resultUnknown' as const, reconciliation: 'failed' as const, mutationBlocked: true, message: 'private native output', command: 'private command', stderr: 'private stderr' };
    mock.mutateContainer.mockResolvedValueOnce(result);
    mock.mutateContainers.mockImplementationOnce(async (sessionId, generation) => ({ sessionId, generation, action: 'start', mutationBlocked: true,
      items: [{ handle: container.handle, fullId: container.fullId, name: container.name, outcome: result.outcome, message: result.message, result }],
    }));
    render(<App />);
    await screen.findByText(logs.text);
    if (mode === 'single') await user.click(within(screen.getByRole('region', { name: '서비스 복구' })).getByRole('button', { name: '시작' }));
    else {
      await user.click(screen.getByRole('checkbox', { name: '보이는 컨테이너 전체 선택' }));
      await user.click(screen.getByRole('button', { name: '시작 (1)' }));
    }
    await waitFor(() => expect(screen.getByRole('button', { name: '새로고침' })).toBeEnabled());
    const exported = await diagnostic();
    expect(exported.frontendSession.issue).toMatchObject({ stage: mode === 'single' ? 'singleAction' : 'bulkAction', origin: 'nativeResult', code: null, outcome: 'resultUnknown', reconciliation: 'failed', requiresReconnect: true });
    expect(exported.frontendSession.inventoryStale).toBe(false);
    expect(JSON.stringify(exported)).not.toContain('private');
  });
});
