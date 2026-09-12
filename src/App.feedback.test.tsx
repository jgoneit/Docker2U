import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import App from './App';
import { CopyFeedback } from './CopyFeedback';
import { api, type Container } from './api';

vi.mock('./api', async original => ({ ...await original<typeof import('./api')>(), api: {
  getEnvironment: vi.fn(), listContainers: vi.fn(), getRecentLogs: vi.fn(), startLogStream: vi.fn(),
  readLogStream: vi.fn(), stopLogStream: vi.fn(), getContainerStats: vi.fn(), mutateContainer: vi.fn(), mutateContainers: vi.fn(),
} }));
const mock = vi.mocked(api);
const rows: Container[] = ['alpha', 'beta'].map((name, index) => ({ handle: name, fullId: String(index + 1).repeat(64), shortId: String(index + 1).repeat(12), name, image: 'fixture', state: 'running', health: null, ports: [], composeProject: null, composeService: null, createdAt: '' }));
const raw = 'raw log line\nLAST_LINE';
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const advance = (milliseconds: number) => act(async () => { await vi.advanceTimersByTimeAsync(milliseconds); });
const footerFeedback = () => screen.getByRole('contentinfo').querySelector<HTMLElement>('.clipboard-feedback')!;
// Dispatch without user-event's real-time scheduling; these tests own the clock.
const click = (element: HTMLElement) => act(async () => { element.focus(); fireEvent.click(element); });
const change = (element: HTMLElement, value: string) => act(async () => { fireEvent.change(element, { target: { value } }); });
function lifecycleCalls() {
  return [mock.getEnvironment, mock.listContainers, mock.getRecentLogs, mock.startLogStream, mock.stopLogStream, mock.mutateContainer, mock.mutateContainers].map(method => method.mock.calls.length);
}
async function mount() {
  userEvent.setup();
  render(<App />);
  await advance(0);
  expect(screen.getByLabelText('최근 로그 내용').textContent).toBe(raw);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-08T12:00:00Z'));
  vi.resetAllMocks();
  localStorage.setItem('docker2u.preferences.v1', JSON.stringify({ theme: 'dark', language: 'ko' }));
  mock.getEnvironment.mockResolvedValue({ status: 'ready', sessionId: 'one', contextName: 'fixture', endpoint: 'unix:///fixture.sock', dockerPath: '/fixture/docker', dockerConfigPath: '/fixture/config', clientVersion: '1', serverVersion: '1', apiVersion: '1', engineId: 'one', osType: 'linux', architecture: 'arm64', mutationAllowed: true, error: null, diagnostics: [] });
  let generation = 0;
  mock.listContainers.mockImplementation(async () => ({ sessionId: 'one', generation: ++generation, containers: rows, refreshedAt: '2026-09-08T12:00:00Z', stale: false }));
  mock.startLogStream.mockImplementation(async (sessionId, _generation, handle) => ({ sessionId, streamId: `stream-${handle}`, fullId: rows.find(row => row.handle === handle)!.fullId }));
  mock.readLogStream.mockImplementation(async (sessionId, streamId) => ({ sessionId, streamId, sequence: 1, text: raw, truncated: false, terminal: false, error: null }));
  mock.stopLogStream.mockResolvedValue();
  mock.getContainerStats.mockReturnValue(new Promise(() => {}));
});
afterEach(() => vi.useRealTimers());

it.each(['success', 'error'])('removes the %s highlight after two seconds while retaining both status texts and the paused search view', async outcome => {
  await mount();
  const write = vi.spyOn(navigator.clipboard, 'writeText');
  if (outcome === 'success') write.mockResolvedValue();
  else write.mockRejectedValue(new Error('Clipboard denied'));
  await click(screen.getByRole('button', { name: '일시정지' }));
  await click(screen.getByRole('button', { name: '로그 검색 열기' }));
  await change(screen.getByRole('searchbox', { name: '로그 검색' }), 'raw');
  await click(screen.getByRole('button', { name: '로그 확대 보기' }));
  const dialog = within(screen.getByRole('dialog'));
  const content = dialog.getByLabelText('최근 로그 내용');
  const search = dialog.getByRole('searchbox', { name: '로그 검색' });
  content.scrollTop = 145; fireEvent.scroll(content);
  const copy = dialog.getByRole('button', { name: '표시된 로그 복사' });
  await click(copy);
  const footer = footerFeedback(), modal = screen.getByRole('dialog').querySelector<HTMLElement>('.log-copy-feedback')!;
  const message = outcome === 'success' ? '표시된 로그 복사됨' : '클립보드에 복사하지 못했습니다.';
  expect(footer).toHaveTextContent(message);
  expect(modal).toHaveTextContent(message);
  expect(footer).toHaveClass(`copy-feedback-${outcome}`, 'copy-feedback-highlighted');
  expect(modal).toHaveClass(`copy-feedback-${outcome}`, 'copy-feedback-highlighted');
  expect(footer.querySelector('svg')).toBeNull();
  expect(modal.querySelector('svg')).toBeNull();
  const footerText = footer.querySelector('.copy-feedback-text'), modalText = modal.querySelector('.copy-feedback-text');
  const before = lifecycleCalls(), reads = mock.readLogStream.mock.calls.length;
  await advance(1_999);
  expect(footer).toHaveClass('copy-feedback-highlighted');
  expect(modal).toHaveClass('copy-feedback-highlighted');
  await advance(1);
  expect(footerFeedback()).toBe(footer);
  expect(screen.getByRole('dialog').querySelector('.log-copy-feedback')).toBe(modal);
  expect(footer).not.toHaveClass('copy-feedback-highlighted');
  expect(modal).not.toHaveClass('copy-feedback-highlighted');
  expect(footer.querySelector('.copy-feedback-glow')).toBeNull();
  expect(modal.querySelector('.copy-feedback-glow')).toBeNull();
  expect(footer).toHaveTextContent(message);
  expect(modal).toHaveTextContent(message);
  expect(footer.querySelector('.copy-feedback-text')).toBe(footerText);
  expect(modal.querySelector('.copy-feedback-text')).toBe(modalText);
  expect(dialog.getByLabelText('최근 로그 내용')).toBe(content);
  expect(content.textContent).toBe(raw);
  expect(content.scrollTop).toBe(145);
  expect(dialog.getByRole('searchbox', { name: '로그 검색' })).toBe(search);
  expect(search).toHaveValue('raw');
  expect(dialog.getByRole('button', { name: '재개' })).toHaveAttribute('aria-pressed', 'true');
  expect(copy).toHaveFocus();
  expect(lifecycleCalls()).toEqual(before);
  expect(mock.readLogStream.mock.calls.length).toBeGreaterThan(reads);
});

it.each(['success', 'error'])('keeps the original %s highlight deadline across language and theme changes', async outcome => {
  await mount();
  const write = vi.spyOn(navigator.clipboard, 'writeText');
  if (outcome === 'success') write.mockResolvedValue();
  else write.mockRejectedValue(new Error('Clipboard denied'));
  await click(screen.getByRole('button', { name: '표시된 로그 복사' }));
  const feedback = footerFeedback(), notification = feedback.querySelector('.copy-feedback-text');
  const glow = feedback.querySelector<HTMLElement>('.copy-feedback-glow')!, delay = glow.style.animationDelay;
  await advance(1_000);
  await click(screen.getByRole('button', { name: '설정' }));
  await click(screen.getByRole('radio', { name: '라이트' }));
  await change(screen.getByRole('combobox', { name: '언어' }), 'en');
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  expect(feedback.querySelector('.copy-feedback-text')).toBe(notification);
  expect(feedback.querySelector('.copy-feedback-glow')).toBe(glow);
  expect(glow.style.animationDelay).toBe(delay);
  expect(feedback).toHaveTextContent(outcome === 'success' ? 'Displayed logs copied' : 'Could not copy to the clipboard.');
  await advance(999);
  expect(feedback).toHaveClass('copy-feedback-highlighted');
  await advance(1);
  expect(feedback).not.toHaveClass('copy-feedback-highlighted');
  expect(feedback.querySelector('.copy-feedback-glow')).toBeNull();
  expect(feedback.querySelector('.copy-feedback-text')).toBe(notification);
  await click(screen.getByRole('button', { name: 'Settings' }));
  await click(screen.getByRole('radio', { name: 'Dark' }));
  await change(screen.getByRole('combobox', { name: 'Language' }), 'ko');
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  expect(feedback).toHaveTextContent(outcome === 'success' ? '표시된 로그 복사됨' : '클립보드에 복사하지 못했습니다.');
  expect(feedback.querySelector('.copy-feedback-text')).toBe(notification);
  expect(feedback).not.toHaveClass('copy-feedback-highlighted');
});

it('starts a new two-second highlight for a repeated copy without letting the earlier timer end it', async () => {
  await mount();
  vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
  const copy = screen.getByRole('button', { name: '표시된 로그 복사' });
  await click(copy);
  const feedback = footerFeedback(), first = feedback.querySelector('.copy-feedback-glow');
  await advance(1_500);
  await click(copy);
  const repeated = feedback.querySelector('.copy-feedback-glow');
  expect(repeated).not.toBe(first);
  await advance(500);
  expect(feedback.querySelector('.copy-feedback-glow')).toBe(repeated);
  await advance(1_499);
  expect(feedback.querySelector('.copy-feedback-glow')).toBe(repeated);
  await advance(1);
  expect(feedback.querySelector('.copy-feedback-glow')).toBeNull();
  expect(feedback).toHaveTextContent('표시된 로그 복사됨');
  expect(copy).toHaveFocus();
});

it.each(['success', 'error'])('manual Clear supersedes a pending copy %s and its previous highlight deadline', async outcome => {
  await mount();
  const pending = deferred<void>();
  const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValueOnce().mockReturnValueOnce(pending.promise);
  await click(screen.getByRole('button', { name: '로그 확대 보기' }));
  const dialog = within(screen.getByRole('dialog'));
  const content = dialog.getByLabelText('최근 로그 내용');
  const copy = dialog.getByRole('button', { name: '표시된 로그 복사' });
  await click(copy);
  await advance(1_000);
  await click(copy);
  await advance(500);
  await click(dialog.getByRole('button', { name: '로그 화면 비우기' }));
  const footer = footerFeedback(), modal = screen.getByRole('dialog').querySelector<HTMLElement>('.log-copy-feedback')!;
  expect(footer).toHaveTextContent('로그 화면을 비웠습니다.');
  expect(modal).toHaveTextContent('로그 화면을 비웠습니다.');
  expect(modal).toHaveClass('copy-feedback-cleared', 'copy-feedback-highlighted');
  expect(footer).toHaveClass('copy-feedback-cleared', 'copy-feedback-highlighted');
  expect(content).not.toHaveTextContent(raw);
  expect(copy).toBeDisabled();
  const notification = modal.querySelector('.copy-feedback-text'), glow = modal.querySelector('.copy-feedback-glow'), before = lifecycleCalls();
  await advance(500);
  await act(async () => { if (outcome === 'success') pending.resolve(); else pending.reject(new Error('Late clipboard denied')); });
  expect(modal.querySelector('.copy-feedback-text')).toBe(notification);
  expect(modal.querySelector('.copy-feedback-glow')).toBe(glow);
  expect(footer).toHaveTextContent('로그 화면을 비웠습니다.');
  await advance(1_499);
  expect(modal.querySelector('.copy-feedback-glow')).toBe(glow);
  await advance(1);
  expect(footer).not.toHaveClass('copy-feedback-highlighted');
  expect(modal).not.toHaveClass('copy-feedback-highlighted');
  expect(footer).toHaveTextContent('로그 화면을 비웠습니다.');
  expect(modal).toHaveTextContent('로그 화면을 비웠습니다.');
  expect(modal.querySelector('.copy-feedback-text')).toBe(notification);
  expect(dialog.getByLabelText('최근 로그 내용')).toBe(content);
  expect(dialog.getByRole('button', { name: '로그 확대 보기 닫기' })).toHaveFocus();
  expect(lifecycleCalls()).toEqual(before);
  expect(write.mock.calls).toEqual([[raw], [raw]]);
});

it('does not announce internal clears on selection or Reconnect', async () => {
  await mount();
  expect(footerFeedback()).toBeEmptyDOMElement();
  await click(screen.getByRole('button', { name: 'beta 상세' }));
  await advance(0);
  expect(footerFeedback()).toBeEmptyDOMElement();
  expect(screen.getByRole('button', { name: 'beta 상세' })).toHaveAttribute('aria-current', 'true');
  await click(screen.getByRole('button', { name: '다시 연결' }));
  await advance(0);
  expect(footerFeedback()).toBeEmptyDOMElement();
  expect(mock.getEnvironment).toHaveBeenCalledTimes(2);
  expect(mock.mutateContainer).not.toHaveBeenCalled();
  expect(mock.mutateContainers).not.toHaveBeenCalled();
});

it.each(['success', 'error'])('retains last-action history across selection and Reconnect while ignoring a late copy %s', async outcome => {
  await mount();
  const pending = deferred<void>();
  vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValueOnce().mockReturnValueOnce(pending.promise);
  const feedback = footerFeedback();
  await click(screen.getByRole('button', { name: '표시된 로그 복사' }));
  const text = feedback.querySelector('.copy-feedback-text');
  await advance(2_000);
  await click(screen.getByRole('button', { name: '표시된 로그 복사' }));
  expect(feedback.querySelector('.copy-feedback-text')).toBe(text);
  await click(screen.getByRole('button', { name: 'beta 상세' }));
  await advance(0);
  expect(feedback.querySelector('.copy-feedback-text')).toBe(text);
  await click(screen.getByRole('button', { name: '다시 연결' }));
  await advance(0);
  expect(feedback.querySelector('.copy-feedback-text')).toBe(text);
  await act(async () => { if (outcome === 'success') pending.resolve(); else pending.reject(new Error('Previous connection copy denied')); });
  expect(feedback.querySelector('.copy-feedback-text')).toBe(text);
  expect(feedback).toHaveTextContent('표시된 로그 복사됨');
  expect(feedback).not.toHaveClass('copy-feedback-highlighted');
  expect(mock.getEnvironment).toHaveBeenCalledTimes(2);
  expect(mock.mutateContainer).not.toHaveBeenCalled();
  expect(mock.mutateContainers).not.toHaveBeenCalled();
});

it('keeps the previous modal text during another pending copy and after its glow ends', async () => {
  await mount();
  const pending = deferred<void>();
  vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValueOnce().mockReturnValueOnce(pending.promise);
  await click(screen.getByRole('button', { name: '로그 확대 보기' }));
  const dialog = within(screen.getByRole('dialog'));
  await click(dialog.getByRole('button', { name: '표시된 로그 복사' }));
  const feedback = screen.getByRole('dialog').querySelector<HTMLElement>('.log-copy-feedback')!;
  const text = feedback.querySelector('.copy-feedback-text');
  await advance(1_000);
  await click(dialog.getByRole('button', { name: '표시된 로그 복사' }));
  expect(feedback.querySelector('.copy-feedback-text')).toBe(text);
  await advance(1_000);
  expect(feedback.querySelector('.copy-feedback-text')).toBe(text);
  expect(feedback).not.toHaveClass('copy-feedback-highlighted');
  await act(async () => pending.resolve());
  expect(feedback).toHaveTextContent('표시된 로그 복사됨');
  expect(feedback.querySelector('.copy-feedback-text')).not.toBe(text);
  expect(feedback).toHaveClass('copy-feedback-highlighted');
});

it('joins only the remaining glow on a new surface and never restarts it after the deadline', async () => {
  const highlightUntil = Date.now() + 2_000;
  const props = { message: 'Copied', notificationId: 1, highlighted: true, highlightUntil };
  const view = render(<CopyFeedback {...props} />);
  const original = screen.getByRole('status').querySelector<HTMLElement>('.copy-feedback-glow')!;
  expect(original.style.animationDelay).toBe('0ms');
  await advance(1_000);
  view.rerender(<CopyFeedback {...props} message="복사됨" />);
  expect(screen.getByRole('status').querySelector('.copy-feedback-glow')).toBe(original);
  expect(original.style.animationDelay).toBe('0ms');
  view.unmount();
  const joined = render(<CopyFeedback {...props} />);
  expect(screen.getByRole('status').querySelector<HTMLElement>('.copy-feedback-glow')!.style.animationDelay).toBe('-1000ms');
  joined.unmount();
  await advance(1_000);
  render(<CopyFeedback {...props} />);
  expect(screen.getByRole('status')).toHaveTextContent('Copied');
  expect(screen.getByRole('status')).not.toHaveClass('copy-feedback-highlighted');
  expect(screen.getByRole('status').querySelector('.copy-feedback-glow')).toBeNull();
});
