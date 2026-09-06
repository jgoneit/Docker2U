import { useEffect, type RefObject } from 'react';
import { AlertTriangle, LoaderCircle, Play, RefreshCw, Square } from 'lucide-react';
import type { Action, BulkMutationResult, ConnectionTarget, Container, CoreError } from './api';
import { actionLabels, ConnectionFacts, ErrorDetails, stateLabels } from './components';

export function canApply(container: Container, action: Action) {
  return action === 'start' ? ['created', 'exited'].includes(container.state) : container.state === 'running';
}
export function exclusionReason(container: Container, action: Action) {
  return `${stateLabels[container.state] ?? 'Unknown'} 상태 · ${action === 'start' ? 'Created / Stopped에서만 Start 가능' : `Running에서만 ${actionLabels[action]} 가능`}`;
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
  const partial = checked.length > 0 && checked.length < visible.length;
  useEffect(() => { if (selectAllRef.current) selectAllRef.current.indeterminate = partial; }, [partial, selectAllRef]);
  return <section ref={regionRef} tabIndex={-1} className="bulk-selection" aria-label="Container 일괄 제어">
    <div className="selection-heading"><label><input ref={selectAllRef} type="checkbox" aria-label="보이는 Container 전체 선택" aria-checked={partial ? 'mixed' : checked.length > 0 && checked.length === visible.length} checked={checked.length > 0 && checked.length === visible.length} disabled={disabled || !visible.length} onChange={onToggleAll} />전체 선택 <span className="muted">({visible.length})</span></label>{checked.length > 0 && <button className="text-button" disabled={disabled} onClick={onClear}>선택 해제</button>}</div>
    {checked.length > 0 && <><p className="selection-count" role="status">{checked.length}개 선택</p><div className="bulk-actions">{(['start', 'stop', 'restart'] as const).map(action => {
      const count = checked.filter(container => canApply(container, action)).length;
      const Icon = action === 'start' ? Play : action === 'stop' ? Square : RefreshCw;
      return <button key={action} className={action === 'start' ? 'primary-button' : ''} disabled={actionsDisabled || count === 0} onClick={event => { if (action !== 'start') event.currentTarget.focus(); onAction(action, event.currentTarget); }}><Icon size={13} aria-hidden="true" />{actionLabels[action]} ({count})</button>;
    })}</div><details className="technical-details selection-exclusions"><summary>작업별 제외 대상과 이유</summary>{(['start', 'stop', 'restart'] as const).map(action => {
      const excluded = checked.filter(container => !canApply(container, action));
      return <div key={action}><h3>{actionLabels[action]} · {excluded.length}개 제외</h3>{excluded.length ? <ul>{excluded.map(container => <li key={container.handle}><strong>{container.name}</strong> · {container.shortId}<p>{exclusionReason(container, action)}</p></li>)}</ul> : <p>선택한 모든 대상에 실행할 수 있습니다.</p>}</div>;
    })}</details></>}
    {pending && <p className="operation-notice" role="status"><LoaderCircle size={16} className="spin" aria-hidden="true" />{actionLabels[pending.action]} · {pending.count}개 대상 순서대로 처리 및 상태 재조회 중…</p>}
  </section>;
}

const outcomeLabels = { succeeded: '성공', failed: '실패', resultUnknown: '결과 불명', skipped: '제외', notExecuted: '미실행' } as const;
function resultClass(operation: BulkOperation) {
  const { result } = operation;
  if (!result) return operation.uncertain ? 'outcome-resultUnknown' : 'outcome-failed';
  if (operation.needsReconnect || result.mutationBlocked || result.items.some(item => ['resultUnknown', 'notExecuted'].includes(item.outcome) || item.result?.mutationBlocked || item.result?.reconciliation === 'failed')) return 'outcome-resultUnknown';
  if (result.items.some(item => item.outcome === 'failed')) return 'outcome-failed';
  return result.items.some(item => item.outcome === 'succeeded') ? '' : 'outcome-neutral';
}
export function BulkResult({ operation }: { operation: BulkOperation }) {
  const { result } = operation;
  return <section className={`bulk-result operation-result ${resultClass(operation)}`} aria-label="최근 일괄 작업 결과">
    <h3>{!result && <AlertTriangle size={16} aria-hidden="true" />}{actionLabels[operation.action]} · 일괄 작업 {result ? '결과' : operation.uncertain ? '결과 불명' : '요청 거절'}</h3>
    <p>{operation.containers.length}개 선택</p><ConnectionFacts target={operation} />
    {result ? <><p role="status" className="bulk-summary">{Object.entries(outcomeLabels).map(([outcome, label]) => <span key={outcome}>{label} {result.items.filter(item => item.outcome === outcome).length}개</span>)}</p><details className="technical-details" open><summary>항목별 결과 · {result.items.length}개</summary><ul className="bulk-result-items">{result.items.map(item => <li key={item.handle}><div><strong>{item.name}</strong><span className={`bulk-outcome bulk-outcome-${item.outcome}`}>{outcomeLabels[item.outcome]}</span></div><code title={item.fullId}>{item.fullId}</code><p>{item.message}</p>{item.outcome === 'resultUnknown' && <p>현재 상태 재조회는 원래 명령의 성공을 의미하지 않습니다. 자동 재시도하지 않았습니다.</p>}{item.result?.reconciliation === 'failed' && <p>대상 상태 재조회 실패. Reconnect가 필요합니다.</p>}{item.result?.reconciliation === 'succeeded' && <p>대상 상태 재조회 완료{item.result.observedState ? ` · ${stateLabels[item.result.observedState] ?? item.result.observedState}` : ''}. 원래 작업 결과는 유지됩니다.</p>}{item.error && <ErrorDetails error={item.error} />}{item.result && (item.result.command || item.result.stderr) && <details className="technical-details"><summary>실행 상세</summary>{item.result.command && <pre>{item.result.command}</pre>}{item.result.stderr && <pre>{item.result.stderr}</pre>}</details>}</li>)}</ul></details></> : <><p>{operation.error.message}</p><p>{operation.uncertain ? '일괄 응답을 확인하지 못해 개별 대상의 결과를 확정할 수 없습니다. 자동 재시도하지 않았습니다. 현재 목록의 상태를 성공 여부로 해석하지 마세요.' : '실행 전에 요청이 거절되어 이 요청의 조작은 실행되지 않았습니다.'}</p><ErrorDetails error={operation.error} /></>}
    {operation.needsReconnect ? <p>추가 작업이 차단되었습니다. Reconnect로 환경을 다시 검증하세요.</p> : !result && <p>Refresh 후 대상을 다시 선택하세요.</p>}
  </section>;
}
