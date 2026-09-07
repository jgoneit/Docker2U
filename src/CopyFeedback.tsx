import { AlertCircle, CheckCircle2 } from 'lucide-react';
import './copyFeedback.css';

export type CopyFeedbackTone = 'success' | 'error';

export function CopyFeedback({ message, tone = 'success', notificationId = 0, className = '' }: {
  message: string; tone?: CopyFeedbackTone; notificationId?: number; className?: string;
}) {
  const Icon = tone === 'error' ? AlertCircle : CheckCircle2;
  // Keep the live region mounted. Repeated copies re-enter without moving focus
  // or expiring a message before it can be read.
  return <div className={`copy-feedback-slot ${className}`} role="status" aria-live="polite" aria-atomic="true">
    {message && <div key={notificationId} className={`copy-feedback copy-feedback-${tone}`}>
      <Icon size={17} aria-hidden="true" /><span>{message}</span>
    </div>}
  </div>;
}
