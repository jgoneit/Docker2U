import type { ReactNode } from 'react';
import { PreferencesProvider } from './preferences';
import { fireEvent, render as renderUI, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { BulkMutationItem, Container, MutationResult } from './api';
import { BulkResult } from './bulk';
import type { BulkOperation } from './bulk';

function render(ui: ReactNode) { return renderUI(<PreferencesProvider initialPreferences={{ theme: 'dark', language: 'ko' }}>{ui}</PreferencesProvider>); }

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
    action: 'start', contextName: 'desktop-linux', endpoint: 'unix:///fixed', engineId: 'engine-1', containers, needsReconnect: false,
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
    expect(within(report).queryByText(/재연결/)).not.toBeInTheDocument();
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
    if (operation.needsReconnect) expect(within(report).getByText('이 작업 뒤 연결 재확인이 필요해졌습니다. 재연결해도 이 작업 결과는 바뀌지 않습니다.')).toBeVisible();
    else expect(within(report).queryByText('이 작업 뒤 연결 재확인이 필요해졌습니다. 재연결해도 이 작업 결과는 바뀌지 않습니다.')).not.toBeInTheDocument();
  });

  it('keeps a reconciled unknown result visibly uncertain without requiring 재연결', () => {
    const report = renderResult(resultOperation(['resultUnknown']));
    expect(report).toHaveClass('outcome-resultUnknown');
    expect(within(report).getByText('결과 불명 1개')).toBeVisible();
    fireEvent.click(within(report).getByText('항목별 결과 · 1개'));
    expect(within(report).getByText(/현재 상태 재조회는 원래 명령의 성공을 의미하지 않습니다. 자동 재시도하지 않았습니다./)).toBeVisible();
    expect(within(report).getByText(/대상 상태 재조회 완료 · 실행 중/)).toBeVisible();
    expect(within(report).queryByText(/재연결/)).not.toBeInTheDocument();
  });

  it.each([
    { code: 'StaleHandle', uncertain: false, needsReconnect: false, tone: 'outcome-failed' },
    { code: 'NeedsValidation', uncertain: false, needsReconnect: true, tone: 'outcome-failed' },
    { code: 'IPC_FAILURE', uncertain: true, needsReconnect: true, tone: 'outcome-resultUnknown' },
  ])('separates $code error tone from its required recovery action', ({ code, uncertain, needsReconnect, tone }) => {
    const report = renderResult({ action: 'start', contextName: 'desktop-linux', endpoint: 'unix:///fixed', engineId: 'engine-1', containers: [container], error: { code, message: '요청 응답 확인' }, uncertain, needsReconnect });
    const content = within(report);
    expect(report).toHaveClass(tone);
    expect(report).not.toHaveClass(uncertain ? 'outcome-failed' : 'outcome-resultUnknown');
    expect(content.getByRole('heading', { name: uncertain ? '시작 · 일괄 작업 결과 불명' : '시작 · 일괄 작업 요청 거절' })).toBeVisible();
    expect(content.queryByText(/성공 \d+개/)).not.toBeInTheDocument();
    if (needsReconnect) {
      expect(content.getByText('이 작업 뒤 연결 재확인이 필요해졌습니다. 재연결해도 이 작업 결과는 바뀌지 않습니다.')).toBeVisible();
      expect(content.queryByText('새로고침 후 대상을 다시 선택하세요.')).not.toBeInTheDocument();
    } else {
      fireEvent.click(content.getByRole('button', { name: '결과 펼치기' }));
      expect(content.getByText('새로고침 후 대상을 다시 선택하세요.')).toBeVisible();
      expect(content.queryByText(/재연결/)).not.toBeInTheDocument();
    }
  });
});


it('summarizes definitive bulk results and leaves uncertain results open', () => {
  const { rerender } = renderUI(<PreferencesProvider initialPreferences={{ theme: 'dark', language: 'ko' }}><BulkResult operation={resultOperation(['succeeded', 'failed'])} /></PreferencesProvider>);
  expect(screen.getByText('성공 1개')).toBeVisible();
  expect(screen.getByText('실패 1개')).toBeVisible();
  expect(screen.getByText('항목별 결과 · 2개')).not.toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '결과 펼치기' }));
  expect(screen.getByText('항목별 결과 · 2개')).toBeVisible();
  rerender(<PreferencesProvider initialPreferences={{ theme: 'dark', language: 'ko' }}><BulkResult operation={resultOperation(['resultUnknown'])} /></PreferencesProvider>);
  expect(screen.queryByRole('button', { name: '결과 펼치기' })).not.toBeInTheDocument();
  expect(screen.getByText(/결과가 불명확하거나 실행되지 않은 대상/)).toBeVisible();
});
