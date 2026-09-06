import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { applyTheme, DARK_MODE_QUERY } from './theme';
import type { ThemePreference } from './theme';

export type { ThemePreference } from './theme';
export type Language = 'ko' | 'en';
export interface Preferences { theme: ThemePreference; language: Language }
export const PREFERENCES_KEY = 'docker2u.preferences.v1';

export function defaultPreferences(): Preferences {
  return { theme: 'system', language: navigator.language.toLowerCase().startsWith('ko') ? 'ko' : 'en' };
}

export function readPreferences(): { preferences: Preferences; storageError: boolean } {
  const fallback = defaultPreferences();
  try {
    const raw = window.localStorage.getItem(PREFERENCES_KEY);
    if (!raw) return { preferences: fallback, storageError: false };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { preferences: fallback, storageError: false };
    const value = parsed as Partial<Preferences>;
    return { preferences: {
      theme: value.theme === 'system' || value.theme === 'light' || value.theme === 'dark' ? value.theme : fallback.theme,
      language: value.language === 'ko' || value.language === 'en' ? value.language : fallback.language,
    }, storageError: false };
  } catch (error) {
    return { preferences: fallback, storageError: !(error instanceof SyntaxError) };
  }
}

export function initializePreferences(): void {
  const { preferences } = readPreferences();
  applyTheme(preferences.theme);
  document.documentElement.lang = preferences.language;
}

interface PreferencesContextValue extends Preferences {
  setLanguage: (language: Language) => void;
  setTheme: (theme: ThemePreference) => void;
  storageError: boolean;
}
const PreferencesContext = createContext<PreferencesContextValue | null>(null);

export function PreferencesProvider({ children, initialPreferences }: { children: ReactNode; initialPreferences?: Preferences }) {
  const [initial] = useState(() => initialPreferences ? { preferences: initialPreferences, storageError: false } : readPreferences());
  const [preferences, setPreferences] = useState(initial.preferences);
  const [storageError, setStorageError] = useState(initial.storageError);
  const current = useRef(preferences);
  const update = useCallback((patch: Partial<Preferences>) => {
    const next = { ...current.current, ...patch };
    current.current = next;
    setPreferences(next);
    try {
      window.localStorage.setItem(PREFERENCES_KEY, JSON.stringify(next));
      setStorageError(false);
    } catch {
      setStorageError(true);
    }
  }, []);
  const setLanguage = useCallback((language: Language) => update({ language }), [update]);
  const setTheme = useCallback((theme: ThemePreference) => update({ theme }), [update]);

  useLayoutEffect(() => {
    applyTheme(preferences.theme);
    document.documentElement.lang = preferences.language;
  }, [preferences.theme, preferences.language]);
  useEffect(() => {
    if (preferences.theme !== 'system' || typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(DARK_MODE_QUERY);
    const onChange = () => applyTheme('system');
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [preferences.theme]);

  return <PreferencesContext.Provider value={{ ...preferences, storageError, setLanguage, setTheme }}>{children}</PreferencesContext.Provider>;
}

export function usePreferences(): PreferencesContextValue {
  const context = useContext(PreferencesContext);
  if (!context) throw new Error('usePreferences must be used within PreferencesProvider.');
  return context;
}
