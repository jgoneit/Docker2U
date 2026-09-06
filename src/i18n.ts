import { useCallback } from 'react';
import { usePreferences } from './preferences';
import type { Language } from './preferences';

export type { Language } from './preferences';
export type Messages = Record<string, { ko: string; en: string }>;
export type MessageParams = Record<string, string | number>;

/** Pure translation helper: pass the current language explicitly outside React. */
export function translate<M extends Messages>(messages: M, language: Language, key: keyof M, params: MessageParams = {}): string {
  const message = messages[key]?.[language];
  if (message === undefined) throw new Error(`Missing translation: ${String(key)}/${language}`);
  return message.replace(/\{(\w+)\}/g, (placeholder, name: string) => params[name] === undefined ? placeholder : String(params[name]));
}

export function useI18n<M extends Messages>(messages: M) {
  const { language } = usePreferences();
  return useCallback((key: keyof M, params?: MessageParams) => translate(messages, language, key, params), [messages, language]);
}
