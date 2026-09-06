import { useEffect, type RefObject } from 'react';
import { AlertTriangle, LoaderCircle, Play, RefreshCw, Square } from 'lucide-react';
import type { Action, BulkMutationResult, ConnectionTarget, Container, CoreError } from './api';
import { actionLabel, ConnectionFacts, ErrorDetails, ResultDisclosure, stateLabel } from './components';
import { translate, useI18n } from './i18n';
import { bulkMessages } from './messages/bulk';
import { usePreferences, type Language } from './preferences';

export function canApply(container: Container, action: Action) {
  return action === 'start' ? ['created', 'exited'].includes(container.state) : container.state === 'running';
}
export function exclusionReason(container: Container, action: Action, language: Language = 'ko') {
  return translate(bulkMessages, language, action === 'start' ? 'startOnly' : 'runningOnly', { state: stateLabel(container.state, language), action: actionLabel(action, language) });
}
export type BulkOperation = {
  action: Action;
  containers: Container[];
  needsReconnect: boolean;
} & ConnectionTarget & ({ result: BulkMutationResult; error?: never; uncertain?: never } | { result?: never; error: CoreError; uncertain: boolean });

// Tauri's generic return type does not validate the received JSON at runtime.
// Keep an unbound or incomplete response from being presented as a known result.
export function isBoundBulkResult(value: BulkMutationResult, sessionId: string, generation: number, containers: Container[], action: Action): boolean {
  const outcomes = new Set(['succeeded', 'failed', 'resultUnknown', 'skipped', 'notExecuted']);
  if (!value || value.sessionId !== sessionId || value.generation !== generation || value.action !== action || typeof value.mutationBlocked !== 'boolean' || !Array.isArray(value.items) || value.items.length !== containers.length) return false;
  return value.items.every((item, index) => {
    const target = containers[index];
    if (!item || !target || item.handle !== target.handle || item.fullId !== target.fullId || item.name !== target.name || !outcomes.has(item.outcome) || typeof item.message !== 'string') return false;
    if (item.error && (typeof item.error.code !== 'string' || typeof item.error.message !== 'string' || (item.error.command != null && typeof item.error.command !== 'string') || (item.error.stderr != null && typeof item.error.stderr !== 'string'))) return false;
    const executed = ['succeeded', 'failed', 'resultUnknown'].includes(item.outcome);
    if (executed !== !!item.result) return false;
    if (item.result && (item.result.outcome !== item.outcome || !['succeeded', 'failed', 'notNeeded'].includes(item.result.reconciliation) || typeof item.result.mutationBlocked !== 'boolean' || typeof item.result.message !== 'string' || typeof item.result.command !== 'string' || typeof item.result.stderr !== 'string' || (item.result.observedState != null && typeof item.result.observedState !== 'string'))) return false;
    return true;
  });
}

export function BulkSelection({ visible, checked, disabled, actionsDisabled, pending, selectAllRef, regionRef, onToggleAll, onClear, onAction }: {
  visible: Container[]; checked: Container[]; disabled: boolean; actionsDisabled: boolean;
  pending: { action: Action; count: number } | null;
  selectAllRef: RefObject<HTMLInputElement | null>; regionRef: RefObject<HTMLElement | null>;
  onToggleAll: () => void; onClear: () => void; onAction: (action: Action, returnFocus?: HTMLElement) => void;
}) {
  const t = useI18n(bulkMessages);
  const { language } = usePreferences();
  const partial = checked.length > 0 && checked.length < visible.length;
  useEffect(() => { if (selectAllRef.current) selectAllRef.current.indeterminate = partial; }, [partial, selectAllRef]);
  return <section ref={regionRef} tabIndex={-1} className="bulk-selection" aria-label={t('region')}>
    <div className="selection-heading"><label><input ref={selectAllRef} type="checkbox" aria-label={t('selectVisible')} aria-checked={partial ? 'mixed' : checked.length > 0 && checked.length === visible.length} checked={checked.length > 0 && checked.length === visible.length} disabled={disabled || !visible.length} onChange={onToggleAll} />{t('selectAll')} <span className="muted">({visible.length})</span></label>{checked.length > 0 && <button className="text-button" disabled={disabled} onClick={onClear}>{t('clearSelection')}</button>}</div>
    {checked.length > 0 && <><p className="selection-count" role="status">{t('selected', { count: checked.length })}</p><div className="bulk-actions">{(['start', 'stop', 'restart'] as const).map(action => {
      const count = checked.filter(container => canApply(container, action)).length;
      const Icon = action === 'start' ? Play : action === 'stop' ? Square : RefreshCw;
      return <button key={action} className={`action-button action-${action}`} disabled={actionsDisabled || count === 0} onClick={event => { if (action !== 'start') event.currentTarget.focus(); onAction(action, event.currentTarget); }}><Icon size={13} aria-hidden="true" />{actionLabel(action, language)} ({count})</button>;
    })}</div><details className="technical-details selection-exclusions"><summary>{t('exclusions')}</summary>{(['start', 'stop', 'restart'] as const).map(action => {
      const excluded = checked.filter(container => !canApply(container, action));
      return <div key={action}><h3>{t('excluded', { action: actionLabel(action, language), count: excluded.length })}</h3>{excluded.length ? <ul>{excluded.map(container => <li key={container.handle}><strong>{container.name}</strong> · {container.shortId}<p>{exclusionReason(container, action, language)}</p></li>)}</ul> : <p>{t('allEligible')}</p>}</div>;
    })}</details></>}
    {pending && <p className="operation-notice" role="status"><LoaderCircle size={16} className="spin" aria-hidden="true" />{t('pending', { action: actionLabel(pending.action, language), count: pending.count })}</p>}
  </section>;
}

const outcomes = ['succeeded', 'failed', 'resultUnknown', 'skipped', 'notExecuted'] as const;
function resultClass(operation: BulkOperation) {
  const { result } = operation;
  if (!result) return operation.uncertain ? 'outcome-resultUnknown' : 'outcome-failed';
  if (operation.needsReconnect || result.mutationBlocked || result.items.some(item => ['resultUnknown', 'notExecuted'].includes(item.outcome) || item.result?.mutationBlocked || item.result?.reconciliation === 'failed')) return 'outcome-resultUnknown';
  if (result.items.some(item => item.outcome === 'failed')) return 'outcome-failed';
  return result.items.some(item => item.outcome === 'succeeded') ? '' : 'outcome-neutral';
}
export function BulkResult({ operation }: { operation: BulkOperation }) {
  const t = useI18n(bulkMessages);
  const { language } = usePreferences();
  const { result } = operation;
  const warning = operation.needsReconnect || resultClass(operation) === 'outcome-resultUnknown';
  const content = <>
    {result ? <details className="technical-details"><summary>{t('itemDetails', { count: result.items.length })}</summary><ConnectionFacts target={operation} /><ul className="bulk-result-items">{result.items.map(item => <li key={item.handle}><div><strong>{item.name}</strong><span className={`bulk-outcome bulk-outcome-${item.outcome}`}>{t(item.outcome)}</span></div><code title={item.fullId}>{item.fullId}</code>
      {item.outcome === 'resultUnknown' && <p>{t('unknown')}</p>}
      {item.result?.reconciliation === 'failed' && <p>{t('failedReconciliation')}</p>}
      {item.result?.reconciliation === 'succeeded' && <p>{t('reconciled', { state: item.result.observedState ? ` · ${stateLabel(item.result.observedState, language)}` : '' })}</p>}
      {item.error && <ErrorDetails error={item.error} />}
      <details className="technical-details"><summary>{t('executionDetails')}</summary><pre tabIndex={0}>{item.message}</pre>{item.result && <><pre tabIndex={0}>{item.result.message}</pre>{item.result.command && <pre tabIndex={0}>{item.result.command}</pre>}{item.result.stderr && <pre tabIndex={0}>{item.result.stderr}</pre>}</>}</details>
    </li>)}</ul></details> : <><p>{t(operation.uncertain ? 'unknownRequest' : 'rejected')}</p><ErrorDetails error={operation.error} /></>}
    {operation.needsReconnect ? <p>{t('blocked')}</p> : !result && <p>{t('refresh')}</p>}
  </>;
  return <section className={`bulk-result operation-result ${resultClass(operation)}`} aria-label={t('regionResult')}>
    <h3>{!result && <AlertTriangle size={16} aria-hidden="true" />}{t(result ? 'titleResult' : operation.uncertain ? 'titleUnknown' : 'titleRejected', { action: actionLabel(operation.action, language) })}</h3>
    <p>{t('selected', { count: operation.containers.length })}</p>
    {result && <p role="status" className="bulk-summary">{outcomes.map(outcome => <span key={outcome}>{t('outcomeCount', { outcome: t(outcome), count: result.items.filter(item => item.outcome === outcome).length })}</span>)}</p>}
    {result?.items.some(item => item.outcome === 'resultUnknown' || item.outcome === 'notExecuted') && <p>{t('uncertainItems')}</p>}
    {warning ? content : <ResultDisclosure identity={operation}>{content}</ResultDisclosure>}
  </section>;
}
