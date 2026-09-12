import { useEffect, useLayoutEffect, useRef } from 'react';
import { ChevronsUpDown, Settings, X } from 'lucide-react';
import { usePreferences } from './preferences';
import type { Language, ThemePreference } from './preferences';
import { useI18n } from './i18n';
import type { Messages } from './i18n';

export const settingsMessages = {
  title: { ko: '설정', en: 'Settings' },
  description: { ko: '화면 테마와 언어를 선택하세요. 변경 사항은 바로 적용됩니다.', en: 'Choose your appearance and language. Changes apply immediately.' },
  theme: { ko: '테마', en: 'Theme' },
  system: { ko: '시스템 설정 따르기', en: 'Follow system' },
  light: { ko: '라이트', en: 'Light' },
  dark: { ko: '다크', en: 'Dark' },
  language: { ko: '언어', en: 'Language' },
  close: { ko: '닫기', en: 'Close' },
  storageError: { ko: '설정을 저장할 수 없습니다. 현재 실행에는 적용되지만 다음 실행에서 복원되지 않을 수 있습니다.', en: 'Settings could not be saved. They apply now but may not be restored when you reopen the app.' },
} satisfies Messages;

export function SettingsDialog({ onClose, returnFocus }: { onClose: () => void; returnFocus?: HTMLElement }) {
  const { theme, language, setTheme, setLanguage, storageError } = usePreferences();
  const t = useI18n(settingsMessages);
  const dialog = useRef<HTMLDivElement>(null);
  const trigger = useRef(returnFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  useLayoutEffect(() => {
    dialog.current?.querySelector<HTMLSelectElement>('select')?.focus();
  }, []);
  // Passive cleanup runs after the parent removes inert from the background.
  useEffect(() => () => { if (trigger.current?.isConnected) trigger.current.focus(); }, []);
  return <div className="modal-backdrop">
    <div ref={dialog} className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title" aria-describedby="settings-description"
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
        if (event.key !== 'Tab') return;
        const controls = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled), [tabindex="0"]') ?? [])];
        const first = controls[0];
        const last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}>
      <div className="settings-heading"><h2 id="settings-title"><Settings size={20} aria-hidden="true" />{t('title')}</h2><button className="icon-button" onClick={onClose} aria-label={t('close')} title={t('close')}><X size={18} /></button></div>
      <p id="settings-description">{t('description')}</p>
      <label className="setting-field" htmlFor="theme-preference"><span>{t('theme')}</span><span className="setting-select-control"><select id="theme-preference" value={theme} onChange={event => setTheme(event.target.value as ThemePreference)}><option value="system">{t('system')}</option><option value="light">{t('light')}</option><option value="dark">{t('dark')}</option></select><ChevronsUpDown size={14} aria-hidden="true" /></span></label>
      <label className="setting-field" htmlFor="language-preference"><span>{t('language')}</span><span className="setting-select-control"><select id="language-preference" value={language} onChange={event => setLanguage(event.target.value as Language)}><option value="ko" lang="ko">한국어</option><option value="en" lang="en">English</option></select><ChevronsUpDown size={14} aria-hidden="true" /></span></label>
      {storageError && <p className="settings-storage-error" role="alert">{t('storageError')}</p>}
      <div className="dialog-actions"><button onClick={onClose}>{t('close')}</button></div>
    </div>
  </div>;
}
