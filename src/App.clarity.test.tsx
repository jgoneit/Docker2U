import { installSnapshotStreams } from './test/snapshotStreams';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { api } from './api';
import type { Container, ContainerList, Environment, RecentLogs } from './api';

vi.mock('./api', async importOriginal => ({ ...await importOriginal<typeof import('./api')>(), api: { getEnvironment: vi.fn(), listContainers: vi.fn(), getRecentLogs: vi.fn(), startLogStream: vi.fn(), readLogStream: vi.fn(), stopLogStream: vi.fn(), getContainerStats: vi.fn(), getContainerDetails: vi.fn(), mutateContainer: vi.fn(), mutateContainers: vi.fn() } }));
const mock = vi.mocked(api);
const environment: Environment = { status: 'ready', sessionId: 'session-1', contextName: 'local', endpoint: 'unix:///local.sock', dockerPath: '/local/docker', dockerConfigPath: '/local/config', clientVersion: '29', serverVersion: '29', apiVersion: '1.54', engineId: 'engine-1', osType: 'linux', architecture: 'arm64', mutationAllowed: true, error: null, diagnostics: [] };
const backend: Container = { handle: 'backend', fullId: 'a'.repeat(12) + '0123456789abcdef'.repeat(3) + 'ffab', shortId: 'a'.repeat(12), name: 'backend', image: 'local/api:1', state: 'running', health: 'healthy', ports: ['127.0.0.1:8080->8080/tcp'], composeProject: null, composeService: null, createdAt: '2026-09-06T00:00:00Z' };
const redis: Container = { ...backend, handle: 'redis', fullId: 'b'.repeat(64), shortId: 'b'.repeat(12), name: 'redis', image: 'redis:7', state: 'exited', health: 'none', ports: [] };
function list(generation: number, containers = [backend, redis], sessionId = 'session-1'): ContainerList { return { sessionId, generation, containers: containers.map(container => ({ ...container, handle: `${container.handle}-${generation}` })), refreshedAt: '2026-09-06T00:00:00Z', stale: false }; }
function log(sessionId: string, handle: string, text = 'raw logs'): RecentLogs { return { sessionId, generation: Number(handle.split('-').at(-1)), handle, text, truncated: false, byteCount: text.length, command: 'docker logs', stderr: '' }; }
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
async function connected() { await screen.findByText('raw logs'); }
function expectConnection(text: string) { expect(within(screen.getByRole('region', { name: '연결 환경' })).getByRole('status')).toHaveTextContent(text); }
beforeEach(() => {
  vi.resetAllMocks();
  mock.getContainerDetails.mockReturnValue(new Promise(() => {}));
  installSnapshotStreams(mock);
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

  it('latches connection warnings through blocked log retries, list reads and a failed reconnect, then clears only a valid new session', async () => {
    const user = userEvent.setup();
    render(<App />);
    await connected();
    mock.getRecentLogs.mockRejectedValueOnce({ code: 'Disconnected', message: 'socket disconnected' });
    await user.click(screen.getByRole('button', { name: '로그 조회' }));
    expectConnection('연결 재확인 필요');
    const beforeRetry = mock.startLogStream.mock.calls.length;
    await user.click(screen.getByRole('button', { name: '로그 조회' }));
    expect(mock.startLogStream).toHaveBeenCalledTimes(beforeRetry);
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

  it('retains hidden selection and in-flight logs while search, refresh and reconnect preserve their own focus', async () => {
    const user = userEvent.setup();
    const pending = deferred<RecentLogs>();
    mock.getRecentLogs.mockReturnValueOnce(pending.promise);
    render(<App />);
    await waitFor(() => expect(mock.getRecentLogs).toHaveBeenCalledTimes(1));
    const search = screen.getByRole('textbox', { name: '컨테이너 검색' });
    await user.type(search, 'redis');
    expect(search).toHaveFocus();
    expect(screen.getByRole('region', { name: '서비스 복구' })).toBeVisible();
    expect(screen.getByRole('treeitem', { name: 'redis 상세' })).toHaveAttribute('aria-selected', 'false');
    await act(async () => pending.resolve(log('session-1', 'backend-1', 'accepted hidden-target logs')));
    expect(screen.getByLabelText('최근 로그 내용')).toHaveTextContent('accepted hidden-target logs');
    expect(screen.getByText('현재 대상이 검색 또는 상태 필터에 가려져 있습니다.')).toBeVisible();
    expect(mock.getRecentLogs).toHaveBeenCalledTimes(1);
    await user.clear(search);
    expect(screen.getByRole('treeitem', { name: 'backend 상세' })).toHaveAttribute('aria-selected', 'true');
    await user.click(screen.getByRole('button', { name: '새로고침' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '새로고침' })).toBeEnabled());
    expect(screen.getByRole('region', { name: '서비스 복구' })).toBeVisible();
    expect(mock.getRecentLogs).toHaveBeenCalledTimes(2);
    await user.click(screen.getByRole('button', { name: '다시 연결' }));
    await connected();
    expect(screen.getByRole('treeitem', { name: 'backend 상세' })).toHaveAttribute('aria-selected', 'true');
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
    expect(screen.getByRole('treeitem', { name: 'backend 상세' })).toHaveAttribute('aria-selected', 'true');
    await act(async () => pending.resolve(list(2, [{ ...backend, name: 'renamed' }, redis])));
    expect(search).toHaveFocus();
    expect(screen.getByRole('region', { name: '서비스 복구' })).toBeVisible();
    expect(screen.getByText('검색 결과가 없습니다.')).toBeVisible();
    expect(screen.getByText('현재 대상이 검색 또는 상태 필터에 가려져 있습니다.')).toBeVisible();
    expect(mock.getRecentLogs).toHaveBeenCalledTimes(2);
  });

  it('preserves the selected details and filter focus when the current target becomes hidden', async () => {
    const user = userEvent.setup();
    render(<App />);
    await connected();
    const running = screen.getByRole('button', { name: '실행 중' });
    await user.click(running);
    expect(running).toHaveFocus();
    expect(screen.getByRole('treeitem', { name: 'backend 상세' })).toHaveAttribute('aria-selected', 'true');
    const stopped = within(screen.getByLabelText('컨테이너 필터')).getByRole('button', { name: '중지' });
    await user.click(stopped);
    expect(stopped).toHaveFocus();
    expect(screen.getByRole('region', { name: '서비스 복구' })).toBeVisible();
  });

  it('clears only the container query, preserves the state filter and visible selection, and restores search focus', async () => {
    const user = userEvent.setup();
    render(<App />);
    await connected();
    const search = screen.getByRole('textbox', { name: '컨테이너 검색' });
    const running = screen.getByRole('button', { name: '실행 중' });
    await user.click(running);
    await user.type(search, 'backend');
    const before = Object.entries(mock).filter(([name]) => name !== 'getContainerStats' && name !== 'readLogStream').map(([, method]) => method.mock.calls.length);
    await user.click(screen.getByRole('button', { name: '컨테이너 검색 지우기' }));
    expect(search).toHaveValue('');
    expect(search).toHaveFocus();
    expect(running).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('treeitem', { name: 'backend 상세' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('treeitem', { name: 'redis 상세' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '컨테이너 검색 지우기' })).not.toBeInTheDocument();
    expect(Object.entries(mock).filter(([name]) => name !== 'getContainerStats' && name !== 'readLogStream').map(([, method]) => method.mock.calls.length)).toEqual(before);
  });

  it('restores the selected row after clearing a query without restarting its retained log view', async () => {
    const user = userEvent.setup();
    render(<App />);
    await connected();
    await user.click(screen.getByRole('button', { name: '실행 중' }));
    const search = screen.getByRole('textbox', { name: '컨테이너 검색' });
    await user.type(search, 'missing-container');
    expect(screen.getByRole('region', { name: '서비스 복구' })).toBeVisible();
    const before = Object.entries(mock).filter(([name]) => name !== 'getContainerStats' && name !== 'readLogStream').map(([, method]) => method.mock.calls.length);
    const clear = screen.getByRole('button', { name: '컨테이너 검색 지우기' });
    clear.focus();
    await user.keyboard('{Enter}');
    expect(search).toHaveFocus();
    expect(search).toHaveValue('');
    expect(screen.getByRole('button', { name: '실행 중' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('treeitem', { name: 'backend 상세' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('treeitem', { name: 'redis 상세' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('최근 로그 내용')).toHaveTextContent('raw logs');
    expect(screen.queryByText('현재 대상이 검색 또는 상태 필터에 가려져 있습니다.')).not.toBeInTheDocument();
    expect(Object.entries(mock).filter(([name]) => name !== 'getContainerStats' && name !== 'readLogStream').map(([, method]) => method.mock.calls.length)).toEqual(before);
  });

  it.each(['0123456789ABCDEF0123456789ABCDEF', 'FFAB', '8080/TCP'])('supports case-insensitive partial full-ID and port search: %s', async query => {
    const user = userEvent.setup();
    render(<App />);
    await connected();
    await user.type(screen.getByRole('textbox', { name: '컨테이너 검색' }), ` ${query} `);
    expect(screen.getByRole('treeitem', { name: 'backend 상세' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('treeitem', { name: 'redis 상세' })).not.toBeInTheDocument();
  });

  it.each([true, false])('restores focus only when the refreshed list removes its focused row (remaining=%s)', async remaining => {
    const user = userEvent.setup();
    render(<App />);
    await connected();
    const pending = deferred<ContainerList>();
    mock.listContainers.mockReturnValueOnce(pending.promise);
    await user.click(screen.getByRole('button', { name: '새로고침' }));
    screen.getByRole('treeitem', { name: 'backend 상세' }).focus();
    await act(async () => pending.resolve(list(2, remaining ? [redis] : [])));
    expect(remaining ? screen.getByRole('treeitem', { name: '프로젝트 없음' }) : screen.getByRole('textbox', { name: '컨테이너 검색' })).toHaveFocus();
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
      expect(screen.queryByText(/목록 갱신 시각/)).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('tab', { name: '접속 정보' }));
      expect(screen.getByText(/목록 갱신 시각/)).toBeVisible();
    } finally { vi.useRealTimers(); }
  });

  it('rejects a queued confirmation when the selected target changes before React renders', async () => {
    const user = userEvent.setup();
    render(<App />);
    await connected();
    await user.click(within(screen.getByRole('region', { name: '서비스 복구' })).getByRole('button', { name: '중지' }));
    const confirm = screen.getByRole<HTMLButtonElement>('button', { name: '중지 확인' });
    const other = screen.getByRole<HTMLDivElement>('treeitem', { name: 'redis 상세' });
    act(() => { fireEvent.click(other); confirm.click(); });
    expect(mock.mutateContainer).not.toHaveBeenCalled();
  });
});

describe('logs when a selected container becomes unreadable', () => {
  it.each(['removing', 'unknown'])('clears the old snapshot for %s while preserving selection and the open search', async state => {
    const user = userEvent.setup();
    mock.getRecentLogs.mockResolvedValueOnce({ ...log('session-1', 'backend-1'), truncated: true });
    render(<App />);
    await connected();
    expect(document.querySelector('.log-fetched-at time')).toBeInTheDocument();
    expect(screen.getByText(/로그 앞부분이 잘렸습니다/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: '로그 검색 열기' }));
    const search = screen.getByRole('searchbox', { name: '로그 검색' });
    await user.type(search, 'raw');
    expect(screen.getByText('1 / 1건')).toBeVisible();
    mock.listContainers.mockResolvedValueOnce(list(2, [{ ...backend, state }, redis]));

    await user.click(screen.getByRole('button', { name: '새로고침' }));

    const output = screen.getByLabelText('최근 로그 내용');
    expect(output).toHaveTextContent('현재 상태에서는 로그를 조회할 수 없습니다.');
    expect(output).not.toHaveTextContent('raw logs');
    expect(output).toHaveAttribute('aria-busy', 'false');
    expect(document.querySelector('.log-fetched-at')).not.toBeInTheDocument();
    expect(screen.queryByText(/로그 앞부분이 잘렸습니다/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '로그 조회' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '표시된 로그 복사' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '로그 화면 비우기' })).toBeDisabled();
    expect(screen.getByRole('treeitem', { name: 'backend 상세' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('searchbox', { name: '로그 검색' })).toBe(search);
    expect(search).toHaveValue('raw');
    expect(screen.getByRole('button', { name: '로그 검색 닫기' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('0건')).toBeVisible();
    expect(screen.getByRole('button', { name: '이전 일치' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '다음 일치' })).toBeDisabled();
    expect(output.querySelector('mark')).toBeNull();
    expect(mock.getRecentLogs).toHaveBeenCalledTimes(1);
  });

  it('keeps an expanded search open and recalculates it from one new fetch when the same container becomes readable again', async () => {
    const user = userEvent.setup();
    render(<App />);
    await connected();
    await user.click(screen.getByRole('button', { name: '로그 검색 열기' }));
    await user.type(screen.getByRole('searchbox', { name: '로그 검색' }), 'raw');
    const pending = deferred<ContainerList>();
    mock.listContainers.mockReturnValueOnce(pending.promise);
    await user.click(screen.getByRole('button', { name: '새로고침' }));
    await user.click(screen.getByRole('button', { name: '로그 확대 보기' }));
    const dialog = screen.getByRole('dialog', { name: 'backend · 로그 확대 보기' });
    const search = within(dialog).getByRole('searchbox', { name: '로그 검색' });

    await act(async () => pending.resolve(list(2, [{ ...backend, state: 'unknown' }, redis])));

    expect(screen.getByRole('dialog', { name: 'backend · 로그 확대 보기' })).toBe(dialog);
    expect(within(dialog).getByRole('searchbox', { name: '로그 검색' })).toBe(search);
    expect(search).toHaveValue('raw');
    expect(within(dialog).getByRole('button', { name: '로그 검색 닫기' })).toHaveAttribute('aria-expanded', 'true');
    expect(within(dialog).getByLabelText('최근 로그 내용')).toHaveTextContent('현재 상태에서는 로그를 조회할 수 없습니다.');
    expect(within(dialog).getByText('0건')).toBeVisible();
    expect(within(dialog).getByRole('button', { name: '표시된 로그 복사' })).toBeDisabled();
    expect(mock.getRecentLogs).toHaveBeenCalledTimes(1);

    await user.click(within(dialog).getByRole('button', { name: '로그 확대 보기 닫기' }));
    mock.listContainers.mockResolvedValueOnce(list(3));
    mock.getRecentLogs.mockResolvedValueOnce(log('session-1', 'backend-3', 'RAW restored\nraw again'));
    await user.click(screen.getByRole('button', { name: '새로고침' }));

    await waitFor(() => expect(screen.getByLabelText('최근 로그 내용')).toHaveTextContent('RAW restored raw again'));
    expect(screen.getByRole('searchbox', { name: '로그 검색' })).toHaveValue('raw');
    expect(await screen.findByText('1 / 2건')).toBeVisible();
    expect(screen.getByLabelText('최근 로그 내용').querySelector('mark')).toHaveTextContent('RAW');
    expect(screen.getByRole('button', { name: '표시된 로그 복사' })).toBeEnabled();
    expect(screen.getByRole('treeitem', { name: 'backend 상세' })).toHaveAttribute('aria-selected', 'true');
    expect(mock.getRecentLogs).toHaveBeenCalledTimes(2);
    expect(mock.getRecentLogs).toHaveBeenLastCalledWith('session-1', 'backend-3');
  });

  it.each(['LogsUnavailable', 'Disconnected'])('clears a previous %s log error without changing the connection warning', async code => {
    const user = userEvent.setup();
    render(<App />);
    await connected();
    mock.getRecentLogs.mockRejectedValueOnce({ code, message: 'previous log failure' });
    await user.click(screen.getByRole('button', { name: '로그 조회' }));
    expect(await screen.findByText('최근 로그를 읽지 못했습니다.')).toBeVisible();
    expectConnection(code === 'Disconnected' ? '연결 재확인 필요' : '로컬 · 연결됨');
    const pendingRefresh = deferred<ContainerList>();
    mock.listContainers.mockReturnValueOnce(pendingRefresh.promise);

    const refreshButton = screen.getByRole('button', { name: '새로고침' });
    await user.click(refreshButton);

    expect(refreshButton).toBeDisabled();
    expect(screen.getByText('최근 로그를 읽지 못했습니다.')).toBeVisible();
    expectConnection(code === 'Disconnected' ? '연결 재확인 필요' : '로컬 · 연결됨');
    await act(async () => pendingRefresh.resolve(list(2, [{ ...backend, state: 'removing' }, redis])));

    // Inventory renders first; the log controller clears the old error in its update effect.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '새로고침' })).toBeEnabled();
      expect(screen.getByLabelText('최근 로그 내용')).toHaveTextContent('현재 상태에서는 로그를 조회할 수 없습니다.');
      expect(screen.queryByText('최근 로그를 읽지 못했습니다.')).not.toBeInTheDocument();
      expect(screen.queryByText('previous log failure')).not.toBeInTheDocument();
    });
    expect(document.querySelector('.log-fetched-at')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '표시된 로그 복사' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '로그 화면 비우기' })).toBeDisabled();
    expectConnection(code === 'Disconnected' ? '연결 재확인 필요' : '로컬 · 연결됨');
    expect(mock.getRecentLogs).toHaveBeenCalledTimes(2);
  });

  it.each(['success', 'failure'])('discards a late log %s view after accepting unreadable state while preserving session warnings', async outcome => {
    const user = userEvent.setup();
    render(<App />);
    await connected();
    const pending = deferred<RecentLogs>();
    mock.getRecentLogs.mockReturnValueOnce(pending.promise);
    await user.click(screen.getByRole('button', { name: '로그 조회' }));
    expect(screen.getByLabelText('최근 로그 내용')).toHaveAttribute('aria-busy', 'true');
    mock.listContainers.mockResolvedValueOnce(list(2, [{ ...backend, state: 'unknown' }, redis]));
    await user.click(screen.getByRole('button', { name: '새로고침' }));
    await waitFor(() => expect(screen.getByLabelText('최근 로그 내용')).toHaveTextContent('현재 상태에서는 로그를 조회할 수 없습니다.'));

    await act(async () => {
      if (outcome === 'success') pending.resolve({ ...log('session-1', 'backend-1', 'late discarded logs'), truncated: true });
      else pending.reject({ code: 'Disconnected', message: 'late discarded log failure' });
    });

    expect(screen.getByLabelText('최근 로그 내용')).toHaveTextContent('현재 상태에서는 로그를 조회할 수 없습니다.');
    expect(screen.getByLabelText('최근 로그 내용')).toHaveAttribute('aria-busy', 'false');
    expect(screen.queryByText('late discarded logs')).not.toBeInTheDocument();
    expect(screen.queryByText('late discarded log failure')).not.toBeInTheDocument();
    expect(screen.queryByText('최근 로그를 읽지 못했습니다.')).not.toBeInTheDocument();
    expect(document.querySelector('.log-fetched-at')).not.toBeInTheDocument();
    expect(screen.queryByText(/로그 앞부분이 잘렸습니다/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '표시된 로그 복사' })).toBeDisabled();
    expectConnection(outcome === 'failure' ? '연결 재확인 필요' : '로컬 · 연결됨');
    expect(mock.getRecentLogs).toHaveBeenCalledTimes(2);
  });

  it.each(['failed', 'duplicate generation', 'older generation', 'marked stale'])('preserves the last good logs when the refreshed list is %s', async outcome => {
    const user = userEvent.setup();
    mock.getRecentLogs.mockResolvedValueOnce({ ...log('session-1', 'backend-1'), truncated: true });
    render(<App />);
    await connected();
    const fetchedAt = document.querySelector('.log-fetched-at time')?.getAttribute('datetime');
    await user.click(screen.getByRole('button', { name: '로그 검색 열기' }));
    await user.type(screen.getByRole('searchbox', { name: '로그 검색' }), 'raw');
    if (outcome === 'failed') mock.listContainers.mockRejectedValueOnce({ code: 'Timeout', message: 'list failed' });
    else mock.listContainers.mockResolvedValueOnce({ ...list(outcome === 'older generation' ? 0 : outcome === 'duplicate generation' ? 1 : 2, [{ ...backend, state: 'unknown' }, redis]), stale: outcome === 'marked stale' });

    await user.click(screen.getByRole('button', { name: '새로고침' }));

    expect(screen.getByLabelText('최근 로그 내용')).toHaveTextContent('raw logs');
    expect(document.querySelector('.log-fetched-at time')).toHaveAttribute('datetime', fetchedAt);
    expect(screen.getByText(/로그 앞부분이 잘렸습니다/)).toBeVisible();
    expect(screen.getByRole('button', { name: '표시된 로그 복사' })).toBeEnabled();
    expect(screen.getByRole('treeitem', { name: 'backend 상세' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('searchbox', { name: '로그 검색' })).toHaveValue('raw');
    expect(screen.getByText('1 / 1건')).toBeVisible();
    expect(mock.getRecentLogs).toHaveBeenCalledTimes(1);
  });
});
