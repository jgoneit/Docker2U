import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { api } from './api';
import type { Container, ContainerList, Environment, MutationResult, LogStreamRead } from './api';
import { PREFERENCES_KEY } from './preferences';

vi.mock('./api', async importOriginal => ({
  ...await importOriginal<typeof import('./api')>(),
  api: { getEnvironment: vi.fn(), listContainers: vi.fn(), getRecentLogs: vi.fn(), startLogStream: vi.fn(), readLogStream: vi.fn(), stopLogStream: vi.fn(), getContainerStats: vi.fn(), mutateContainer: vi.fn(), mutateContainers: vi.fn() },
}));
const mock = vi.mocked(api);
const container: Container = { handle: 'handle-1', fullId: 'a'.repeat(64), shortId: 'a'.repeat(12), composeProject: null, composeService: null, name: 'backend', image: 'local/api:1', state: 'running', health: 'healthy', ports: [], createdAt: '2026-09-06T00:00:00Z' };
const environment: Environment = { status: 'ready', sessionId: 'session-1', contextName: 'local', endpoint: 'unix:///local.sock', dockerPath: '/local/docker', dockerConfigPath: '/local/config', clientVersion: '29', serverVersion: '29', apiVersion: '1.54', engineId: 'engine-1', osType: 'linux', architecture: 'arm64', mutationAllowed: true, error: null, diagnostics: [] };
const snapshot: ContainerList = { sessionId: 'session-1', generation: 1, containers: [container], refreshedAt: '2026-09-06T00:00:00Z', stale: false };
const logs: LogStreamRead = { sessionId: 'session-1', streamId: 'stream-1', sequence: 1, text: '원문 raw log\nLAST_LINE', truncated: false, terminal: false, error: null };
const succeeded: MutationResult = { outcome: 'succeeded', message: 'Original native response', command: 'docker restart exact-id', stderr: '', reconciliation: 'notNeeded', mutationBlocked: false };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}
function callCounts() {
  // Background read/stat cadence continues; preferences must not create another session/stream or mutation.
  return [mock.getEnvironment, mock.listContainers, mock.getRecentLogs, mock.startLogStream, mock.stopLogStream, mock.mutateContainer, mock.mutateContainers].map(method => method.mock.calls.length);
}
async function settings(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: '설정' }));
  return within(screen.getByRole('dialog', { name: '설정' }));
}
async function toEnglishAndLight(user: ReturnType<typeof userEvent.setup>) {
  const dialog = await settings(user);
  await user.selectOptions(dialog.getByRole('combobox', { name: '테마' }), 'light');
  await user.selectOptions(dialog.getByRole('combobox', { name: '언어' }), 'en');
  fireEvent.keyDown(screen.getByRole('dialog', { name: 'Settings' }), { key: 'Escape' });
}
function scrollUp(content: HTMLElement) {
  Object.defineProperties(content, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 100 } });
  content.scrollTop = 100;
  fireEvent.scroll(content);
}
beforeEach(() => {
  vi.resetAllMocks();
  window.localStorage.clear();
  window.localStorage.setItem(PREFERENCES_KEY, JSON.stringify({ theme: 'dark', language: 'ko' }));
  mock.getEnvironment.mockResolvedValue(environment);
  mock.listContainers.mockResolvedValue(snapshot);
  mock.startLogStream.mockResolvedValue({ sessionId: 'session-1', streamId: 'stream-1', fullId: container.fullId });
  mock.stopLogStream.mockResolvedValue();
  mock.getContainerStats.mockReturnValue(new Promise(() => {}));
  mock.readLogStream.mockResolvedValue(logs);
  mock.mutateContainer.mockResolvedValue(succeeded);
});

describe('appearance and language preserve the active Docker session', () => {
  it('preserves search, selection, checkboxes, raw logs and scroll without making API calls', async () => {
    const user = userEvent.setup();
    render(<App />);
    const output = await screen.findByLabelText('최근 로그 내용');
    await screen.findByText(/LAST_LINE/);
    await user.type(screen.getByRole('textbox', { name: '컨테이너 검색' }), 'backend');
    await user.click(screen.getByRole('checkbox', { name: 'backend 작업 대상으로 선택' }));
    const information = screen.getByText('컨테이너 정보').closest('details');
    await user.click(screen.getByText('컨테이너 정보'));
    const copyButton = screen.getByRole('button', { name: '표시된 로그 복사' });
    output.scrollTop = 145;
    fireEvent.scroll(output);
    const before = callCounts();
    await toEnglishAndLight(user);
    expect(document.documentElement).toHaveAttribute('data-theme', 'light');
    expect(document.documentElement).toHaveAttribute('lang', 'en');
    expect(screen.getByRole('textbox', { name: 'Search containers' })).toHaveValue('backend');
    expect(screen.getByRole('checkbox', { name: 'Select backend for an action' })).toBeChecked();
    expect(screen.getByRole('button', { name: 'backend details' })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByLabelText('Recent log content')).toBe(output);
    expect(output.textContent).toBe(logs.text);
    expect(output.scrollTop).toBe(145);
    expect(screen.getByText('Container information').closest('details')).toBe(information);
    expect(information).toHaveAttribute('open');
    expect(screen.getByRole('button', { name: 'Copy displayed logs' })).toBe(copyButton);
    expect(copyButton).toBeVisible();
    expect(callCounts()).toEqual(before);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Settings' })).toHaveFocus());
  });

  it('keeps log navigation and its active match local across expansion, theme and language changes', async () => {
    const user = userEvent.setup();
    mock.readLogStream.mockResolvedValue({ ...logs, text: 'raw first\nRAW second' });
    render(<App />);
    await screen.findByText(/RAW second/);
    const before = callCounts();
    expect(screen.queryByRole('searchbox', { name: '로그 검색' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '로그 검색 열기' }));
    await user.type(screen.getByRole('searchbox', { name: '로그 검색' }), 'raw');
    await user.keyboard('{Enter}');
    expect(screen.getByText('2 / 2건')).toBeVisible();
    expect(screen.queryByRole('button', { name: '최신 로그로' })).not.toBeInTheDocument();
    scrollUp(screen.getByLabelText('최근 로그 내용'));
    await user.click(screen.getByRole('button', { name: '최신 로그로' }));
    expect(screen.queryByRole('button', { name: '최신 로그로' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '로그 확대 보기' }));
    const expanded = within(screen.getByRole('dialog'));
    expect(expanded.getByRole('searchbox', { name: '로그 검색' })).toHaveValue('raw');
    expect(expanded.getByText('2 / 2건')).toBeVisible();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await user.click(screen.getByRole('button', { name: '로그 검색 닫기' }));
    expect(screen.queryByRole('searchbox', { name: '로그 검색' })).not.toBeInTheDocument();
    await toEnglishAndLight(user);
    expect(screen.queryByRole('searchbox', { name: 'Search logs' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open log search' }));
    expect(screen.getByRole('searchbox', { name: 'Search logs' })).toHaveValue('raw');
    expect(screen.getByText('2 / 2 matches')).toBeVisible();
    scrollUp(screen.getByLabelText('Recent log content'));
    await user.click(screen.getByRole('button', { name: 'Latest logs' }));
    expect(screen.queryByRole('button', { name: 'Latest logs' })).not.toBeInTheDocument();
    expect(callCounts()).toEqual(before);
  });

  it('accepts an in-flight log response after preference changes without reloading it', async () => {
    const pending = deferred<LogStreamRead>();
    mock.readLogStream.mockReturnValueOnce(pending.promise);
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => expect(mock.startLogStream).toHaveBeenCalledTimes(1));
    const before = callCounts();
    await toEnglishAndLight(user);
    expect(callCounts()).toEqual(before);
    await act(async () => pending.resolve(logs));
    expect(screen.getByLabelText('Recent log content').textContent).toBe(logs.text);
    expect(mock.startLogStream).toHaveBeenCalledTimes(1);
  });

  it('clears an in-flight log request and ignores its late response without leaving a spinner', async () => {
    const pending = deferred<LogStreamRead>();
    mock.readLogStream.mockReturnValueOnce(pending.promise);
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => expect(mock.startLogStream).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole('button', { name: '로그 화면 비우기' }));
    expect(screen.getByLabelText('최근 로그 내용')).toHaveAttribute('aria-busy', 'false');
    await act(async () => pending.resolve(logs));
    expect(screen.queryByText(/LAST_LINE/)).not.toBeInTheDocument();
    expect(screen.getByLabelText('최근 로그 내용')).toHaveTextContent('로그 조회를 눌러 로그를 확인하세요.');
    expect(mock.startLogStream).toHaveBeenCalledTimes(1);
  });

  it('preserves a pending refresh and keeps its existing stream across handle rotation', async () => {
    const pending = deferred<ContainerList>();
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText(/LAST_LINE/);
    mock.listContainers.mockReturnValueOnce(pending.promise);
    await user.click(screen.getByRole('button', { name: '새로고침' }));
    const before = callCounts();
    await toEnglishAndLight(user);
    expect(screen.getByRole('button', { name: 'Refreshing…' })).toBeDisabled();
    expect(callCounts()).toEqual(before);
    await act(async () => pending.resolve({ ...snapshot, generation: 2, containers: [{ ...container, handle: 'handle-2' }] }));
    await waitFor(() => expect(screen.getByLabelText('Recent log content').textContent).toBe(logs.text));
    expect(mock.listContainers).toHaveBeenCalledTimes(2);
    expect(mock.startLogStream).toHaveBeenCalledExactlyOnceWith('session-1', 1, 'handle-1');
    expect(mock.stopLogStream).not.toHaveBeenCalled();
  });

  it('keeps a mutation pending across preference changes and reconciles it once', async () => {
    const pending = deferred<MutationResult>();
    mock.mutateContainer.mockReturnValueOnce(pending.promise);
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText(/LAST_LINE/);
    await user.click(screen.getByRole('button', { name: '재시작' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '재시작 확인' }));
    const before = callCounts();
    await toEnglishAndLight(user);
    expect(screen.getByRole('button', { name: 'Restart' })).toBeDisabled();
    expect(callCounts()).toEqual(before);
    mock.listContainers.mockResolvedValue({ ...snapshot, generation: 2 });
    await act(async () => pending.resolve(succeeded));
    await screen.findByRole('heading', { name: /^Succeeded · Restart · backend$/ });
    expect(mock.mutateContainer).toHaveBeenCalledExactlyOnceWith('session-1', 'handle-1', 'restart');
    expect(mock.listContainers).toHaveBeenCalledTimes(2);
    expect(mock.getEnvironment).toHaveBeenCalledTimes(1);
  });

  it('keeps settings, expanded logs and confirmation dialogs mutually exclusive', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText(/LAST_LINE/);
    const dialog = await settings(user);
    expect(document.querySelector('.main-content')).toHaveAttribute('inert');
    expect(dialog.getByRole('combobox', { name: '테마' })).toHaveFocus();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await user.click(screen.getByRole('button', { name: '로그 확대 보기' }));
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(document.querySelector('.main-content')).toHaveAttribute('inert');
    expect(screen.getByRole('button', { name: '설정' }).closest('[inert]')).toBe(document.querySelector('.main-content'));
    expect(screen.getByRole('dialog').closest('[inert]')).toBeNull();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(document.querySelector('.main-content')).not.toHaveAttribute('inert');
    expect(mock.startLogStream).toHaveBeenCalledTimes(1);
  });

  it('retranslates clipboard status and restores saved preferences on a fresh mount', async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    const mounted = render(<App />);
    await screen.findByText(/LAST_LINE/);
    const feedback = within(screen.getByRole('contentinfo')).getByRole('status');
    expect(feedback).toHaveAttribute('aria-live', 'polite');
    expect(feedback).toHaveAttribute('aria-atomic', 'true');
    expect(feedback).toBeEmptyDOMElement();
    await user.click(screen.getByRole('button', { name: '표시된 로그 복사' }));
    await within(feedback).findByText('표시된 로그 복사됨');
    const notification = feedback.querySelector('.copy-feedback-text');
    expect(feedback).toHaveClass('copy-feedback-success');
    await toEnglishAndLight(user);
    expect(screen.getByText('Displayed logs copied')).toBeVisible();
    expect(within(screen.getByRole('contentinfo')).getByRole('status')).toBe(feedback);
    expect(feedback.querySelector('.copy-feedback-text')).toBe(notification);
    mounted.unmount();
    render(<App />);
    await screen.findByRole('button', { name: 'backend details' });
    expect(document.documentElement).toHaveAttribute('data-theme', 'light');
    expect(document.documentElement).toHaveAttribute('lang', 'en');
    expect(screen.queryByText('표시된 로그 복사됨')).not.toBeInTheDocument();
    expect(within(screen.getByRole('contentinfo')).getByRole('status')).toBeEmptyDOMElement();
  });
});

describe('clipboard feedback follows the latest copy attempt', () => {
  it('re-enters repeated successes and distinguishes a failure from the next successful copy', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    render(<App />);
    const output = await screen.findByLabelText('최근 로그 내용');
    await screen.findByText(/LAST_LINE/);
    const feedback = within(screen.getByRole('contentinfo')).getByRole('status');
    const copyButton = screen.getByRole('button', { name: '표시된 로그 복사' });
    const before = callCounts();

    await user.click(copyButton);
    await within(feedback).findByText('표시된 로그 복사됨');
    const firstSuccess = feedback.querySelector('.copy-feedback-text');
    expect(feedback).toHaveClass('copy-feedback-success');
    await user.click(copyButton);
    const repeatedSuccess = feedback.querySelector('.copy-feedback-text');
    expect(feedback).toHaveClass('copy-feedback-success');
    expect(repeatedSuccess).not.toBe(firstSuccess);
    expect(firstSuccess).not.toBeInTheDocument();
    expect(within(screen.getByRole('contentinfo')).getByRole('status')).toBe(feedback);

    writeText.mockRejectedValueOnce(new Error('Clipboard denied'));
    await user.click(copyButton);
    await within(feedback).findByText('클립보드에 복사하지 못했습니다.');
    expect(feedback).toHaveClass('copy-feedback-error');
    expect(feedback).not.toHaveClass('copy-feedback-success');
    await user.click(copyButton);
    await within(feedback).findByText('표시된 로그 복사됨');
    expect(feedback).toHaveClass('copy-feedback-success');
    expect(feedback).not.toHaveClass('copy-feedback-error');
    expect(writeText.mock.calls).toEqual(Array.from({ length: 4 }, () => [logs.text]));
    expect(copyButton).toHaveFocus();
    expect(output.textContent).toBe(logs.text);
    expect(screen.getByRole('button', { name: 'backend 상세' })).toHaveAttribute('aria-current', 'true');
    expect(callCounts()).toEqual(before);
  });

  it.each([
    { older: 'success', newer: 'success' },
    { older: 'failure', newer: 'success' },
    { older: 'success', newer: 'failure' },
  ])('ignores an older $older after the newest copy reports $newer', async ({ older, newer }) => {
    const user = userEvent.setup();
    const pending = deferred<void>();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockReturnValueOnce(pending.promise);
    if (newer === 'success') writeText.mockResolvedValueOnce();
    else writeText.mockRejectedValueOnce(new Error('Latest clipboard denied'));
    render(<App />);
    await screen.findByText(/LAST_LINE/);
    const before = callCounts();
    const feedback = within(screen.getByRole('contentinfo')).getByRole('status');
    await user.click(screen.getByRole('button', { name: '표시된 로그 복사' }));
    expect(feedback).toBeEmptyDOMElement();
    await user.click(screen.getByText('컨테이너 정보'));
    await user.click(screen.getByRole('button', { name: '전체 ID 복사' }));
    const latestMessage = newer === 'success' ? '전체 ID 복사됨' : '클립보드에 복사하지 못했습니다.';
    await within(feedback).findByText(latestMessage);
    const latestNotification = feedback.querySelector('.copy-feedback-text');
    expect(feedback).toHaveClass(newer === 'success' ? 'copy-feedback-success' : 'copy-feedback-error');
    await act(async () => {
      if (older === 'success') pending.resolve();
      else pending.reject(new Error('Older clipboard denied'));
    });
    expect(feedback).toHaveTextContent(latestMessage);
    expect(feedback.querySelector('.copy-feedback-text')).toBe(latestNotification);
    expect(writeText.mock.calls).toEqual([[logs.text], [container.fullId]]);
    expect(screen.getByLabelText('최근 로그 내용').textContent).toBe(logs.text);
    expect(callCounts()).toEqual(before);
  });

  it('shows a real clipboard failure inside expanded logs and recovers without altering the search view', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValueOnce(new Error('Clipboard denied')).mockResolvedValue();
    render(<App />);
    await screen.findByText(/LAST_LINE/);
    await user.click(screen.getByRole('button', { name: '로그 확대 보기' }));
    const dialog = within(screen.getByRole('dialog'));
    await user.click(dialog.getByRole('button', { name: '로그 검색 열기' }));
    const search = dialog.getByRole('searchbox', { name: '로그 검색' });
    await user.type(search, 'raw');
    const content = dialog.getByLabelText('최근 로그 내용');
    content.scrollTop = 145;
    fireEvent.scroll(content);
    const before = callCounts();
    const feedback = screen.getByRole('dialog').querySelector<HTMLElement>('.log-copy-feedback')!;
    expect(feedback).toHaveAttribute('role', 'status');
    expect(feedback).toBeEmptyDOMElement();
    const copyButton = dialog.getByRole('button', { name: '표시된 로그 복사' });

    await user.click(copyButton);
    await within(feedback).findByText('클립보드에 복사하지 못했습니다.');
    expect(feedback).toHaveClass('copy-feedback-error');
    expect(feedback).not.toHaveClass('copy-feedback-success');
    expect(within(screen.getByRole('contentinfo')).getByRole('status')).toHaveClass('copy-feedback-error');
    await user.click(copyButton);
    await within(feedback).findByText('표시된 로그 복사됨');
    expect(feedback).toHaveClass('copy-feedback-success');
    expect(feedback).not.toHaveClass('copy-feedback-error');
    expect(writeText.mock.calls).toEqual([[logs.text], [logs.text]]);
    expect(dialog.getByRole('searchbox', { name: '로그 검색' })).toBe(search);
    expect(search).toHaveValue('raw');
    expect(dialog.getByText('1 / 1건')).toBeVisible();
    expect(dialog.getByLabelText('최근 로그 내용')).toBe(content);
    expect(content.textContent).toBe(logs.text);
    expect(content.scrollTop).toBe(145);
    expect(copyButton).toHaveFocus();
    expect(callCounts()).toEqual(before);
  });

  it.each(['success', 'failure'])('does not revive a pending copy %s in a closed and reopened log dialog', async outcome => {
    const user = userEvent.setup();
    const pending = deferred<void>();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockReturnValueOnce(pending.promise).mockResolvedValue();
    render(<App />);
    await screen.findByText(/LAST_LINE/);
    const before = callCounts();
    await user.click(screen.getByRole('button', { name: '로그 확대 보기' }));
    const originalDialog = screen.getByRole('dialog');
    await user.click(within(originalDialog).getByRole('button', { name: '표시된 로그 복사' }));
    expect(originalDialog.querySelector('.log-copy-feedback')).toBeEmptyDOMElement();
    fireEvent.keyDown(originalDialog, { key: 'Escape' });
    await user.click(screen.getByRole('button', { name: '로그 확대 보기' }));
    const reopenedDialog = screen.getByRole('dialog');
    expect(reopenedDialog).not.toBe(originalDialog);
    const feedback = reopenedDialog.querySelector<HTMLElement>('.log-copy-feedback')!;
    expect(feedback).toBeEmptyDOMElement();
    await act(async () => {
      if (outcome === 'success') pending.resolve();
      else pending.reject(new Error('Previous dialog clipboard denied'));
    });
    // The operation can finish globally, but the new dialog must not claim it initiated that copy.
    expect(within(screen.getByRole('contentinfo')).getByRole('status')).toHaveTextContent(outcome === 'success' ? '표시된 로그 복사됨' : '클립보드에 복사하지 못했습니다.');
    expect(feedback).toBeEmptyDOMElement();
    await user.click(within(reopenedDialog).getByRole('button', { name: '표시된 로그 복사' }));
    await within(feedback).findByText('표시된 로그 복사됨');
    expect(feedback).toHaveClass('copy-feedback-success');
    expect(writeText.mock.calls).toEqual([[logs.text], [logs.text]]);
    expect(within(reopenedDialog).getByLabelText('최근 로그 내용').textContent).toBe(logs.text);
    expect(callCounts()).toEqual(before);
  });
});

function dispatchFind(modifiers: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean }) {
  const event = new KeyboardEvent('keydown', { key: 'f', bubbles: true, cancelable: true, ...modifiers });
  act(() => { (document.activeElement ?? document).dispatchEvent(event); });
  return event;
}

describe('log search shortcut routing', () => {
  it.each([
    { platform: 'MacIntel', modifier: { metaKey: true }, otherModifier: { ctrlKey: true } },
    { platform: 'macOS', modifier: { metaKey: true }, otherModifier: { ctrlKey: true } },
    { platform: 'Linux x86_64', modifier: { ctrlKey: true }, otherModifier: { metaKey: true } },
  ])('opens and refocuses the inline log search with the platform shortcut on $platform', async ({ platform, modifier, otherModifier }) => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform);
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText(/LAST_LINE/);
    const before = callCounts();
    const containerSearch = screen.getByRole('textbox', { name: '컨테이너 검색' });
    containerSearch.focus();
    expect(dispatchFind(otherModifier).defaultPrevented).toBe(false);
    expect(containerSearch).toHaveFocus();
    expect(screen.queryByRole('searchbox', { name: '로그 검색' })).not.toBeInTheDocument();
    expect(dispatchFind(modifier).defaultPrevented).toBe(true);
    const search = screen.getByRole<HTMLInputElement>('searchbox', { name: '로그 검색' });
    expect(search).toHaveFocus();
    await user.type(search, 'raw');
    containerSearch.focus();
    expect(dispatchFind(modifier).defaultPrevented).toBe(true);
    expect(search).toHaveFocus();
    expect(search.selectionStart).toBe(0);
    expect(search.selectionEnd).toBe(3);
    expect(search).toHaveValue('raw');
    expect(screen.getByRole('button', { name: '로그 검색 닫기' })).toHaveAttribute('aria-expanded', 'true');
    expect(callCounts()).toEqual(before);
  });

  it.each(['settings', 'confirmation'])('leaves the active %s dialog and native find shortcut untouched', async activeDialog => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText(/LAST_LINE/);
    if (activeDialog === 'settings') await settings(user);
    else await user.click(screen.getByRole('button', { name: '재시작' }));
    const focused = document.activeElement;
    const before = callCounts();
    expect(dispatchFind({ metaKey: true }).defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(focused);
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.queryByRole('searchbox', { name: '로그 검색' })).not.toBeInTheDocument();
    expect(callCounts()).toEqual(before);
  });

  it('does not intercept find before a log panel exists or after its container is deselected', async () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    const pending = deferred<Environment>();
    mock.getEnvironment.mockReturnValueOnce(pending.promise);
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => expect(mock.getEnvironment).toHaveBeenCalledTimes(1));
    const pendingCalls = callCounts();
    expect(dispatchFind({ metaKey: true }).defaultPrevented).toBe(false);
    expect(callCounts()).toEqual(pendingCalls);
    await act(async () => pending.resolve(environment));
    await screen.findByText(/LAST_LINE/);
    const containerSearch = screen.getByRole('textbox', { name: '컨테이너 검색' });
    await user.type(containerSearch, 'missing');
    const before = callCounts();
    expect(screen.queryByLabelText('최근 로그 내용')).not.toBeInTheDocument();
    expect(dispatchFind({ metaKey: true }).defaultPrevented).toBe(false);
    expect(containerSearch).toHaveFocus();
    expect(callCounts()).toEqual(before);
  });

  it('routes find only to the expanded log search and preserves its query and active match', async () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    const user = userEvent.setup();
    mock.readLogStream.mockResolvedValue({ ...logs, text: 'raw first\nRAW second' });
    render(<App />);
    await screen.findByText(/RAW second/);
    const before = callCounts();
    expect(dispatchFind({ metaKey: true }).defaultPrevented).toBe(true);
    await user.type(screen.getByRole('searchbox', { name: '로그 검색' }), 'raw');
    await user.keyboard('{Enter}');
    await user.click(screen.getByRole('button', { name: '로그 확대 보기' }));
    const dialog = screen.getByRole('dialog');
    const expanded = within(dialog);
    expect(expanded.getByText('2 / 2건')).toBeVisible();
    await user.click(expanded.getByRole('button', { name: '로그 검색 닫기' }));
    expect(expanded.queryByRole('searchbox', { name: '로그 검색' })).not.toBeInTheDocument();
    expect(dispatchFind({ metaKey: true }).defaultPrevented).toBe(true);
    const search = expanded.getByRole<HTMLInputElement>('searchbox', { name: '로그 검색' });
    expect(search).toHaveFocus();
    expect(search).toHaveValue('raw');
    expect(search.selectionStart).toBe(0);
    expect(search.selectionEnd).toBe(3);
    expect(expanded.getByText('2 / 2건')).toBeVisible();
    expect(document.activeElement?.closest('[role="dialog"]')).toBe(dialog);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '로그 확대 보기' })).toHaveFocus();
    expect(screen.getByRole('searchbox', { name: '로그 검색' })).toHaveValue('raw');
    expect(screen.getByText('2 / 2건')).toBeVisible();
    expect(callCounts()).toEqual(before);
  });
});
