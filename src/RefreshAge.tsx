import { useEffect, useState } from 'react';
import { useI18n, type Messages } from './i18n';
import { usePreferences } from './preferences';
import { formatDate, formatExactTime, formatRelativeAge, parseTimestamp, sameLocalDay } from './time';

const messages = {
  checked: { ko: '목록 확인', en: 'List checked' },
  notChecked: { ko: '목록 미조회', en: 'List not checked' },
  unknown: { ko: '목록 확인 시각 알 수 없음', en: 'List check time unavailable' },
} satisfies Messages;

export function RefreshAge({ refreshedAt }: { refreshedAt?: string }) {
  const { language } = usePreferences();
  const t = useI18n(messages);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const sync = () => setNow(new Date());
    const onVisibility = () => { if (document.visibilityState === 'visible') sync(); };
    const timer = window.setInterval(sync, 60_000);
    window.addEventListener('focus', sync);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', sync);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);
  useEffect(() => { setNow(new Date()); }, [refreshedAt]);

  const date = parseTimestamp(refreshedAt);
  if (!date) return <span className="refresh-age">{t(refreshedAt ? 'unknown' : 'notChecked')}</span>;
  const relative = formatRelativeAge(date, language, now);
  const visible = sameLocalDay(date, now) ? relative : `${formatDate(date, language)} · ${relative}`;
  const exact = formatExactTime(date, language);
  return <time className="refresh-age" dateTime={date.toISOString()} title={`${t('checked')}: ${exact}`} aria-label={`${t('checked')}: ${relative} (${exact})`}>
    <span className="refresh-age-label">{t('checked')}</span><span>{visible}</span>
  </time>;
}
