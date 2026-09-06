export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

export const DARK_MODE_QUERY = '(prefers-color-scheme: dark)';

export function systemTheme(): ResolvedTheme {
  return typeof window.matchMedia === 'function' && window.matchMedia(DARK_MODE_QUERY).matches ? 'dark' : 'light';
}

export function applyTheme(preference: ThemePreference): void {
  const theme = preference === 'system' ? systemTheme() : preference;
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', theme);
}
