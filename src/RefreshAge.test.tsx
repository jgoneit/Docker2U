import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PreferencesProvider, usePreferences, type Language } from './preferences';
import { RefreshAge } from './RefreshAge';
import { formatDate, formatDisplayTime, formatExactTime, parseTimestamp } from './time';

const noon = new Date(2026, 8, 6, 12, 0, 0);
function mount(refreshedAt?: string, language: Language = 'ko') {
  return render(<PreferencesProvider initialPreferences={{ language, theme: 'light' }}><RefreshAge refreshedAt={refreshedAt} /></PreferencesProvider>);
}

beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); vi.clearAllTimers(); vi.setSystemTime(noon); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('inventory check age', () => {
  it.each(['ko', 'en'] as const)('distinguishes an unread list from an invalid timestamp in %s', language => {
    const view = mount(undefined, language);
    expect(screen.getByText(language === 'ko' ? '목록 미조회' : 'List not checked')).toBeInTheDocument();
    expect(document.querySelector('time')).not.toBeInTheDocument();
    view.unmount();
    mount('not a timestamp', language);
    expect(screen.getByText(language === 'ko' ? '목록 확인 시각 알 수 없음' : 'List check time unavailable')).toBeInTheDocument();
    expect(document.querySelector('time')).not.toBeInTheDocument();
  });

  it.each([
    ['ko', 0, '방금'], ['ko', 3, '3분 전'], ['ko', 120, '2시간 전'],
    ['en', 0, 'Just now'], ['en', 3, '3 minutes ago'], ['en', 120, '2 hours ago'],
  ] as const)('shows elapsed time in %s after %d minutes', (language, minutes, expected) => {
    mount(new Date(noon.valueOf() - minutes * 60_000).toISOString(), language);
    expect(screen.getByText(expected)).toBeInTheDocument();
  });

  it('clamps a future timestamp to just now after a local clock correction', () => {
    mount(new Date(noon.valueOf() + 60_000).toISOString());
    expect(screen.getByText('방금')).toBeInTheDocument();
  });

  it.each(['ko', 'en'] as const)('provides the exact date, seconds, and time zone in %s', language => {
    const checked = new Date(2026, 8, 6, 11, 59, 37);
    mount(checked.toISOString(), language);
    const time = document.querySelector('time')!;
    expect(time).toHaveAttribute('datetime', checked.toISOString());
    expect(time.title).toContain('2026');
    expect(time.title).toContain(':37');
    expect(time.title).toMatch(/GMT/);
    expect(time).toHaveAccessibleName(new RegExp(language === 'ko' ? '목록 확인: 방금' : 'List checked: Just now'));
    expect(time.getAttribute('aria-label')).toContain(formatExactTime(checked, language));
  });

  it('adds a visible date when the local day changes, even within the same minute', () => {
    const checked = new Date(2026, 8, 6, 23, 59, 45);
    vi.setSystemTime(checked);
    mount(checked.toISOString());
    expect(screen.getByText('방금')).toBeInTheDocument();
    vi.setSystemTime(new Date(2026, 8, 7, 0, 0, 15));
    fireEvent.focus(window);
    expect(screen.getByText(`${formatDate(checked, 'ko')} · 방금`)).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByText(`${formatDate(checked, 'ko')} · 1분 전`)).toBeInTheDocument();
  });

  it('updates only the component once per minute without rerendering its parent', () => {
    const parentRendered = vi.fn();
    function Parent() { parentRendered(); return <RefreshAge refreshedAt={noon.toISOString()} />; }
    render(<PreferencesProvider initialPreferences={{ language: 'ko', theme: 'light' }}><Parent /></PreferencesProvider>);
    expect(vi.getTimerCount()).toBe(1);
    act(() => vi.advanceTimersByTime(59_999));
    expect(screen.getByText('방금')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByText('1분 전')).toBeInTheDocument();
    expect(parentRendered).toHaveBeenCalledTimes(1);
  });

  it('resynchronizes on becoming visible or focusing after suspended timers', () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    mount(noon.toISOString());
    vi.setSystemTime(new Date(noon.valueOf() + 3 * 60_000));
    fireEvent(document, new Event('visibilitychange'));
    expect(screen.getByText('방금')).toBeInTheDocument();
    visibility.mockReturnValue('visible');
    fireEvent(document, new Event('visibilitychange'));
    expect(screen.getByText('3분 전')).toBeInTheDocument();
    vi.setSystemTime(new Date(noon.valueOf() + 2 * 60 * 60_000));
    fireEvent.focus(window);
    expect(screen.getByText('2시간 전')).toBeInTheDocument();
  });

  it('resynchronizes when a newly accepted timestamp replaces the last check', () => {
    const view = mount(noon.toISOString());
    vi.setSystemTime(new Date(noon.valueOf() + 10 * 60_000));
    const refreshedAt = new Date(noon.valueOf() + 7 * 60_000).toISOString();
    view.rerender(<PreferencesProvider initialPreferences={{ language: 'ko', theme: 'light' }}><RefreshAge refreshedAt={refreshedAt} /></PreferencesProvider>);
    expect(screen.getByText('3분 전')).toBeInTheDocument();
  });

  it('changes language immediately while retaining the accepted timestamp', () => {
    const intervals = vi.spyOn(window, 'setInterval');
    function Harness() {
      const { setLanguage } = usePreferences();
      return <><button onClick={() => setLanguage('en')}>English</button><RefreshAge refreshedAt={noon.toISOString()} /></>;
    }
    render(<PreferencesProvider initialPreferences={{ language: 'ko', theme: 'light' }}><Harness /></PreferencesProvider>);
    act(() => vi.advanceTimersByTime(3 * 60_000));
    fireEvent.click(screen.getByRole('button', { name: 'English' }));
    expect(screen.getByText('3 minutes ago')).toBeInTheDocument();
    expect(document.querySelector('time')).toHaveAttribute('datetime', noon.toISOString());
    expect(intervals).toHaveBeenCalledTimes(1);
  });

  it('removes its timer and focus/visibility listeners on unmount', () => {
    const addWindow = vi.spyOn(window, 'addEventListener');
    const removeWindow = vi.spyOn(window, 'removeEventListener');
    const addDocument = vi.spyOn(document, 'addEventListener');
    const removeDocument = vi.spyOn(document, 'removeEventListener');
    const view = mount(noon.toISOString());
    const focus = addWindow.mock.calls.find(([event]) => event === 'focus')![1];
    const visibility = addDocument.mock.calls.find(([event]) => event === 'visibilitychange')![1];
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
    expect(removeWindow).toHaveBeenCalledWith('focus', focus);
    expect(removeDocument).toHaveBeenCalledWith('visibilitychange', visibility);
  });
});

describe('snapshot time formatting', () => {
  it('keeps same-day timestamps compact and adds a full date across a year boundary', () => {
    const checked = new Date(2025, 11, 31, 23, 59, 37);
    expect(formatDisplayTime(checked, 'en', checked)).toBe('11:59:37 PM');
    expect(formatDisplayTime(checked, 'en', new Date(2026, 0, 1))).toBe('12/31/2025 11:59:37 PM');
  });

  it('rejects missing and invalid timestamps without fabricating a recent time', () => {
    expect(parseTimestamp()).toBeNull();
    expect(parseTimestamp('')).toBeNull();
    expect(parseTimestamp('invalid')).toBeNull();
    expect(parseTimestamp(noon.toISOString())).toEqual(noon);
  });
});
