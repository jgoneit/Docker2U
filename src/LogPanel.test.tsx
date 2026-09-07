import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { LogPanel } from './LogPanel';
import type { CopyText } from './components';
import { PreferencesProvider, usePreferences } from './preferences';
import type { Container, ContainerList, CoreError } from './api';
import type { LogSnapshot } from './logSnapshot';

const container: Container = { handle: 'handle-1', fullId: 'a'.repeat(64), shortId: 'a'.repeat(12), composeProject: null, composeService: null, name: 'backend-with-a-long-unchanged-name', image: 'company-api:1', state: 'running', health: 'healthy', ports: [], createdAt: '2026-09-05T03:00:00Z' };
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
function logAction(name: string, surface: typeof screen | ReturnType<typeof within> = screen) {
  return surface.getByRole('button', { name });
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
    await user.click(logAction('표시된 로그 복사', within(dialog)));
    expect(copy).toHaveBeenCalledExactlyOnceWith(raw, 'logs');
    expect(within(dialog).getByRole('status')).toHaveTextContent('표시된 로그를 복사했습니다.');
    await user.click(within(dialog).getByRole('button', { name: '로그 조회' }));
    expect(load).toHaveBeenCalledTimes(1);
    await user.click(logAction('로그 화면 비우기', within(dialog)));
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
    if (loading) expect(logAction('Clear displayed logs', screen)).toBeEnabled();
  });

  it('keeps empty and truncated notices localized and raw native errors in technical details', async () => {
    const user = userEvent.setup();
    const { unmount } = renderLogs({ initialLogs: { ...logs, text: '', truncated: true } });
    expect(screen.getByText('최근 로그가 없습니다.')).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('로그 앞부분이 잘렸습니다.');
    unmount();
    renderLogs({ error: { code: 'ReadFailed', message: 'native 원문 그대로', command: 'docker logs raw-id', stderr: 'raw stderr' } });
    expect(screen.getByRole('alert')).toHaveTextContent('최근 로그를 읽지 못했습니다.');
    expect(logAction('로그 화면 비우기', screen)).toBeEnabled();
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
    await user.click(logAction('표시된 로그 복사', screen));
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
    await user.click(logAction('Clear displayed logs', within(dialog)));
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


describe('displayed snapshot copying and request gates', () => {
  it.each([false, true])('blocks hidden snapshots while loading or failed, expanded=%s', async expanded => {
    const user = userEvent.setup();
    const copy = vi.fn(async () => {});
    const view = renderLogs({ copy, loading: true });
    if (expanded) await user.click(screen.getByRole('button', { name: '로그 확대 보기' }));
    const surface = () => expanded ? within(screen.getByRole('dialog')) : screen;
    expect(logAction('표시된 로그 복사', surface())).toBeDisabled();
    await user.click(logAction('표시된 로그 복사', surface()));
    view.rerender(<PreferencesProvider initialPreferences={{ theme: 'dark', language: 'ko' }}><Harness copy={copy} error={{ code: 'LogsUnavailable', message: 'raw failure' }} /></PreferencesProvider>);
    expect(logAction('표시된 로그 복사', surface())).toBeDisabled();
    await user.click(logAction('표시된 로그 복사', surface()));
    expect(copy).not.toHaveBeenCalled();
    view.rerender(<PreferencesProvider initialPreferences={{ theme: 'dark', language: 'ko' }}><Harness copy={copy} /></PreferencesProvider>);
    await user.click(logAction('표시된 로그 복사', surface()));
    expect(copy).toHaveBeenCalledExactlyOnceWith(raw, 'logs');
  });

  it('allows the visible last good snapshot to be copied after a list refresh fails', async () => {
    const user = userEvent.setup();
    const copy = vi.fn(async () => {});
    render(<PreferencesProvider initialPreferences={{ theme: 'dark', language: 'ko' }}><LogPanel container={container} snapshot={{ ...snapshot, stale: true }} logs={logs} logsError={null} loadingLogs={false} refreshing={false} mutating={false} loadLogs={() => {}} clearLogs={() => {}} copy={copy} expanded={false} onExpandedChange={() => {}} /></PreferencesProvider>);
    expect(screen.getByLabelText('최근 로그 내용').textContent).toBe(raw);
    await user.click(logAction('표시된 로그 복사', screen));
    expect(copy).toHaveBeenCalledExactlyOnceWith(raw, 'logs');
  });

  it('explains the held request gate after clear without showing a loading spinner', () => {
    render(<PreferencesProvider initialPreferences={{ theme: 'dark', language: 'ko' }}><LogPanel container={container} snapshot={snapshot} logs={null} logsError={null} loadingLogs={false} logRequestPending refreshing={false} mutating={false} loadLogs={() => {}} clearLogs={() => {}} copy={async () => {}} expanded={false} onExpandedChange={() => {}} /></PreferencesProvider>);
    const load = screen.getByRole('button', { name: '로그 조회' });
    expect(load).toBeDisabled();
    expect(load).toHaveAccessibleDescription('이전 로그 요청이 끝나면 다시 조회할 수 있습니다.');
    expect(load.querySelector('.spin')).toBeNull();
    expect(screen.getByLabelText('최근 로그 내용')).toHaveAttribute('aria-busy', 'false');
  });
});

function LiveHarness() {
  const [expanded, setExpanded] = useState(false);
  const [version, setVersion] = useState(1);
  const [cleared, setCleared] = useState(false);
  const [failed, setFailed] = useState(false);
  const { setLanguage, setTheme } = usePreferences();
  const liveLogs: LogSnapshot = { ...logs, source: 'live', streamId: 'stream-1', text: `frame ${version}\nerror visible`, sequence: version,
    truncated: version >= 3, droppedBytes: version >= 3 ? 30 : 0 };
  return <><button onClick={() => { setVersion(value => value + 1); setCleared(false); }}>Next frame</button>
    <button onClick={() => setFailed(true)}>Fail stream</button>
    <button onClick={() => { setLanguage('en'); setTheme('light'); }}>Change live preferences</button>
    <LogPanel container={container} snapshot={snapshot} logs={cleared ? null : liveLogs} logsError={failed ? { code: 'LOST', message: 'Lost socket' } : null}
      liveStatus={failed ? 'error' : 'following'} loadingLogs={false} refreshing={false} mutating={false}
      loadLogs={() => { setVersion(value => value + 1); setCleared(false); }} clearLogs={() => setCleared(true)} copy={async () => {}}
      expanded={expanded} onExpandedChange={setExpanded} /></>;
}
function renderLiveLogs() { return render(<PreferencesProvider initialPreferences={{ theme: 'dark', language: 'ko' }}><LiveHarness /></PreferencesProvider>); }

describe('log source modes', () => {
  const properties = {
    container, snapshot, logs: null, logsError: null, loadingLogs: false, refreshing: false, mutating: false,
    loadLogs: () => {}, clearLogs: () => {}, copy: async () => {}, expanded: false, onExpandedChange: () => {},
  } satisfies Parameters<typeof LogPanel>[0];
  const panel = (overrides: Partial<Parameters<typeof LogPanel>[0]>) => <PreferencesProvider initialPreferences={{ theme: 'dark', language: 'ko' }}><LogPanel {...properties} {...overrides} /></PreferencesProvider>;
  const frame: LogSnapshot = { ...logs, source: 'live', streamId: 'mode-stream', sequence: 1, text: 'ERROR first follow', byteCount: 18, receivedBytes: 18 };

  it.each(['running', 'paused', 'restarting'])('keeps %s follow controls before receipt and retains ended follow provenance', async state => {
    const current = { ...container, state };
    const view = render(panel({ container: current, liveStatus: 'connecting', loadingLogs: true }));
    expect(screen.getByRole('button', { name: '일시정지' })).toBeVisible();
    expect(screen.getByText('로그 연결 중')).toBeVisible();
    expect(screen.getByText('최근 2 MiB')).toBeVisible();
    expect(document.querySelector('.log-fetched-at')).toBeNull();
    view.rerender(panel({ container: current, liveStatus: 'following', logs: { ...frame, text: '', byteCount: 0, receivedBytes: 0, sequence: -1 } }));
    expect(document.querySelector('.log-fetched-at')).toBeNull();
    view.rerender(panel({ container: current, liveStatus: 'following', logs: frame }));
    expect(document.querySelector('.log-fetched-at')).toHaveTextContent('마지막 수신');
    view.rerender(panel({ container: { ...container, state: 'exited' }, liveStatus: 'ended', logs: frame }));
    expect(screen.getByText('수집 종료')).toBeVisible();
    expect(screen.getByRole('button', { name: '일시정지' })).toBeVisible();
    expect(screen.getByLabelText('최근 로그 내용')).toHaveTextContent(frame.text);
    expect(document.querySelector('.log-fetched-at')).toHaveTextContent('마지막 수신');
    view.rerender(panel({ container: current, liveStatus: 'error', logsError: { code: 'StartFailed', message: 'follow unavailable' } }));
    expect(screen.getByRole('button', { name: '일시정지' })).toBeVisible();
    expect(screen.getByText('수집 오류')).toBeVisible();
    expect(document.querySelector('.log-fetched-at')).toBeNull();
  });

  it('retains search across a same-ID mode change without reviving the prior paused buffer', async () => {
    const user = userEvent.setup();
    const view = render(panel({ liveStatus: 'following', logs: frame }));
    const content = screen.getByLabelText('최근 로그 내용');
    await user.click(screen.getByRole('button', { name: '일시정지' }));
    await user.click(screen.getByRole('button', { name: '로그 검색 열기' }));
    const search = screen.getByRole('searchbox', { name: '로그 검색' });
    await user.type(search, 'error');
    expect(await screen.findByText('1 / 1건')).toBeVisible();
    view.rerender(panel({ container: { ...container, state: 'exited' }, liveStatus: 'ended', logs: { ...logs, text: 'ERROR replacement snapshot\nERROR second snapshot line' } }));
    expect(screen.queryByRole('button', { name: '재개' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '일시정지' })).not.toBeInTheDocument();
    expect(document.querySelector('.log-stream-status')).toBeNull();
    expect(content).toHaveTextContent('ERROR replacement snapshot');
    expect(content).not.toHaveTextContent(frame.text);
    expect(await screen.findByText('1 / 2건')).toBeVisible();
    expect(screen.getByRole('searchbox', { name: '로그 검색' })).toBe(search);

    view.rerender(panel({ liveStatus: 'connecting', loadingLogs: true }));
    expect(search).toHaveValue('error');
    expect(screen.getByRole('button', { name: '일시정지' })).toHaveAttribute('aria-pressed', 'false');
    view.rerender(panel({ liveStatus: 'following', logs: { ...frame, streamId: 'new-mode-stream', text: '', byteCount: 0, receivedBytes: 0, sequence: -1 } }));
    expect(content).not.toHaveTextContent('ERROR replacement snapshot');
    const first = { ...frame, streamId: 'new-mode-stream', text: 'ERROR new follow' };
    view.rerender(panel({ liveStatus: 'following', logs: first }));
    expect(content.textContent).toBe(first.text);
    expect(await screen.findByText('1 / 1건')).toBeVisible();
    view.rerender(panel({ liveStatus: 'following', logs: { ...first, text: 'ERROR subsequent follow', sequence: 2 } }));
    expect(content.textContent).toBe(first.text);
    await user.click(screen.getByRole('button', { name: '로그 검색 닫기' }));
    expect(content.textContent).toBe('ERROR subsequent follow');
    expect(screen.getByLabelText('최근 로그 내용')).toBe(content);
    expect(screen.getByRole('button', { name: '일시정지' })).toHaveAttribute('aria-pressed', 'false');
  });
});

describe('live log display', () => {
  it('keeps copy and trash icon actions directly available across language changes', async () => {
    const user = userEvent.setup(); renderLiveLogs();
    const panel = screen.getByRole('region', { name: '최근 로그' });
    expect(within(panel).getAllByRole('button')).toHaveLength(6);
    expect(within(panel).getByRole('button', { name: '표시된 로그 복사' })).toBeVisible();
    expect(within(panel).getByRole('button', { name: '로그 화면 비우기' })).toBeVisible();
    expect(within(panel).queryByRole('button', { name: '최신 로그로' })).not.toBeInTheDocument();
    const viewport = screen.getByLabelText('최근 로그 내용');
    Object.defineProperties(viewport, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 100 } });
    viewport.scrollTop = 100; fireEvent.scroll(viewport);
    const copy = within(panel).getByRole('button', { name: '표시된 로그 복사' });
    const clear = within(panel).getByRole('button', { name: '로그 화면 비우기' });
    expect(copy).toHaveAttribute('title', '표시된 로그 복사');
    expect(clear).toHaveAttribute('title', '로그 화면 비우기');
    expect(copy.textContent).toBe('');
    expect(clear.textContent).toBe('');
    const load = within(panel).getByRole('button', { name: '로그 조회' });
    const latest = within(panel).getByRole('button', { name: '최신 로그로' });
    expect(load).toHaveAttribute('title', '로그 조회');
    expect(latest).toHaveAttribute('title', '최신 로그로');
    expect(within(panel).getByRole('button', { name: '일시정지' })).toHaveTextContent('일시정지');
    for (const name of ['로그 검색 열기', '표시된 로그 복사', '로그 화면 비우기', '로그 확대 보기']) {
      expect(within(panel).getByRole('button', { name })).toBeEnabled();
    }
    const content = screen.getByLabelText('최근 로그 내용');
    const receivedAt = panel.querySelector('.log-fetched-at time');
    expect(receivedAt).toHaveAttribute('datetime', logs.fetchedAt);

    await user.click(screen.getByRole('button', { name: 'Change live preferences' }));

    expect(screen.getByRole('button', { name: 'Load logs' })).toBe(load);
    expect(load).toHaveAttribute('title', 'Load logs');
    expect(screen.getByRole('button', { name: 'Latest logs' })).toBe(latest);
    expect(latest).toHaveAttribute('title', 'Latest logs');
    expect(screen.getByRole('button', { name: 'Pause' })).toHaveTextContent('Pause');
    expect(within(panel).getByRole('button', { name: 'Copy displayed logs' })).toBe(copy);
    expect(copy).toHaveAttribute('title', 'Copy displayed logs');
    expect(within(panel).getByRole('button', { name: 'Clear displayed logs' })).toBe(clear);
    expect(clear).toHaveAttribute('title', 'Clear displayed logs');
    expect(screen.getByLabelText('Recent log content')).toBe(content);
    expect(panel.querySelector('.log-fetched-at time')).toBe(receivedAt);
  });
  it('keeps collecting behind a paused display and catches up with an explicit loss notice', async () => {
    const user = userEvent.setup(); renderLiveLogs();
    await user.click(screen.getByRole('button', { name: '일시정지' }));
    await user.click(screen.getByRole('button', { name: 'Next frame' }));
    await user.click(screen.getByRole('button', { name: 'Next frame' }));
    expect(screen.getByLabelText('최근 로그 내용')).toHaveTextContent('frame 1');
    expect(screen.getByText(/표시를 멈춘 사이 일부 로그/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: '재개' }));
    expect(screen.getByLabelText('최근 로그 내용')).toHaveTextContent('frame 3');
    expect(screen.getByText(/일부 오래된 로그를 건너뛰고/)).toBeVisible();
  });
  it('freezes during search and only resumes on close when not manually paused', async () => {
    const user = userEvent.setup(); renderLiveLogs();
    await user.click(screen.getByRole('button', { name: '로그 검색 열기' }));
    await user.type(screen.getByRole('searchbox'), 'error');
    await user.click(screen.getByRole('button', { name: 'Next frame' }));
    expect(screen.getByLabelText('최근 로그 내용')).toHaveTextContent('frame 1');
    await user.click(screen.getByRole('button', { name: '로그 검색 닫기' }));
    expect(screen.getByLabelText('최근 로그 내용')).toHaveTextContent('frame 2');
    await user.click(screen.getByRole('button', { name: '일시정지' }));
    await user.click(screen.getByRole('button', { name: '로그 검색 열기' }));
    await user.click(screen.getByRole('button', { name: 'Next frame' }));
    await user.click(screen.getByRole('button', { name: '로그 검색 닫기' }));
    expect(screen.getByLabelText('최근 로그 내용')).toHaveTextContent('frame 2');
    expect(screen.getByRole('button', { name: '재개' })).toBeVisible();
  });
  it('the keyboard search shortcut captures the latest frame, not a stale event-handler snapshot', async () => {
    const platformValue = vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    try {
      const user = userEvent.setup(); renderLiveLogs();
      await user.click(screen.getByRole('button', { name: 'Next frame' }));
      fireEvent.keyDown(document.body, { key: 'f', metaKey: true });
      await user.click(screen.getByRole('button', { name: 'Next frame' }));
      expect(screen.getByLabelText('최근 로그 내용')).toHaveTextContent('frame 2');
      expect(screen.getByRole('searchbox')).toBeVisible();
    } finally { platformValue.mockRestore(); }
  });
  it('preserves pause through reload, expansion and preferences, and clear removes frozen text', async () => {
    const user = userEvent.setup(); renderLiveLogs();
    await user.click(screen.getByRole('button', { name: '일시정지' }));
    await user.click(screen.getByRole('button', { name: '로그 조회' }));
    expect(screen.getByLabelText('최근 로그 내용')).toHaveTextContent('frame 1');
    await user.click(screen.getByRole('button', { name: 'Change live preferences' }));
    await user.click(screen.getByRole('button', { name: 'Expand logs' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Resume' })).toBeVisible();
    expect(within(dialog).getByLabelText('Recent log content')).toHaveTextContent('frame 1');
    await user.click(logAction('Clear displayed logs', within(dialog)));
    expect(within(dialog).getByLabelText('Recent log content')).not.toHaveTextContent('frame 1');
    expect(within(dialog).getByRole('button', { name: 'Resume' })).toBeVisible();
  });
  it('keeps captured logs visible when the stream fails', async () => {
    const user = userEvent.setup(); renderLiveLogs();
    await user.click(screen.getByRole('button', { name: 'Fail stream' }));
    expect(screen.getByRole('alert')).toHaveTextContent('최근 로그를 읽지 못했습니다.');
    expect(screen.getByLabelText('최근 로그 내용')).toHaveTextContent('frame 1');
    expect(logAction('표시된 로그 복사', screen)).toBeEnabled();
  });
  it('does not move a scrolled-up viewport until Latest logs re-enables bottom following', async () => {
    const user = userEvent.setup(); renderLiveLogs();
    const content = screen.getByLabelText('최근 로그 내용');
    Object.defineProperties(content, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 100 } });
    content.scrollTop = 100; fireEvent.scroll(content);
    await user.click(screen.getByRole('button', { name: 'Next frame' }));
    expect(content.scrollTop).toBe(100);
    await user.click(screen.getByRole('button', { name: '최신 로그로' }));
    expect(content.scrollTop).toBe(1000);
    expect(content).toHaveFocus();
    expect(screen.queryByRole('button', { name: '최신 로그로' })).not.toBeInTheDocument();
    Object.defineProperty(content, 'scrollHeight', { configurable: true, value: 1200 });
    await user.click(screen.getByRole('button', { name: 'Next frame' }));
    expect(content.scrollTop).toBe(1200);
  });
  it.each(['following', 'paused', 'searching', 'scrolled up'] as const)('preserves %s behavior while the inline log viewport changes height', async mode => {
    const observers: { notify: () => void; observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[] = [];
    vi.stubGlobal('ResizeObserver', class {
      observe = vi.fn();
      disconnect = vi.fn();
      constructor(callback: ResizeObserverCallback) { observers.push({ observe: this.observe, disconnect: this.disconnect, notify: () => callback([], this as unknown as ResizeObserver) }); }
    });
    const view = renderLiveLogs();
    try {
      const user = userEvent.setup();
      const content = screen.getByLabelText('최근 로그 내용');
      let height = 100;
      Object.defineProperties(content, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, get: () => height } });
      content.scrollTop = 900; fireEvent.scroll(content);
      if (mode === 'paused') await user.click(screen.getByRole('button', { name: '일시정지' }));
      if (mode === 'searching') await user.click(screen.getByRole('button', { name: '로그 검색 열기' }));
      if (mode === 'scrolled up') { content.scrollTop = 400; fireEvent.scroll(content); }
      const prior = content.scrollTop;
      const observer = observers.at(-1)!;
      expect(observer.observe).toHaveBeenCalledWith(content);
      height = 60;
      act(() => observer.notify());
      expect(content.scrollTop).toBe(mode === 'following' ? 1000 : prior);
      expect(screen.getByLabelText('최근 로그 내용')).toBe(content);
      expect(content).toHaveTextContent('frame 1');
      await user.click(screen.getByRole('button', { name: 'Next frame' }));
      expect(content).toHaveTextContent(mode === 'paused' || mode === 'searching' ? 'frame 1' : 'frame 2');
      if (mode !== 'following') expect(content.scrollTop).toBe(prior);
      view.unmount();
      expect(observer.disconnect).toHaveBeenCalledTimes(1);
    } finally { view.unmount(); vi.unstubAllGlobals(); }
  });
  it.each([false, true])('does not resume following when a resize clamps the viewport to the bottom, expanded=%s', async expanded => {
    const user = userEvent.setup(); renderLiveLogs();
    if (expanded) await user.click(screen.getByRole('button', { name: '로그 확대 보기' }));
    const surface = expanded ? within(screen.getByRole('dialog')) : screen;
    const content = surface.getByLabelText('최근 로그 내용');
    let height = 100;
    let scrollHeight = 1000;
    Object.defineProperties(content, {
      scrollHeight: { configurable: true, get: () => scrollHeight },
      clientHeight: { configurable: true, get: () => height },
    });
    content.scrollTop = 200; fireEvent.scroll(content);
    expect(surface.getByRole('button', { name: '최신 로그로' })).toBeVisible();
    // The larger viewport fits the text and the browser clamps its offset to zero.
    height = 1000; content.scrollTop = 0; fireEvent.scroll(content);
    expect(surface.getByRole('button', { name: '최신 로그로' })).toBeVisible();
    height = 100; scrollHeight = 1200;
    // Simulate a new native frame while the modal makes the normal App inert.
    fireEvent.click(screen.getByRole('button', { name: 'Next frame' }));
    expect(content).toHaveTextContent('frame 2');
    expect(content.scrollTop).toBe(0);
    await user.click(surface.getByRole('button', { name: '최신 로그로' }));
    expect(content.scrollTop).toBe(1200);
    expect(surface.queryByRole('button', { name: '최신 로그로' })).not.toBeInTheDocument();
    scrollHeight = 1400;
    fireEvent.click(screen.getByRole('button', { name: 'Next frame' }));
    expect(content.scrollTop).toBe(1400);
  });
  it('closes the expanded log dialog from a direct icon action on Escape and restores focus', async () => {
    const user = userEvent.setup(); renderLiveLogs();
    await user.click(screen.getByRole('button', { name: '로그 확대 보기' }));
    const dialog = screen.getByRole('dialog');
    const copy = within(dialog).getByRole('button', { name: '표시된 로그 복사' });
    expect(copy).toBeVisible();
    copy.focus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '로그 확대 보기' })).toHaveFocus();
  });
});
