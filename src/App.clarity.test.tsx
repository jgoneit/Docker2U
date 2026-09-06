import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { api } from './api';
import type { Container, ContainerList, Environment, RecentLogs } from './api';

vi.mock('./api', async importOriginal => ({ ...await importOriginal<typeof import('./api')>(), api: { getEnvironment: vi.fn(), listContainers: vi.fn(), getRecentLogs: vi.fn(), mutateContainer: vi.fn(), mutateContainers: vi.fn() } }));
const mock = vi.mocked(api);
const environment: Environment = { status: 'ready', sessionId: 'session-1', contextName: 'local', endpoint: 'unix:///local.sock', dockerPath: '/local/docker', dockerConfigPath: '/local/config', clientVersion: '29', serverVersion: '29', apiVersion: '1.54', engineId: 'engine-1', osType: 'linux', architecture: 'arm64', mutationAllowed: true, error: null, diagnostics: [] };
const backend: Container = { handle: 'backend', fullId: 'a'.repeat(12) + '0123456789abcdef'.repeat(3) + 'ffab', shortId: 'a'.repeat(12), name: 'backend', image: 'local/api:1', state: 'running', health: 'healthy', ports: ['127.0.0.1:8080->8080/tcp'], createdAt: '2026-09-06T00:00:00Z' };
const redis: Container = { ...backend, handle: 'redis', fullId: 'b'.repeat(64), shortId: 'b'.repeat(12), name: 'redis', image: 'redis:7', state: 'exited', health: 'none', ports: [] };
function list(generation: number, containers = [backend, redis], sessionId = 'session-1'): ContainerList { return { sessionId, generation, containers: containers.map(container => ({ ...container, handle: `${container.handle}-${generation}` })), refreshedAt: '2026-09-06T00:00:00Z', stale: false }; }
function log(sessionId: string, handle: string, text = 'raw logs'): RecentLogs { return { sessionId, generation: Number(handle.split('-').at(-1)), handle, text, truncated: false, byteCount: text.length, command: 'docker logs', stderr: '' }; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function connected() { await screen.findByText('raw logs'); }
function expectConnection(text: string) { expect(within(screen.getByRole('region', { name: '연결 환경' })).getByRole('status')).toHaveTextContent(text); expect(document.querySelector('.footer-connection')).toHaveTextContent(text); }
beforeEach(() => {
  vi.resetAllMocks();
  localStorage.setItem('docker2u.preferences.v1', JSON.stringify({ theme: 'dark', language: 'ko' }));
  let generation = 0;
  mock.getEnvironment.mockResolvedValue(environment);
  mock.listContainers.mockImplementation(async sessionId => list(++generation, [backend, redis], sessionId));
  mock.getRecentLogs.mockImplementation(async (sessionId, handle) => log(sessionId, handle));
});

describe('connection and visible selection clarity', () => {
  it('keeps read-only ready environments connected with disabled recovery controls', async () => {
    mock.getEnvironment.mockResolvedValue({ ...environment, mutationAllowed: false });
    render(<App />);
    await connected();
    expectConnection('로컬 · 연결됨');
    expect(screen.queryByText('추가 복구 작업이 차단되었습니다. 재연결로 환경을 다시 검증하세요.')).not.toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: '서비스 복구' })).getByRole('button', { name: '중지' })).toBeDisabled();
  });

  it('latches connection warnings through successful logs, list reads and a failed reconnect, then clears only a valid new session', async () => {
    const user = userEvent.setup();
    render(<App />);
    await connected();
    mock.getRecentLogs.mockRejectedValueOnce({ code: 'Disconnected', message: 'socket disconnected' });
    await user.click(screen.getByRole('button', { name: '로그 조회' }));
    expectConnection('연결 재확인 필요');
    await user.click(screen.getByRole('button', { name: '로그 조회' }));
    await connected();
    await user.click(screen.getByRole('button', { name: '새로고침' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '새로고침' })).toBeEnabled());
    expectConnection('연결 재확인 필요');
    const pending = deferred<Environment>();
    mock.getEnvironment.mockReturnValueOnce(pending.promise);
    await user.click(screen.getByRole('button', { name: '다시 연결' }));
    expectConnection('환경 확인 중');
    await act(async () => pending.resolve({ ...environment, status: 'unavailable', sessionId: null, mutationAllowed: false }));
    expectConnection('연결 재확인 필요');
    mock.getEnvironment.mockResolvedValueOnce({ ...environment, sessionId: 'session-2', mutationAllowed: false });
    await user.click(within(screen.getByRole('region', { name: '연결 환경' })).getByRole('button', { name: '다시 연결' }));
    await connected();
    expectConnection('로컬 · 연결됨');
  });

  it('does not let copy feedback conceal connection state', async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    render(<App />);
    await connected();
    await user.click(screen.getByRole('button', { name: '표시된 로그 복사' }));
    expect(await screen.findByText('표시된 로그 복사됨')).toBeVisible();
    expectConnection('로컬 · 연결됨');
  });

  it('clears a hidden selection and late logs, preserves search focus, and never reselects when clearing search or refreshing', async () => {
    const user = userEvent.setup();
    const pending = deferred<RecentLogs>();
    mock.getRecentLogs.mockReturnValueOnce(pending.promise);
    render(<App />);
    await waitFor(() => expect(mock.getRecentLogs).toHaveBeenCalledTimes(1));
    const search = screen.getByRole('textbox', { name: '컨테이너 검색' });
    await user.type(search, 'redis');
    expect(search).toHaveFocus();
    expect(screen.queryByRole('region', { name: '서비스 복구' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'redis 상세' })).not.toHaveAttribute('aria-current');
    await act(async () => pending.resolve(log('session-1', 'backend-1', 'late discarded logs')));
    expect(screen.queryByText('late discarded logs')).not.toBeInTheDocument();
    await user.clear(search);
    await user.click(screen.getByRole('button', { name: '새로고침' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '새로고침' })).toBeEnabled());
    expect(screen.queryByRole('region', { name: '서비스 복구' })).not.toBeInTheDocument();
    expect(mock.getRecentLogs).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: '다시 연결' }));
    await connected();
    expect(screen.getByRole('button', { name: 'backend 상세' })).toHaveAttribute('aria-current', 'true');
  });

  it('uses the current search when a refresh resolves and preserves a still-visible selection', async () => {
    const user = userEvent.setup();
    render(<App />);
    await connected();
    const pending = deferred<ContainerList>();
    mock.listContainers.mockReturnValueOnce(pending.promise);
    await user.click(screen.getByRole('button', { name: '새로고침' }));
    const search = screen.getByRole('textbox', { name: '컨테이너 검색' });
    await user.type(search, 'backend');
    expect(screen.getByRole('button', { name: 'backend 상세' })).toHaveAttribute('aria-current', 'true');
    await act(async () => pending.resolve(list(2, [{ ...backend, name: 'renamed' }, redis])));
    expect(search).toHaveFocus();
    expect(screen.queryByRole('region', { name: '서비스 복구' })).not.toBeInTheDocument();
    expect(screen.getByText('검색 결과가 없습니다.')).toBeVisible();
    expect(mock.getRecentLogs).toHaveBeenCalledTimes(1);
  });

  it('preserves a visible selection and current filter focus, then clears selection when excluded', async () => {
    const user = userEvent.setup();
    render(<App />);
    await connected();
    const running = screen.getByRole('button', { name: '실행 중' });
    await user.click(running);
    expect(running).toHaveFocus();
    expect(screen.getByRole('button', { name: 'backend 상세' })).toHaveAttribute('aria-current', 'true');
    const stopped = within(screen.getByLabelText('컨테이너 필터')).getByRole('button', { name: '중지' });
    await user.click(stopped);
    expect(stopped).toHaveFocus();
    expect(screen.queryByRole('region', { name: '서비스 복구' })).not.toBeInTheDocument();
  });

  it('clears only the container query, preserves the state filter and visible selection, and restores search focus', async () => {
    const user = userEvent.setup();
    render(<App />);
    await connected();
    const search = screen.getByRole('textbox', { name: '컨테이너 검색' });
    const running = screen.getByRole('button', { name: '실행 중' });
    await user.click(running);
    await user.type(search, 'backend');
    const before = Object.values(mock).map(method => method.mock.calls.length);
    await user.click(screen.getByRole('button', { name: '컨테이너 검색 지우기' }));
    expect(search).toHaveValue('');
    expect(search).toHaveFocus();
    expect(running).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'backend 상세' })).toHaveAttribute('aria-current', 'true');
    expect(screen.queryByRole('button', { name: 'redis 상세' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '컨테이너 검색 지우기' })).not.toBeInTheDocument();
    expect(Object.values(mock).map(method => method.mock.calls.length)).toEqual(before);
  });

  it('does not resurrect a hidden selection when the container query clear button restores visible rows', async () => {
    const user = userEvent.setup();
    render(<App />);
    await connected();
    await user.click(screen.getByRole('button', { name: '실행 중' }));
    const search = screen.getByRole('textbox', { name: '컨테이너 검색' });
    await user.type(search, 'missing-container');
    expect(screen.queryByRole('region', { name: '서비스 복구' })).not.toBeInTheDocument();
    const before = Object.values(mock).map(method => method.mock.calls.length);
    const clear = screen.getByRole('button', { name: '컨테이너 검색 지우기' });
    clear.focus();
    await user.keyboard('{Enter}');
    expect(search).toHaveFocus();
    expect(search).toHaveValue('');
    expect(screen.getByRole('button', { name: '실행 중' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'backend 상세' })).not.toHaveAttribute('aria-current');
    expect(screen.queryByRole('button', { name: 'redis 상세' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('최근 로그 내용')).not.toBeInTheDocument();
    expect(Object.values(mock).map(method => method.mock.calls.length)).toEqual(before);
  });

  it.each(['0123456789ABCDEF0123456789ABCDEF', 'FFAB', '8080/TCP'])('supports case-insensitive partial full-ID and port search: %s', async query => {
    const user = userEvent.setup();
    render(<App />);
    await connected();
    await user.type(screen.getByRole('textbox', { name: '컨테이너 검색' }), ` ${query} `);
    expect(screen.getByRole('button', { name: 'backend 상세' })).toHaveAttribute('aria-current', 'true');
    expect(screen.queryByRole('button', { name: 'redis 상세' })).not.toBeInTheDocument();
  });

  it.each([true, false])('restores focus only when the refreshed list removes its focused row (remaining=%s)', async remaining => {
    const user = userEvent.setup();
    render(<App />);
    await connected();
    const pending = deferred<ContainerList>();
    mock.listContainers.mockReturnValueOnce(pending.promise);
    await user.click(screen.getByRole('button', { name: '새로고침' }));
    screen.getByRole('button', { name: 'backend 상세' }).focus();
    await act(async () => pending.resolve(list(2, remaining ? [redis] : [])));
    expect(remaining ? screen.getByRole('button', { name: 'redis 상세' }) : screen.getByRole('textbox', { name: '컨테이너 검색' })).toHaveFocus();
    expect(screen.queryByRole('region', { name: '서비스 복구' })).not.toBeInTheDocument();
  });

  it('timestamps accepted logs at completion independently of the list refresh timestamp', async () => {
    const pending = deferred<RecentLogs>();
    mock.getRecentLogs.mockReturnValueOnce(pending.promise);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-09-06T01:00:00Z'));
      render(<App />);
      await waitFor(() => expect(mock.getRecentLogs).toHaveBeenCalledTimes(1));
      expect(document.querySelector('.log-fetched-at')).not.toBeInTheDocument();
      vi.setSystemTime(new Date('2026-09-06T01:02:03Z'));
      await act(async () => pending.resolve(log('session-1', 'backend-1')));
      expect(document.querySelector('.log-fetched-at time')).toHaveAttribute('datetime', '2026-09-06T01:02:03.000Z');
      expect(screen.getByText(/목록 갱신 시각/)).toBeVisible();
    } finally { vi.useRealTimers(); }
  });

  it('rejects a queued confirmation when the selected target changes before React renders', async () => {
    const user = userEvent.setup();
    render(<App />);
    await connected();
    await user.click(within(screen.getByRole('region', { name: '서비스 복구' })).getByRole('button', { name: '중지' }));
    const confirm = screen.getByRole<HTMLButtonElement>('button', { name: '중지 확인' });
    const other = screen.getByRole<HTMLButtonElement>('button', { name: 'redis 상세' });
    act(() => { fireEvent.click(other); confirm.click(); });
    expect(mock.mutateContainer).not.toHaveBeenCalled();
  });
});
