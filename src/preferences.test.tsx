import { useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import html from '../index.html?raw';
import { PreferencesProvider, PREFERENCES_KEY, readPreferences, usePreferences } from './preferences';
import { SettingsDialog, settingsMessages } from './SettingsDialog';
import { translate } from './i18n';
import { appMessages } from './messages/app';
import { componentMessages } from './messages/components';
import { logMessages } from './messages/logs';
import { bulkMessages } from './messages/bulk';

function mediaController(initial = false) {
  let matches = initial;
  const listeners = new Set<() => void>();
  const media = { get matches() { return matches; }, addEventListener: (_: string, callback: () => void) => listeners.add(callback), removeEventListener: (_: string, callback: () => void) => listeners.delete(callback) };
  vi.stubGlobal('matchMedia', vi.fn(() => media));
  return { change(value: boolean) { matches = value; act(() => listeners.forEach(listener => listener())); }, listeners };
}

function Harness() {
  const { theme, language, setTheme, setLanguage, storageError } = usePreferences();
  const [count, setCount] = useState(0);
  const [open, setOpen] = useState(false);
  return <>
    <output data-testid="preferences">{theme}/{language}/{String(storageError)}</output>
    <button onClick={() => setCount(value => value + 1)}>count {count}</button>
    <button onClick={() => setTheme('dark')}>dark</button>
    <button onClick={() => setTheme('light')}>light</button>
    <button onClick={() => setTheme('system')}>system</button>
    <button onClick={() => setLanguage('en')}>en</button>
    <button onClick={() => setLanguage('ko')}>ko</button>
    <button onClick={() => setOpen(true)}>settings</button>
    {open && <SettingsDialog onClose={() => setOpen(false)} returnFocus={screen.getByRole('button', { name: 'settings' })} />}
  </>;
}

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(window.navigator, 'language', 'get').mockReturnValue('ko-KR');
  mediaController();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('appearance preferences', () => {
  it('uses the OS language and system appearance on first launch', () => {
    mediaController(true);
    render(<PreferencesProvider><Harness /></PreferencesProvider>);
    expect(screen.getByTestId('preferences')).toHaveTextContent('system/ko/false');
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    expect(document.documentElement).toHaveAttribute('lang', 'ko');
    expect(document.documentElement.style.colorScheme).toBe('dark');
  });

  it('defaults to English for other OS languages', () => {
    vi.spyOn(window.navigator, 'language', 'get').mockReturnValue('fr-FR');
    expect(readPreferences().preferences).toEqual({ theme: 'system', language: 'en' });
  });

  it.each(['broken json', 'null', '[]', '{"theme":"sepia","language":"fr"}'])('falls back safely for invalid saved settings: %s', value => {
    localStorage.setItem(PREFERENCES_KEY, value);
    expect(readPreferences()).toEqual({ preferences: { theme: 'system', language: 'ko' }, storageError: false });
  });

  it('retains the valid preference when another field is invalid', () => {
    localStorage.setItem(PREFERENCES_KEY, '{"theme":"dark","language":"fr"}');
    expect(readPreferences().preferences).toEqual({ theme: 'dark', language: 'ko' });
  });

  it('applies immediately, preserves child state, and restores both choices after remount', async () => {
    const user = userEvent.setup();
    const first = render(<PreferencesProvider><Harness /></PreferencesProvider>);
    await user.click(screen.getByRole('button', { name: 'count 0' }));
    await user.click(screen.getByRole('button', { name: 'dark' }));
    await user.click(screen.getByRole('button', { name: 'en' }));
    expect(screen.getByRole('button', { name: 'count 1' })).toBeInTheDocument();
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    expect(document.documentElement).toHaveAttribute('lang', 'en');
    expect(JSON.parse(localStorage.getItem(PREFERENCES_KEY)!)).toEqual({ theme: 'dark', language: 'en' });
    first.unmount();
    render(<PreferencesProvider><Harness /></PreferencesProvider>);
    expect(screen.getByTestId('preferences')).toHaveTextContent('dark/en/false');
  });

  it('follows OS changes only in system mode and cleans up listeners', async () => {
    const media = mediaController();
    const user = userEvent.setup();
    const view = render(<PreferencesProvider><Harness /></PreferencesProvider>);
    expect(media.listeners.size).toBe(1);
    media.change(true);
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    await user.click(screen.getByRole('button', { name: 'light' }));
    expect(media.listeners.size).toBe(0);
    media.change(true);
    expect(document.documentElement).toHaveAttribute('data-theme', 'light');
    await user.click(screen.getByRole('button', { name: 'system' }));
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    expect(media.listeners.size).toBe(1);
    view.unmount();
    expect(media.listeners.size).toBe(0);
  });

  it('keeps current selections usable and explains failed persistence in the selected language', async () => {
    const user = userEvent.setup();
    const save = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('denied', 'SecurityError'); });
    render(<PreferencesProvider><Harness /></PreferencesProvider>);
    await user.click(screen.getByRole('button', { name: 'settings' }));
    await user.selectOptions(screen.getByRole('combobox', { name: '테마' }), 'light');
    await user.selectOptions(screen.getByRole('combobox', { name: '언어' }), 'en');
    expect(document.documentElement).toHaveAttribute('data-theme', 'light');
    expect(screen.getByRole('alert')).toHaveTextContent('Settings could not be saved');
    expect(screen.getByTestId('preferences')).toHaveTextContent('light/en/true');
    save.mockRestore();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Theme' }), 'dark');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(PREFERENCES_KEY)!)).toEqual({ theme: 'dark', language: 'en' });
  });

  it('opens even when access to local storage itself fails', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('denied', 'SecurityError'); });
    render(<PreferencesProvider><Harness /></PreferencesProvider>);
    expect(screen.getByTestId('preferences')).toHaveTextContent('system/ko/true');
  });

  it('traps keyboard focus, retains it across language changes, and restores the trigger on Escape', async () => {
    const user = userEvent.setup();
    render(<PreferencesProvider><Harness /></PreferencesProvider>);
    const trigger = screen.getByRole('button', { name: 'settings' });
    await user.click(trigger);
    const theme = screen.getByRole('combobox', { name: '테마' });
    expect(theme).toHaveFocus();
    const language = screen.getByRole('combobox', { name: '언어' });
    await user.selectOptions(language, 'en');
    expect(language).toHaveFocus();
    const closes = screen.getAllByRole('button', { name: 'Close' });
    closes.at(-1)!.focus();
    await user.tab();
    expect(closes[0]).toHaveFocus();
    await user.tab({ shift: true });
    expect(closes.at(-1)).toHaveFocus();
    fireEvent.keyDown(language, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('bootstraps the same saved language/theme before React renders', () => {
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify({ theme: 'light', language: 'en' }));
    mediaController(true);
    const bootstrap = html.match(/<script>([\s\S]*?)<\/script>/)![1]!;
    new Function(bootstrap)();
    expect(document.documentElement).toHaveAttribute('data-theme', 'light');
    expect(document.documentElement).toHaveAttribute('lang', 'en');
    expect(document.documentElement.style.colorScheme).toBe('light');
  });
});

describe('bilingual dictionaries', () => {
  it.each([settingsMessages, appMessages, componentMessages, logMessages, bulkMessages])('has both translations and matching placeholders in each dictionary', messages => {
    for (const value of Object.values(messages)) {
      expect(Object.keys(value).sort()).toEqual(['en', 'ko']);
      expect(value.ko.length).toBeGreaterThan(0);
      expect(value.en.length).toBeGreaterThan(0);
      expect(value.ko.match(/\{\w+\}/g)?.sort() ?? []).toEqual(value.en.match(/\{\w+\}/g)?.sort() ?? []);
    }
  });
  it('interpolates values without altering raw identifiers or interpreting HTML', () => {
    const messages = { count: { ko: '{name}: {count}건', en: '{name}: {count} items' } };
    expect(translate(messages, 'en', 'count', { name: '<raw-container>', count: 3 })).toBe('<raw-container>: 3 items');
    expect(translate(messages, 'ko', 'count', { name: '<raw-container>', count: 3 })).toBe('<raw-container>: 3건');
  });
});
