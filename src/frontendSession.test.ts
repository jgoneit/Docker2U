import { describe, expect, it } from 'vitest';
import { coreError } from './api';
import { frontendError } from './frontendErrors';
import { bulkResultIssue, errorIssue, resultIssue, retainSessionIssue } from './frontendSession';

describe('frontend session issue provenance', () => {
  it.each([
    [frontendError('staleLogs'), 'frontendError', 'STALE_RESPONSE'],
    [{ code: 'STALE_RESPONSE', message: 'native message', origin: 'frontend' }, 'nativeError', 'STALE_RESPONSE'],
    [new Error('preserve raw exception'), 'exception', null],
    [null, 'frontendError', 'IPC_FAILURE'],
  ] as const)('records source without inferring native provenance from a code', (original, origin, code) => {
    const error = coreError(original);
    const issue = errorIssue('logs', original, error, false);
    expect(issue).toMatchObject({ stage: 'logs', origin, code, scope: 'current', requiresReconnect: false });
    expect(Number.isNaN(Date.parse(issue.occurredAt))).toBe(false);
    expect(issue).not.toHaveProperty('message');
    expect(error.message).toBe(original instanceof Error ? original.message : error.message);
  });

  it('keeps a reconnect cause when a later ordinary request fails', () => {
    const blocked = errorIssue('logs', null, frontendError('ipcFailure'), true);
    const ordinary = errorIssue('list', null, frontendError('staleInventory'), false);
    expect(retainSessionIssue(blocked, ordinary)).toBe(blocked);
    expect(retainSessionIssue(ordinary, blocked)).toBe(blocked);
    expect(retainSessionIssue(null, ordinary)).toBe(ordinary);
  });

  it('does not invent an error code for a mutation result or aggregate block', () => {
    const result = { outcome: 'resultUnknown' as const, reconciliation: 'failed' as const, mutationBlocked: true, message: 'private native output', command: 'private command', stderr: 'private stderr' };
    expect(resultIssue('singleAction', true, result)).toMatchObject({ code: null, origin: 'nativeResult', outcome: 'resultUnknown', reconciliation: 'failed' });
    const aggregate = { sessionId: 'private', generation: 1, action: 'start' as const, mutationBlocked: true, items: [] };
    expect(bulkResultIssue(aggregate, true)).toMatchObject({ code: null, origin: 'nativeResult', stage: 'bulkAction' });
    expect(bulkResultIssue({ ...aggregate, items: [{ handle: 'private', fullId: 'private', name: 'private', outcome: 'resultUnknown', message: 'private' }] }, true)).toMatchObject({ code: null, origin: 'nativeResult', outcome: 'resultUnknown' });
    expect(bulkResultIssue({ ...aggregate, mutationBlocked: false }, false)).toBeNull();
  });

  it('selects the batch-stopping error after an earlier StateChanged skip', () => {
    const identity = { handle: 'private', fullId: 'private', name: 'private', message: 'private' };
    const result = { sessionId: 'private', generation: 1, action: 'stop' as const, mutationBlocked: true, items: [
      { ...identity, outcome: 'skipped' as const, error: { code: 'StateChanged', message: 'no longer running' } },
      { ...identity, outcome: 'notExecuted' as const, error: { code: 'EnvironmentChanged', message: 'engine changed' } },
    ] };
    expect(bulkResultIssue(result, true)).toMatchObject({ stage: 'bulkAction', origin: 'nativeError', code: 'EnvironmentChanged', requiresReconnect: true });
  });
});
