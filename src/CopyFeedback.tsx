import { useMemo } from 'react';
import './copyFeedback.css';

export type CopyFeedbackTone = 'success' | 'cleared' | 'error';

export function CopyFeedback({ message, tone = 'success', notificationId = 0, highlighted = false, highlightUntil, className = '' }: {
  message: string; tone?: CopyFeedbackTone; notificationId?: number; highlighted?: boolean; highlightUntil?: number; className?: string;
}) {
  // A new surface joins the existing animation; translations keep its DOM/delay.
  const elapsed = useMemo(() => highlightUntil === undefined ? 0 : Math.min(2_000, Math.max(0, 2_000 - (highlightUntil - Date.now()))), [notificationId, highlightUntil]);
  const active = !!message && highlighted && (highlightUntil === undefined || highlightUntil > Date.now());
  return <div className={`copy-feedback-slot ${className}${message ? ` copy-feedback-${tone}` : ''}${active ? ' copy-feedback-highlighted' : ''}`} role="status" aria-live="polite" aria-atomic="true">
    {active && <span key={`glow-${notificationId}`} className="copy-feedback-glow" aria-hidden="true" style={{ animationDelay: `-${elapsed}ms` }} />}
    {message && <span key={notificationId} className="copy-feedback-text" title={message}>{message}</span>}
  </div>;
}
