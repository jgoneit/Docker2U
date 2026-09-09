import type { Action, BulkMutationItem } from './api';
import type { Operation } from './components';
import type { BulkOperation } from './bulk';
import { translate, type Language, type Messages } from './i18n';
import { componentMessages } from './messages/components';

export type CompletedOperation = { kind: 'single'; operation: Operation } | { kind: 'bulk'; operation: BulkOperation };
export type PendingOperation = { sessionId: string; action: Action } & (
  { kind: 'single'; name: string } | { kind: 'bulk'; count: number }
);
export interface OperationCompletion {
  id: number;
  result: CompletedOperation;
  sessionId: string;
  completedAt: string;
  /** Inventory confirmation is separate from the command's reported outcome. */
  refreshed: boolean;
}
export type OperationFeedbackTone = 'success' | 'danger' | 'warning';

export const operationFeedbackMessages = {
  region: { ko: '작업 알림', en: 'Operation notification' },
  pending: { ko: '{action} · 처리 및 상태 확인 중…', en: '{action} · Working and checking state…' },
  count: { ko: '{count}개', en: '{count} targets' },
  skipped: { ko: '제외', en: 'Skipped' },
  notExecuted: { ko: '미실행', en: 'Not executed' },
  rejected: { ko: '요청 거절', en: 'Request rejected' },
  noResults: { ko: '대상 결과 없음', en: 'No target results' },
  checkFailed: { ko: '상태 재조회 실패', en: 'State check failed' },
  reconnect: { ko: '작업 후 연결 재확인 필요', en: 'Connection recheck needed after action' },
  refreshFailed: { ko: '목록 확인 실패', en: 'List confirmation failed' },
  details: { ko: '상세', en: 'Details' },
  recent: { ko: '최근 작업', en: 'Recent operation' },
  openDetails: { ko: '최근 작업 결과 상세 보기', en: 'Show latest operation details' },
  dismiss: { ko: '작업 알림 닫기', en: 'Dismiss operation notification' },
  confirmedAt: { ko: '결과 확인 {time}', en: 'Result received {time}' },
} satisfies Messages;

export const operationOutcomes = ['succeeded', 'failed', 'resultUnknown', 'skipped', 'notExecuted'] as const;

function needsStateCheck(completed: CompletedOperation) {
  return completed.kind === 'single' ? completed.operation.reconciliation === 'failed'
    : !!completed.operation.result?.items.some(item => item.result?.reconciliation === 'failed');
}
function needsConnectionCheck(completed: CompletedOperation) {
  return completed.kind === 'single' ? completed.operation.mutationBlocked
    : completed.operation.needsReconnect || !!completed.operation.result?.mutationBlocked
      || !!completed.operation.result?.items.some(item => item.result?.mutationBlocked);
}

export function operationFeedbackTone(completion: OperationCompletion): OperationFeedbackTone {
  const { result, refreshed } = completion;
  if (!refreshed || needsStateCheck(result) || needsConnectionCheck(result)) return 'warning';
  if (result.kind === 'single') return result.operation.outcome === 'succeeded' ? 'success'
    : result.operation.outcome === 'failed' ? 'danger' : 'warning';
  const operation = result.operation;
  if (!operation.result) return operation.uncertain ? 'warning' : 'danger';
  const items = operation.result.items;
  if (!items.length || items.some(item => ['resultUnknown', 'skipped', 'notExecuted'].includes(item.outcome))) return 'warning';
  if (items.some(item => item.outcome === 'failed')) return 'danger';
  return 'success';
}

function outcomeLabel(outcome: BulkMutationItem['outcome'], language: Language) {
  return outcome === 'skipped' || outcome === 'notExecuted' ? translate(operationFeedbackMessages, language, outcome)
    : translate(componentMessages, language, outcome);
}

/** Strings are derived when rendered, so preference changes never replace stored results. */
export function operationFeedbackText(completion: OperationCompletion, language: Language) {
  const { result } = completion;
  const operation = result.operation;
  const action = translate(componentMessages, language, operation.action);
  let outcome: string;
  let target: string;
  if (result.kind === 'single') {
    outcome = outcomeLabel(result.operation.outcome, language);
    target = result.operation.name;
  } else {
    target = translate(operationFeedbackMessages, language, 'count', { count: result.operation.containers.length });
    const bulk = result.operation;
    outcome = bulk.result ? operationOutcomes.flatMap(value => {
      const count = bulk.result!.items.filter(item => item.outcome === value).length;
      return count ? [`${outcomeLabel(value, language)} ${count}`] : [];
    }).join(' · ') || translate(operationFeedbackMessages, language, 'noResults')
      : bulk.uncertain ? outcomeLabel('resultUnknown', language) : translate(operationFeedbackMessages, language, 'rejected');
  }
  const qualifier = needsStateCheck(result) ? translate(operationFeedbackMessages, language, 'checkFailed')
    : needsConnectionCheck(result) ? translate(operationFeedbackMessages, language, 'reconnect')
      : !completion.refreshed ? translate(operationFeedbackMessages, language, 'refreshFailed') : '';
  return { action, outcome, target, qualifier, full: [action, outcome, target, qualifier].filter(Boolean).join(' · ') };
}
