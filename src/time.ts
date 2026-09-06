import type { Language } from './preferences';

function locale(language: Language) { return language === 'ko' ? 'ko-KR' : 'en-US'; }

export function parseTimestamp(value?: string): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date;
}

export function sameLocalDay(date: Date, now: Date): boolean {
  return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
}

export function formatDate(date: Date, language: Language): string {
  return new Intl.DateTimeFormat(locale(language), { year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

/** Add the date to snapshot timestamps that are no longer from the local day. */
export function formatDisplayTime(date: Date, language: Language, now = new Date()): string {
  const time = new Intl.DateTimeFormat(locale(language), { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(date);
  return sameLocalDay(date, now) ? time : `${formatDate(date, language)} ${time}`;
}

export function formatExactTime(date: Date, language: Language): string {
  return new Intl.DateTimeFormat(locale(language), {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'longOffset',
  }).format(date);
}

export function formatRelativeAge(date: Date, language: Language, now = new Date()): string {
  // A future timestamp can follow a clock correction; do not imply a future read.
  const minutes = Math.floor(Math.max(0, now.valueOf() - date.valueOf()) / 60_000);
  if (minutes < 1) return language === 'ko' ? '방금' : 'Just now';
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const formatter = new Intl.RelativeTimeFormat(locale(language), { numeric: 'always' });
  return days > 0 ? formatter.format(-days, 'day')
    : hours > 0 ? formatter.format(-hours, 'hour') : formatter.format(-minutes, 'minute');
}
