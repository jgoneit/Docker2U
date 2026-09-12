import type { BulkMutationResult, CoreError, MutationResult } from './api';
import { frontendErrorDescriptor } from './frontendErrors';

export type IssueStage = 'connect' | 'list' | 'logs' | 'stats' | 'details' | 'singleAction' | 'bulkAction';
export interface SessionIssue {
  stage: IssueStage;
  origin: 'frontendError' | 'nativeError' | 'exception' | 'nativeResult';
  code: string | null;
  occurredAt: string;
  requiresReconnect: boolean;
  scope: 'current' | 'previous';
  outcome?: MutationResult['outcome'];
  reconciliation?: MutationResult['reconciliation'];
}
export interface FrontendSession {
  currentStatus: 'checking' | 'reconnectRequired' | 'connected' | 'disconnected';
  effectiveMutationBlocked: boolean;
  reconnectRequired: boolean;
  inventoryStale: boolean | null;
  inventoryRefreshedAt: string | null;
  issue: SessionIssue | null;
}

/** Capture only accepted failures, after the caller's epoch/session checks. */
export function errorIssue(stage: IssueStage, original: unknown, error: CoreError, requiresReconnect: boolean): SessionIssue {
  const frontend = frontendErrorDescriptor(error);
  const exception = original instanceof Error;
  const code = exception && !frontend ? ('code' in original && typeof original.code === 'string' ? original.code : null) : error.code;
  return {
    stage, origin: frontend ? 'frontendError' : exception ? 'exception' : 'nativeError',
    code, occurredAt: new Date().toISOString(), requiresReconnect, scope: 'current',
  };
}
export function resultIssue(stage: IssueStage, requiresReconnect: boolean, result?: Pick<MutationResult, 'outcome'> & Partial<Pick<MutationResult, 'reconciliation'>>): SessionIssue {
  return {
    stage, origin: 'nativeResult', code: null, occurredAt: new Date().toISOString(), requiresReconnect, scope: 'current',
    ...(result ? { outcome: result.outcome } : {}),
    ...(result?.reconciliation ? { reconciliation: result.reconciliation } : {}),
  };
}
export function bulkResultIssue(result: BulkMutationResult, requiresReconnect: boolean): SessionIssue | null {
  const item = result.items.find(item => item.result?.mutationBlocked || item.result?.reconciliation === 'failed')
    ?? result.items.find(item => item.outcome === 'resultUnknown')
    // Core skips StateChanged and continues; a later error can be the actual batch stop.
    ?? result.items.find(item => item.error && item.error.code !== 'StateChanged')
    ?? result.items.find(item => item.error || item.outcome === 'failed');
  if (item?.error) return errorIssue('bulkAction', item.error, item.error, requiresReconnect);
  const detail = item?.result ?? (item?.outcome === 'resultUnknown' || item?.outcome === 'failed' ? { outcome: item.outcome } : undefined);
  if (item || requiresReconnect) return resultIssue('bulkAction', requiresReconnect, detail);
  return null;
}
/** Ordinary errors cannot hide the cause of an outstanding reconnect warning. */
export function retainSessionIssue(previous: SessionIssue | null, next: SessionIssue): SessionIssue {
  return previous?.requiresReconnect && !next.requiresReconnect ? previous : next;
}
/** Explicit export allowlist, including nested metadata: no raw output or opaque identities. */
export function sessionDiagnostics(value: FrontendSession): FrontendSession {
  const issue = value.issue;
  return {
    currentStatus: value.currentStatus, effectiveMutationBlocked: value.effectiveMutationBlocked,
    reconnectRequired: value.reconnectRequired, inventoryStale: value.inventoryStale,
    inventoryRefreshedAt: value.inventoryRefreshedAt,
    issue: issue ? {
      stage: issue.stage, origin: issue.origin, code: issue.code, occurredAt: issue.occurredAt,
      requiresReconnect: issue.requiresReconnect, scope: issue.scope,
      ...(issue.outcome ? { outcome: issue.outcome } : {}),
      ...(issue.reconciliation ? { reconciliation: issue.reconciliation } : {}),
    } : null,
  };
}

export const connectionInvalidatingErrors = new Set(['EnvironmentChanged', 'Disconnected', 'SocketMissing', 'PermissionDenied', 'Configuration', 'EndpointMismatch', 'RemoteEndpoint', 'UnsupportedObservationEndpoint']);
