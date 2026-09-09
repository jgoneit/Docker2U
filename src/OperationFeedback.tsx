import type { RefObject } from 'react';
import { History, LoaderCircle, X } from 'lucide-react';
import { useI18n } from './i18n';
import { usePreferences } from './preferences';
import { componentMessages } from './messages/components';
import { operationFeedbackMessages, operationFeedbackText, operationFeedbackTone } from './operationFeedbackModel';
import type { OperationFeedbackModel } from './useOperationFeedback';
import './operationFeedback.css';

export function OperationFeedback({ model, detailsId, recentButtonRef, onOpenDetails, announce = true, className = '' }: {
  model: OperationFeedbackModel;
  detailsId?: string;
  recentButtonRef?: RefObject<HTMLButtonElement | null>;
  onOpenDetails?: (trigger: HTMLButtonElement) => void;
  announce?: boolean;
  className?: string;
}) {
  const t = useI18n(operationFeedbackMessages);
  const labels = useI18n(componentMessages);
  const { language } = usePreferences();
  const { pending, completed, messageVisible } = model;
  const text = completed ? operationFeedbackText(completed, language) : null;
  const visibleResult = !pending && completed && messageVisible;
  const tone = visibleResult ? operationFeedbackTone(completed) : undefined;
  const pendingTarget = pending ? pending.kind === 'single' ? pending.name : t('count', { count: pending.count }) : '';
  const title = completed && text ? `${text.full}\n${t('confirmedAt', { time: new Date(completed.completedAt).toLocaleString(language === 'ko' ? 'ko-KR' : 'en-US') })}` : undefined;
  const kind = pending?.kind ?? completed?.result.kind;
  return <div className={`operation-feedback ${className}${kind ? ` operation-feedback-${kind}` : ''}${tone ? ` operation-feedback-${tone}` : ''}`} data-active={!!pending || !!visibleResult || undefined}>
    <div className="operation-feedback-message" role="status" aria-label={t('region')} aria-live={announce ? 'polite' : 'off'} aria-atomic="true">
      {pending ? <><LoaderCircle className="spin" size={13} aria-hidden="true" /><span className="operation-feedback-outcome">{t('pending', { action: labels(pending.action) })}</span><span className="operation-feedback-target" title={pendingTarget}>{pendingTarget}</span></>
        : visibleResult && text ? <><span className="operation-feedback-outcome">{text.action} · {text.outcome}</span><span className="operation-feedback-target" title={title}>· {text.target}</span>{text.qualifier && <span className="operation-feedback-qualifier">· {text.qualifier}</span>}</> : null}
    </div>
    {completed && <button ref={recentButtonRef} type="button" className="text-button operation-feedback-details" aria-label={t('openDetails')} aria-expanded={model.detailsOpen} aria-controls={model.detailsOpen ? detailsId : undefined} title={title} onClick={event => {
      if (onOpenDetails) onOpenDetails(event.currentTarget);
      else model.openDetails();
    }}><History size={13} aria-hidden="true" /><span>{t('recent')}</span></button>}
    {visibleResult && tone !== 'success' && <button type="button" className="icon-button operation-feedback-dismiss" aria-label={t('dismiss')} title={t('dismiss')} onClick={event => {
      // Removing a keyboard-focused close button must not drop focus onto the body.
      const focused = document.activeElement === event.currentTarget;
      const trigger = event.currentTarget.parentElement?.querySelector<HTMLButtonElement>('.operation-feedback-details');
      model.dismissMessage();
      if (focused) trigger?.focus();
    }}><X size={13} aria-hidden="true" /></button>}
  </div>;
}
