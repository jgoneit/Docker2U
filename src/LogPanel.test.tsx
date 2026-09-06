import { useState } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { LogPanel } from './LogPanel';
import type { CopyText } from './components';
import { PreferencesProvider, usePreferences } from './preferences';
import type { Container, ContainerList, CoreError } from './api';
import type { LogSnapshot } from './logSnapshot';

const container: Container = { handle: 'handle-1', fullId: 'a'.repeat(64), shortId: 'a'.repeat(12), name: 'backend-with-a-long-unchanged-name', image: 'company-api:1', state: 'running', health: 'healthy', ports: [], createdAt: '2026-09-05T03:00:00Z' };
const snapshot: ContainerList = { sessionId: 'session-1', generation: 1, containers: [container], refreshedAt: '2026-09-05T04:20:00Z', stale: false };
const raw = `${Array.from({ length: 299 }, (_, index) => `${index + 1} unchanged <info> 출력`).join('\n')}\n300 FINAL raw line ${'x'.repeat(500)}`;
const logs: LogSnapshot = { fetchedAt: '2026-09-05T04:21:22Z', sessionId: 'session-1', generation: 1, handle: 'handle-1', text: raw, truncated: false, byteCount: raw.length, command: 'docker logs target', stderr: '' };

function Harness({ load = vi.fn(), copy = vi.fn(async () => {}), initialLogs = logs, loading = false, error = null, blocked = false }: { load?: () => void; copy?: CopyText; initialLogs?: LogSnapshot | null; loading?: boolean; error?: CoreError | null; blocked?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [currentLogs, setLogs] = useState(initialLogs);
  const [copyFeedback, setCopyFeedback] = useState('');
  const { setLanguage, setTheme } = usePreferences();
  return <><div inert={expanded || blocked}><button onClick={() => { setLanguage('en'); setTheme('light'); }}>Change preferences</button><LogPanel container={container} snapshot={snapshot} logs={currentLogs} logsError={error} loadingLogs={loading} refreshing={false} mutating={false} loadLogs={load} clearLogs={() => setLogs(null)} copy={async (text, label) => { await copy(text, label); setCopyFeedback('표시된 로그를 복사했습니다.'); }} copyFeedback={copyFeedback} expanded={expanded} onExpandedChange={setExpanded} /></div></>;
}
function renderLogs(props: Parameters<typeof Harness>[0] = {}) {
  return render(<PreferencesProvider initialPreferences={{ theme: 'dark', language: 'ko' }}><Harness {...props} /></PreferencesProvider>);
}

describe('expanded logs', () => {
  it('preserves raw text and scroll in both directions, restores focus and never fetches on expansion', async () => {
    const user = userEvent.setup();
    const load = vi.fn();
    renderLogs({ load });
    const inline = screen.getByLabelText('최근 로그 내용');
    inline.scrollTop = 74;
    const trigger = screen.getByRole('button', { name: '로그 확대 보기' });
    await user.click(trigger);
    const dialog = screen.getByRole('dialog', { name: `${container.name} · 로그 확대 보기` });
    expect(dialog.closest('[inert]')).toBeNull();
    const content = within(dialog).getByLabelText('최근 로그 내용');
    expect(content.textContent).toBe(raw);
    expect(content.scrollTop).toBe(74);
    expect(within(dialog).getByRole('button', { name: '로그 확대 보기 닫기' })).toHaveFocus();
    content.scrollTop = 151;
    fireEvent.scroll(content);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(inline.textContent).toBe(raw);
    expect(inline.scrollTop).toBe(151);
    expect(trigger).toHaveFocus();
    expect(load).not.toHaveBeenCalled();
  });

  it('restores the inline position when a taller expanded view clamps its initial scroll offset', async () => {
    const positions = new WeakMap<Element, number>();
    const getScroll = vi.spyOn(Element.prototype, 'scrollTop', 'get').mockImplementation(function (this: Element) { return positions.get(this) ?? 0; });
    const setScroll = vi.spyOn(Element.prototype, 'scrollTop', 'set').mockImplementation(function (this: Element, value: number) { positions.set(this, this.closest('[role="dialog"]') ? Math.min(value, 400) : value); });
    try {
      const user = userEvent.setup();
      renderLogs();
      const inline = screen.getByLabelText('최근 로그 내용');
      inline.scrollTop = 600;
      await user.click(screen.getByRole('button', { name: '로그 확대 보기' }));
      expect(within(screen.getByRole('dialog')).getByLabelText('최근 로그 내용').scrollTop).toBe(400);
      await user.keyboard('{Escape}');
      expect(inline.scrollTop).toBe(600);
    } finally {
      getScroll.mockRestore();
      setScroll.mockRestore();
    }
  });

  it('traps keyboard focus and keeps load, copy and clear available in the modal', async () => {
    const user = userEvent.setup();
    const copy = vi.fn(async () => {});
    const load = vi.fn();
    renderLogs({ copy, load });
    await user.click(screen.getByRole('button', { name: '로그 확대 보기' }));
    const dialog = screen.getByRole('dialog');
    const close = within(dialog).getByRole('button', { name: '로그 확대 보기 닫기' });
    const content = within(dialog).getByLabelText('최근 로그 내용');
    await user.tab({ shift: true });
    expect(content).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();
    await user.click(within(dialog).getByRole('button', { name: '표시된 로그 복사' }));
    expect(copy).toHaveBeenCalledExactlyOnceWith(raw, 'logs');
    expect(within(dialog).getByRole('status')).toHaveTextContent('표시된 로그를 복사했습니다.');
    await user.click(within(dialog).getByRole('button', { name: '로그 조회' }));
    expect(load).toHaveBeenCalledTimes(1);
    await user.click(within(dialog).getByRole('button', { name: '로그 화면 비우기' }));
    expect(content).toHaveTextContent('로그 조회를 눌러 로그를 확인하세요.');
    expect(close).toHaveFocus();
    await user.click(close);
    expect(screen.getByLabelText('최근 로그 내용')).toHaveTextContent('로그 조회를 눌러 로그를 확인하세요.');
  });

  it.each([false, true])('switches language and theme without additional fetches while loading=%s', async loading => {
    const load = vi.fn();
    const user = userEvent.setup();
    renderLogs({ loading, load });
    await user.click(screen.getByRole('button', { name: 'Change preferences' }));
    expect(document.documentElement).toHaveAttribute('data-theme', 'light');
    expect(screen.getByRole('button', { name: 'Expand logs' })).toBeEnabled();
    expect(screen.getByLabelText('Recent log content').textContent).toBe(loading ? 'Loading recent logs…' : raw);
    expect(load).not.toHaveBeenCalled();
    if (loading) expect(screen.getByRole('button', { name: 'Clear displayed logs' })).toBeEnabled();
  });

  it('keeps empty and truncated notices localized and raw native errors in technical details', async () => {
    const user = userEvent.setup();
    const { unmount } = renderLogs({ initialLogs: { ...logs, text: '', truncated: true } });
    expect(screen.getByText('최근 로그가 없습니다.')).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('로그 앞부분이 잘렸습니다.');
    unmount();
    renderLogs({ error: { code: 'ReadFailed', message: 'native 원문 그대로', command: 'docker logs raw-id', stderr: 'raw stderr' } });
    expect(screen.getByRole('alert')).toHaveTextContent('최근 로그를 읽지 못했습니다.');
    expect(screen.getByRole('button', { name: '로그 화면 비우기' })).toBeEnabled();
    expect(screen.getByText('native 원문 그대로')).not.toBeVisible();
    await user.click(screen.getByText('진단 상세 · ReadFailed'));
    expect(screen.getByText('native 원문 그대로')).toBeVisible();
    expect(screen.getByText('docker logs raw-id')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Change preferences' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Recent logs could not be read.');
    expect(screen.getByText('native 원문 그대로')).toBeVisible();
  });
});

describe('log snapshot search', () => {
  it('displays receipt time separately from the inventory timestamp', () => {
    renderLogs();
    const receipt = screen.getByText('로그 조회 완료');
    expect(receipt.querySelector('time')).toHaveAttribute('datetime', logs.fetchedAt);
    expect(receipt.querySelector('time')).not.toHaveAttribute('datetime', snapshot.refreshedAt);
  });

  it('navigates literal matches, wraps with Enter and Shift+Enter, and keeps raw text intact', async () => {
    const user = userEvent.setup();
    const text = 'ERROR first\nerror second\nError third\n.* literal\nnot a pattern';
    const copy = vi.fn(async () => {});
    const load = vi.fn();
    renderLogs({ initialLogs: { ...logs, text }, copy, load });
    await user.click(screen.getByRole('button', { name: '로그 검색 열기' }));
    const search = screen.getByRole('searchbox', { name: '로그 검색' });
    const content = screen.getByLabelText('최근 로그 내용');
    await user.type(search, 'eRrOr');
    expect(await screen.findByText('1 / 3건')).toBeVisible();
    expect(content.querySelectorAll('mark')).toHaveLength(1);
    expect(content.querySelector('mark')).toHaveTextContent('ERROR');
    expect(content.textContent).toBe(text);
    await user.keyboard('{Enter}');
    expect(await screen.findByText('2 / 3건')).toBeVisible();
    expect(content.querySelector('mark')).toHaveTextContent('error');
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    expect(await screen.findByText('1 / 3건')).toBeVisible();
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    expect(await screen.findByText('3 / 3건')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '다음 일치' }));
    expect(await screen.findByText('1 / 3건')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '이전 일치' }));
    expect(await screen.findByText('3 / 3건')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '표시된 로그 복사' }));
    expect(copy).toHaveBeenCalledExactlyOnceWith(text, 'logs');
    await user.clear(search);
    await user.type(search, '.*');
    expect(await screen.findByText('1 / 1건')).toBeVisible();
    expect(content.querySelector('mark')?.textContent).toBe('.*');
    await user.clear(search);
    await user.type(search, 'not present');
    expect(await screen.findByText('0건')).toBeVisible();
    expect(screen.getByRole('button', { name: '이전 일치' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '다음 일치' })).toBeDisabled();
    expect(content.querySelector('mark')).toBeNull();
    const clearSearch = screen.getByRole('button', { name: '로그 검색 지우기' });
    expect(clearSearch.parentElement).toBe(search.parentElement);
    expect(clearSearch.parentElement).toHaveClass('log-search-field');
    await user.click(clearSearch);
    expect(screen.queryByRole('button', { name: '로그 검색 지우기' })).not.toBeInTheDocument();
    expect(search).toHaveValue('');
    expect(search).toHaveFocus();
    expect(load).not.toHaveBeenCalled();
  });

  it('preserves the current match through expansion, return, language and theme changes', async () => {
    const user = userEvent.setup();
    const load = vi.fn();
    renderLogs({ load, initialLogs: { ...logs, text: 'first error\nsecond ERROR\nthird error' } });
    await user.click(screen.getByRole('button', { name: '로그 검색 열기' }));
    await user.type(screen.getByRole('searchbox', { name: '로그 검색' }), 'error');
    await waitFor(() => expect(screen.getByRole('button', { name: '다음 일치' })).toBeEnabled());
    await user.keyboard('{Enter}');
    await user.click(screen.getByRole('button', { name: '로그 확대 보기' }));
    let dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('searchbox', { name: '로그 검색' })).toHaveValue('error');
    expect(await within(dialog).findByText('2 / 3건')).toBeVisible();
    const expandedSearch = within(dialog).getByRole('searchbox', { name: '로그 검색' });
    await user.click(expandedSearch);
    await user.keyboard('{Enter}');
    expect(await within(dialog).findByText('3 / 3건')).toBeVisible();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(await screen.findByText('3 / 3건')).toBeVisible();
    expect(screen.getByRole('button', { name: '로그 확대 보기' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Change preferences' }));
    expect(screen.getByRole('searchbox', { name: 'Search logs' })).toHaveValue('error');
    expect(await screen.findByText('3 / 3 matches')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Expand logs' }));
    dialog = screen.getByRole('dialog');
    expect(await within(dialog).findByText('3 / 3 matches')).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Clear displayed logs' }));
    expect(within(dialog).queryByRole('searchbox')).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Open log search' }));
    expect(within(dialog).getByRole('searchbox', { name: 'Search logs' })).toHaveValue('');
    expect(within(dialog).getByText('0 matches')).toBeVisible();
    expect(load).not.toHaveBeenCalled();
  });

  it('uses bounded highlight elements for a 2 MiB log and scrolls bottom without loading', async () => {
    const user = userEvent.setup();
    const text = 'a'.repeat(2 * 1024 * 1024 - 5) + '\nLAST';
    const load = vi.fn();
    renderLogs({ initialLogs: { ...logs, text, byteCount: text.length }, load });
    const content = screen.getByLabelText('최근 로그 내용');
    Object.defineProperty(content, 'scrollHeight', { configurable: true, value: 9999 });
    await user.click(screen.getByRole('button', { name: '로그 검색 열기' }));
    fireEvent.change(screen.getByRole('searchbox', { name: '로그 검색' }), { target: { value: 'a' } });
    await waitFor(() => expect(content.querySelectorAll('*')).toHaveLength(1));
    expect(content.childNodes).toHaveLength(2);
    expect(content.textContent).toBe(text);
    await user.click(screen.getByRole('button', { name: '맨 아래로' }));
    expect(content.scrollTop).toBe(9999);
    expect(load).not.toHaveBeenCalled();
  });

  it('preserves the query on same-container reload and resets for a different target', async () => {
    const user = userEvent.setup();
    function ReloadHarness() {
      const [currentLogs, setCurrentLogs] = useState<LogSnapshot | null>({ ...logs, text: 'ERROR first\nerror second' });
      const [currentContainer, setCurrentContainer] = useState(container);
      const [loading, setLoading] = useState(false);
      return <><button onClick={() => { setCurrentLogs(null); setLoading(true); }}>Start reload</button><button onClick={() => { setCurrentLogs({ ...logs, text: 'only one ERROR' }); setLoading(false); }}>Finish reload</button><button onClick={() => setCurrentContainer({ ...container, fullId: 'b'.repeat(64), handle: 'handle-2' })}>Change container</button><LogPanel container={currentContainer} snapshot={snapshot} logs={currentLogs} logsError={null} loadingLogs={loading} refreshing={false} mutating={false} loadLogs={() => {}} clearLogs={() => setCurrentLogs(null)} copy={async () => {}} expanded={false} onExpandedChange={() => {}} /></>;
    }
    render(<PreferencesProvider initialPreferences={{ theme: 'dark', language: 'ko' }}><ReloadHarness /></PreferencesProvider>);
    await user.click(screen.getByRole('button', { name: '로그 검색 열기' }));
    await user.type(screen.getByRole('searchbox', { name: '로그 검색' }), 'error');
    await waitFor(() => expect(screen.getByRole('button', { name: '다음 일치' })).toBeEnabled());
    await user.keyboard('{Enter}');
    expect(await screen.findByText('2 / 2건')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Start reload' }));
    expect(screen.getByRole('searchbox', { name: '로그 검색' })).toHaveValue('error');
    await user.click(screen.getByRole('button', { name: 'Finish reload' }));
    expect(screen.getByRole('searchbox', { name: '로그 검색' })).toHaveValue('error');
    expect(await screen.findByText('1 / 1건')).toBeVisible();
    expect(screen.getByLabelText('최근 로그 내용').querySelector('mark')).toHaveTextContent('ERROR');
    await user.click(screen.getByRole('button', { name: 'Change container' }));
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '로그 검색 열기' }));
    expect(screen.getByRole('searchbox', { name: '로그 검색' })).toHaveValue('');
    expect(await screen.findByText('0건')).toBeVisible();
  });
});


it('keeps closed diagnostic content outside the expanded-log focus trap', async () => {
  const user = userEvent.setup();
  renderLogs({ error: { code: 'ReadFailed', message: 'native original error', command: 'docker logs raw-id', stderr: 'last stderr detail' } });
  await user.click(screen.getByRole('button', { name: '로그 확대 보기' }));
  const dialog = screen.getByRole('dialog');
  const close = within(dialog).getByRole('button', { name: '로그 확대 보기 닫기' });
  const summary = within(dialog).getByText('진단 상세 · ReadFailed');
  expect(close).toHaveFocus();
  await user.tab({ shift: true });
  expect(summary).toHaveFocus();
  await user.tab();
  expect(close).toHaveFocus();
  await user.click(summary);
  close.focus();
  await user.tab({ shift: true });
  expect(within(dialog).getByText('last stderr detail')).toHaveFocus();
  await user.tab();
  expect(close).toHaveFocus();
});


it('closes and restores focus on Escape when WebView focus falls back to the document', async () => {
  const user = userEvent.setup();
  renderLogs();
  const expand = screen.getByRole('button', { name: '로그 확대 보기' });
  await user.click(expand);
  screen.getByRole('button', { name: '로그 확대 보기 닫기' }).blur();
  expect(document.body).toHaveFocus();
  fireEvent.keyDown(document.body, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(expand).toHaveFocus();
});

it('returns document focus to the expanded-log Tab boundary in either direction', async () => {
  const user = userEvent.setup();
  renderLogs();
  await user.click(screen.getByRole('button', { name: '로그 확대 보기' }));
  const dialog = screen.getByRole('dialog');
  const close = within(dialog).getByRole('button', { name: '로그 확대 보기 닫기' });
  close.blur();
  expect(document.body).toHaveFocus();
  fireEvent.keyDown(document.body, { key: 'Tab' });
  expect(close).toHaveFocus();
  close.blur();
  fireEvent.keyDown(document.body, { key: 'Tab', shiftKey: true });
  expect(within(dialog).getByLabelText('최근 로그 내용')).toHaveFocus();
});

describe('collapsible log search', () => {
  it('starts hidden, keeps bottom available, and retains the current match across close and reopen', async () => {
    const user = userEvent.setup();
    const load = vi.fn();
    renderLogs({ load, initialLogs: { ...logs, text: 'error first\nERROR second\nerror third' } });
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '맨 아래로' })).toBeEnabled();
    const toggle = screen.getByRole('button', { name: '로그 검색 열기' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    const search = screen.getByRole('searchbox', { name: '로그 검색' });
    expect(search).toHaveFocus();
    await user.type(search, 'error');
    await waitFor(() => expect(screen.getByRole('button', { name: '다음 일치' })).toBeEnabled());
    await user.keyboard('{Enter}');
    expect(await screen.findByText('2 / 3건')).toBeVisible();
    const content = screen.getByLabelText('최근 로그 내용');
    expect(content.querySelector('mark')).toHaveTextContent('ERROR');
    await user.click(screen.getByRole('button', { name: '로그 검색 닫기' }));
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    expect(content.querySelector('mark')).toBeNull();
    const expose = vi.fn();
    content.scrollIntoView = expose;
    await user.click(screen.getByRole('button', { name: '로그 검색 열기' }));
    expect(screen.getByRole('searchbox', { name: '로그 검색' })).toHaveValue('error');
    expect(await screen.findByText('2 / 3건')).toBeVisible();
    expect(content.querySelector('mark')).toHaveTextContent('ERROR');
    expect(expose).toHaveBeenCalled();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '로그 검색 열기' })).toHaveFocus();
    expect(load).not.toHaveBeenCalled();
  });

  it.each([
    ['MacIntel', { metaKey: true }, { ctrlKey: true }],
    ['Win32', { ctrlKey: true }, { metaKey: true }],
  ] as const)('uses the platform find shortcut and repeated invocation selects the existing query on %s', async (platform, accepted, rejected) => {
    const platformValue = vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform);
    try {
      const user = userEvent.setup();
      const load = vi.fn();
      renderLogs({ load });
      const toggle = screen.getByRole('button', { name: '로그 검색 열기' });
      expect(toggle).toHaveAttribute('aria-keyshortcuts', platform === 'MacIntel' ? 'Meta+F' : 'Control+F');
      expect(toggle).toHaveAttribute('title', `로그 검색 (${platform === 'MacIntel' ? '⌘F' : 'Ctrl+F'})`);
      expect(fireEvent.keyDown(document.body, { key: 'f', ...rejected })).toBe(true);
      expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
      expect(fireEvent.keyDown(document.body, { key: 'f', ...accepted })).toBe(false);
      const search = screen.getByRole('searchbox', { name: '로그 검색' }) as HTMLInputElement;
      expect(search).toHaveFocus();
      await user.type(search, 'unchanged');
      search.blur();
      fireEvent.keyDown(document.body, { key: 'f', ...accepted });
      expect(search).toHaveFocus();
      expect(search).toHaveValue('unchanged');
      expect(search.selectionStart).toBe(0);
      expect(search.selectionEnd).toBe('unchanged'.length);
      expect(screen.getByRole('button', { name: '로그 검색 닫기' })).toHaveAttribute('aria-expanded', 'true');
      expect(load).not.toHaveBeenCalled();
    } finally {
      platformValue.mockRestore();
    }
  });

  it('leaves the host find shortcut alone when the inline panel is inert', () => {
    const platformValue = vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    try {
      renderLogs({ blocked: true });
      expect(fireEvent.keyDown(document.body, { key: 'f', metaKey: true })).toBe(true);
      const toggle = screen.getByRole('button', { name: '로그 검색 열기', hidden: true });
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
    } finally {
      platformValue.mockRestore();
    }
  });

  it('routes find into the expanded portal and Escape closes the dialog with its search state retained', async () => {
    const platformValue = vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    try {
      const user = userEvent.setup();
      renderLogs();
      await user.click(screen.getByRole('button', { name: '로그 확대 보기' }));
      fireEvent.keyDown(document.body, { key: 'f', metaKey: true });
      const dialog = screen.getByRole('dialog');
      const search = within(dialog).getByRole('searchbox', { name: '로그 검색' });
      expect(search).toHaveFocus();
      await user.type(search, 'unchanged');
      await within(dialog).findByText('1 / 299건');
      await user.keyboard('{Enter}');
      await within(dialog).findByText('2 / 299건');
      await user.keyboard('{Escape}');
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: '로그 확대 보기' })).toHaveFocus();
      expect(screen.getByRole('searchbox', { name: '로그 검색' })).toHaveValue('unchanged');
      expect(await screen.findByText('2 / 299건')).toBeVisible();
      await user.keyboard('{Escape}');
      expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: '로그 검색 열기' })).toHaveFocus();
    } finally {
      platformValue.mockRestore();
    }
  });
});
