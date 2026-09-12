import { useEffect, useId, useLayoutEffect, useRef } from 'react';
import { ChevronsUpDown, Settings, X } from 'lucide-react';
import { usePreferences } from './preferences';
import type { Language, ThemePreference } from './preferences';
import { useI18n } from './i18n';
import type { Messages } from './i18n';

export const settingsMessages = {
  title: { ko: '설정', en: 'Settings' },
  description: { ko: '화면 테마와 언어를 선택하세요. 변경 사항은 바로 적용됩니다.', en: 'Choose your appearance and language. Changes apply immediately.' },
  theme: { ko: '테마', en: 'Theme' },
  system: { ko: '시스템', en: 'System' },
  light: { ko: '라이트', en: 'Light' },
  dark: { ko: '다크', en: 'Dark' },
  language: { ko: '언어', en: 'Language' },
  close: { ko: '닫기', en: 'Close' },
  storageError: { ko: '설정을 저장할 수 없습니다. 현재 실행에는 적용되지만 다음 실행에서 복원되지 않을 수 있습니다.', en: 'Settings could not be saved. They apply now but may not be restored when you reopen the app.' },
} satisfies Messages;

function ThemePreview({ theme }: { theme: ThemePreference }) {
  const clipId = useId();
  const scene = <>
    <rect width="120" height="76" rx="7" fill="var(--preview-page)" />
    <rect x="9" y="9" width="102" height="58" rx="5" fill="var(--preview-window)" />
    <path d="M14 9h92a5 5 0 0 1 5 5v5H9v-5a5 5 0 0 1 5-5" fill="var(--preview-bar)" />
    <g fill="var(--preview-line)"><circle cx="15" cy="14" r="1.5" /><circle cx="20" cy="14" r="1.5" /><circle cx="25" cy="14" r="1.5" /></g>
    <rect x="14" y="24" width="21" height="37" rx="3" fill="var(--preview-bar)" />
    <rect x="17" y="28" width="15" height="5" rx="2" fill="var(--preview-accent)" />
    <g fill="var(--preview-line)"><rect x="18" y="38" width="11" height="3" rx="1.5" /><rect x="18" y="46" width="9" height="3" rx="1.5" /><rect x="41" y="26" width="34" height="5" rx="2" /><rect x="41" y="38" width="61" height="4" rx="2" /><rect x="41" y="47" width="51" height="4" rx="2" /><rect x="41" y="56" width="57" height="4" rx="2" /></g>
  </>;
  return <svg className="theme-preview" viewBox="0 0 120 76" aria-hidden="true" focusable="false">
    {theme === 'system' ? <>
      <defs><clipPath id={clipId}><rect width="60" height="76" /></clipPath></defs>
      <g className="theme-preview-dark">{scene}</g>
      <g className="theme-preview-light" clipPath={`url(#${clipId})`}>{scene}</g>
    </> : <g className={`theme-preview-${theme}`}>{scene}</g>}
  </svg>;
}

export function SettingsDialog({ onClose, returnFocus }: { onClose: () => void; returnFocus?: HTMLElement }) {
  const { theme, language, setTheme, setLanguage, storageError } = usePreferences();
  const t = useI18n(settingsMessages);
  const dialog = useRef<HTMLDivElement>(null);
  const trigger = useRef(returnFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  useLayoutEffect(() => {
    dialog.current?.querySelector<HTMLInputElement>('input[type="radio"]:checked')?.focus();
  }, []);
  // Passive cleanup runs after the parent removes inert from the background.
  useEffect(() => () => { if (trigger.current?.isConnected) trigger.current.focus(); }, []);
  return <div className="modal-backdrop">
    <div ref={dialog} className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title" aria-describedby="settings-description"
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
        if (event.key !== 'Tab') return;
        const controls = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input[type="radio"]:checked:not(:disabled), select:not(:disabled), [tabindex="0"]') ?? [])];
        const first = controls[0];
        const last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}>
      <div className="settings-heading"><h2 id="settings-title"><Settings size={20} aria-hidden="true" />{t('title')}</h2><button className="icon-button" onClick={onClose} aria-label={t('close')} title={t('close')}><X size={18} /></button></div>
      <p id="settings-description">{t('description')}</p>
      <fieldset className="setting-field setting-theme-field"><legend>{t('theme')}</legend><div className="theme-options">
        {(['system', 'light', 'dark'] as const).map(option => <label key={option} className="theme-choice">
          <ThemePreview theme={option} />
          <span className="theme-choice-label"><input type="radio" name="theme-preference" value={option} checked={theme === option} onChange={() => setTheme(option)} /><span>{t(option)}</span></span>
        </label>)}
      </div></fieldset>
      <label className="setting-field" htmlFor="language-preference"><span>{t('language')}</span><span className="setting-select-control"><select id="language-preference" value={language} onChange={event => setLanguage(event.target.value as Language)}><option value="ko" lang="ko">한국어</option><option value="en" lang="en">English</option></select><ChevronsUpDown size={14} aria-hidden="true" /></span></label>
      {storageError && <p className="settings-storage-error" role="alert">{t('storageError')}</p>}
      <div className="dialog-actions"><button onClick={onClose}>{t('close')}</button></div>
    </div>
  </div>;
}
