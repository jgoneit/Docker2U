import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import App from './App';
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
const footerFeedback = () => within(screen.getByRole('contentinfo')).getByRole('status');
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

it.each([{ outcome: 'success', duration: 3_000 }, { outcome: 'error', duration: 5_000 }])('expires $outcome in both feedback slots without changing the paused search view', async ({ outcome, duration }) => {
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
  const before = lifecycleCalls(), reads = mock.readLogStream.mock.calls.length;
  await advance(duration - 1);
  expect(footer).toHaveTextContent(message);
  expect(modal).toHaveTextContent(message);
  await advance(1);
  expect(footerFeedback()).toBe(footer);
  expect(screen.getByRole('dialog').querySelector('.log-copy-feedback')).toBe(modal);
  expect(footer).toBeEmptyDOMElement();
  expect(modal).toBeEmptyDOMElement();
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

it.each([{ outcome: 'success', duration: 3_000 }, { outcome: 'error', duration: 5_000 }])('keeps the original $outcome deadline across language and theme changes', async ({ outcome, duration }) => {
  await mount();
  const write = vi.spyOn(navigator.clipboard, 'writeText');
  if (outcome === 'success') write.mockResolvedValue();
  else write.mockRejectedValue(new Error('Clipboard denied'));
  await click(screen.getByRole('button', { name: '표시된 로그 복사' }));
  const feedback = footerFeedback(), notification = feedback.firstElementChild;
  await advance(duration - 1_000);
  await click(screen.getByRole('button', { name: '설정' }));
  await change(screen.getByRole('combobox', { name: '테마' }), 'light');
  await change(screen.getByRole('combobox', { name: '언어' }), 'en');
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  expect(feedback.firstElementChild).toBe(notification);
  expect(feedback).toHaveTextContent(outcome === 'success' ? 'Displayed logs copied' : 'Could not copy to the clipboard.');
  await advance(999);
  expect(feedback.firstElementChild).toBe(notification);
  await advance(1);
  expect(feedback).toBeEmptyDOMElement();
  await click(screen.getByRole('button', { name: 'Settings' }));
  await change(screen.getByRole('combobox', { name: 'Theme' }), 'dark');
  await change(screen.getByRole('combobox', { name: 'Language' }), 'ko');
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  expect(feedback).toBeEmptyDOMElement();
});

it('starts a new three-second deadline for a repeated copy without letting the earlier timer hide it', async () => {
  await mount();
  vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
  const copy = screen.getByRole('button', { name: '표시된 로그 복사' });
  await click(copy);
  const feedback = footerFeedback(), first = feedback.firstElementChild;
  await advance(2_500);
  await click(copy);
  const repeated = feedback.firstElementChild;
  expect(repeated).not.toBe(first);
  await advance(500);
  expect(feedback.firstElementChild).toBe(repeated);
  await advance(2_499);
  expect(feedback.firstElementChild).toBe(repeated);
  await advance(1);
  expect(feedback).toBeEmptyDOMElement();
  expect(copy).toHaveFocus();
});

it.each(['success', 'error'])('manual Clear supersedes a pending copy %s and its previous notification deadline', async outcome => {
  await mount();
  const pending = deferred<void>();
  const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValueOnce().mockReturnValueOnce(pending.promise);
  await click(screen.getByRole('button', { name: '로그 확대 보기' }));
  const dialog = within(screen.getByRole('dialog'));
  const content = dialog.getByLabelText('최근 로그 내용');
  const copy = dialog.getByRole('button', { name: '표시된 로그 복사' });
  await click(copy);
  await advance(2_000);
  await click(copy);
  await advance(500);
  await click(dialog.getByRole('button', { name: '로그 화면 비우기' }));
  const footer = footerFeedback(), modal = screen.getByRole('dialog').querySelector<HTMLElement>('.log-copy-feedback')!;
  expect(footer).toHaveTextContent('로그 화면을 비웠습니다.');
  expect(modal).toHaveTextContent('로그 화면을 비웠습니다.');
  expect(modal.firstElementChild).toHaveClass('copy-feedback-success');
  expect(content).not.toHaveTextContent(raw);
  expect(copy).toBeDisabled();
  const notification = modal.firstElementChild, before = lifecycleCalls();
  await advance(500);
  await act(async () => { if (outcome === 'success') pending.resolve(); else pending.reject(new Error('Late clipboard denied')); });
  expect(modal.firstElementChild).toBe(notification);
  expect(footer).toHaveTextContent('로그 화면을 비웠습니다.');
  await advance(2_499);
  expect(modal.firstElementChild).toBe(notification);
  await advance(1);
  expect(footer).toBeEmptyDOMElement();
  expect(modal).toBeEmptyDOMElement();
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
