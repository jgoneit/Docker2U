import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { BulkMutationItem, Container, MutationResult } from './api';
import { BulkResult } from './bulk';
import type { BulkOperation } from './bulk';

const container: Container = {
  handle: 'handle-1', fullId: 'a'.repeat(64), shortId: 'a'.repeat(12), name: 'worker',
  image: 'worker:1', state: 'exited', health: null, ports: [], createdAt: '2026-09-05T03:00:00Z',
};
const mutation: MutationResult = {
  outcome: 'succeeded', message: '명령이 완료되었습니다.', command: 'docker --host unix:///fixed container start target',
  stderr: '', reconciliation: 'succeeded', mutationBlocked: false, observedState: 'running',
};
function resultOperation(outcomes: BulkMutationItem['outcome'][]): BulkOperation & { result: NonNullable<BulkOperation['result']> } {
  const containers = outcomes.map((_, index) => ({ ...container, handle: `handle-${index}`, fullId: String(index + 1).repeat(64), name: `worker-${index}` }));
  return {
    action: 'start', profile: 'colima-docker2u', containers, needsReconnect: false,
    result: {
      sessionId: 'session-1', generation: 1, action: 'start', mutationBlocked: false,
      items: outcomes.map((outcome, index) => ({
        handle: containers[index]!.handle, fullId: containers[index]!.fullId, name: containers[index]!.name,
        outcome, message: `${outcome} 항목`,
        result: outcome === 'skipped' || outcome === 'notExecuted' ? null : { ...mutation, outcome },
      })),
    },
  };
}
function renderResult(operation: BulkOperation) {
  render(<BulkResult operation={operation} />);
  return screen.getByRole('region', { name: '최근 일괄 작업 결과' });
}

describe('bulk result outcome presentation', () => {
  it.each([
    { name: 'known failure among successes', outcomes: ['succeeded', 'failed'], tone: 'outcome-failed' },
    { name: 'only known failures', outcomes: ['failed', 'failed'], tone: 'outcome-failed' },
    { name: 'unknown result after a known failure', outcomes: ['failed', 'resultUnknown'], tone: 'outcome-resultUnknown' },
    { name: 'unexecuted items after a success', outcomes: ['succeeded', 'notExecuted'], tone: 'outcome-resultUnknown' },
    { name: 'only skipped items', outcomes: ['skipped', 'skipped'], tone: 'outcome-neutral' },
    { name: 'successes with skipped items', outcomes: ['succeeded', 'skipped'], tone: '' },
    { name: 'only successful items', outcomes: ['succeeded', 'succeeded'], tone: '' },
  ] satisfies { name: string; outcomes: BulkMutationItem['outcome'][]; tone: string }[])('uses the correct tone for $name without an aggregate block', ({ outcomes, tone }) => {
    const operation = resultOperation(outcomes);
    const report = renderResult(operation);
    expect(operation.result.mutationBlocked).toBe(false);
    expect(operation.needsReconnect).toBe(false);
    if (tone) expect(report).toHaveClass(tone);
    for (const alternative of ['outcome-failed', 'outcome-resultUnknown', 'outcome-neutral'].filter(value => value !== tone)) expect(report).not.toHaveClass(alternative);
    expect(within(report).queryByText(/Reconnect/)).not.toBeInTheDocument();
  });

  it.each(['reconciliation', 'itemBlock', 'aggregateBlock', 'existingBlock'] as const)('gives %s warning precedence over a known item failure', source => {
    const operation = resultOperation(['failed', 'succeeded']);
    if (source === 'reconciliation') operation.result.items[1]!.result!.reconciliation = 'failed';
    if (source === 'itemBlock') operation.result.items[1]!.result!.mutationBlocked = true;
    if (source === 'aggregateBlock') operation.result.mutationBlocked = true;
    operation.needsReconnect = source === 'existingBlock';
    const report = renderResult(operation);
    expect(report).toHaveClass('outcome-resultUnknown');
    expect(report).not.toHaveClass('outcome-failed');
    expect(within(report).getByText('실패 1개')).toBeVisible();
    if (operation.needsReconnect) expect(within(report).getByText('추가 작업이 차단되었습니다. Reconnect로 환경을 다시 검증하세요.')).toBeVisible();
    else expect(within(report).queryByText('추가 작업이 차단되었습니다. Reconnect로 환경을 다시 검증하세요.')).not.toBeInTheDocument();
  });

  it('keeps a reconciled unknown result visibly uncertain without requiring Reconnect', () => {
    const report = renderResult(resultOperation(['resultUnknown']));
    expect(report).toHaveClass('outcome-resultUnknown');
    expect(within(report).getByText('결과 불명 1개')).toBeVisible();
    expect(within(report).getByText(/현재 상태 재조회는 원래 명령의 성공을 의미하지 않습니다. 자동 재시도하지 않았습니다./)).toBeVisible();
    expect(within(report).getByText(/대상 상태 재조회 완료 · Running/)).toBeVisible();
    expect(within(report).queryByText(/Reconnect/)).not.toBeInTheDocument();
  });

  it.each([
    { code: 'StaleHandle', uncertain: false, needsReconnect: false, tone: 'outcome-failed' },
    { code: 'NeedsValidation', uncertain: false, needsReconnect: true, tone: 'outcome-failed' },
    { code: 'IPC_FAILURE', uncertain: true, needsReconnect: true, tone: 'outcome-resultUnknown' },
  ])('separates $code error tone from its required recovery action', ({ code, uncertain, needsReconnect, tone }) => {
    const report = renderResult({ action: 'start', profile: 'colima-docker2u', containers: [container], error: { code, message: '요청 응답 확인' }, uncertain, needsReconnect });
    const content = within(report);
    expect(report).toHaveClass(tone);
    expect(report).not.toHaveClass(uncertain ? 'outcome-failed' : 'outcome-resultUnknown');
    expect(content.getByRole('heading', { name: uncertain ? 'Start · 일괄 작업 결과 불명' : 'Start · 일괄 작업 요청 거절' })).toBeVisible();
    expect(content.queryByText(/성공 \d+개/)).not.toBeInTheDocument();
    if (needsReconnect) {
      expect(content.getByText('추가 작업이 차단되었습니다. Reconnect로 환경을 다시 검증하세요.')).toBeVisible();
      expect(content.queryByText('Refresh 후 대상을 다시 선택하세요.')).not.toBeInTheDocument();
    } else {
      expect(content.getByText('Refresh 후 대상을 다시 선택하세요.')).toBeVisible();
      expect(content.queryByText(/Reconnect/)).not.toBeInTheDocument();
    }
  });
});
