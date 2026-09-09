import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BulkMutationItem, Container } from './api';
import type { Operation } from './components';
import { OperationFeedback } from './OperationFeedback';
import { operationFeedbackText, operationFeedbackTone, type CompletedOperation, type OperationCompletion } from './operationFeedbackModel';
import { useOperationFeedback, type OperationFeedbackModel } from './useOperationFeedback';
import { PreferencesProvider, usePreferences } from './preferences';

const target = { contextName: 'context-a', endpoint: 'unix:///fixture.sock', engineId: 'engine-a' };
function single(outcome: Operation['outcome'] = 'succeeded', patch: Partial<Operation> = {}): CompletedOperation {
  return { kind: 'single', operation: { ...target, fullId: 'a'.repeat(64), name: 'api-1', action: 'start', outcome, reconciliation: 'succeeded', mutationBlocked: false, message: 'fixture', command: 'fixture', stderr: '', ...patch } };
}
function bulk(outcomes: BulkMutationItem['outcome'][]): CompletedOperation {
  const containers: Container[] = outcomes.map((_, index) => ({ handle: String(index), fullId: String(index).repeat(64), shortId: String(index).repeat(12), name: `container-${index}`, image: 'fixture', state: 'running', health: null, ports: [], composeProject: null, composeService: null, createdAt: '' }));
  return { kind: 'bulk', operation: { ...target, action: 'stop', containers, needsReconnect: false, result: { sessionId: 'session-a', generation: 1, action: 'stop', mutationBlocked: false, items: outcomes.map((outcome, index) => {
    const container = containers[index]!;
    return { handle: container.handle, fullId: container.fullId, name: container.name, outcome, message: 'fixture', result: ['succeeded', 'failed', 'resultUnknown'].includes(outcome) ? { outcome: outcome as Operation['outcome'], reconciliation: 'succeeded', mutationBlocked: false, message: '', command: '', stderr: '' } : null };
  }) } } };
}
function completion(result: CompletedOperation, refreshed = true): OperationCompletion {
  return { id: 1, sessionId: 'session-a', result, refreshed, completedAt: '2026-09-08T12:00:00Z' };
}
const begin = (model: OperationFeedbackModel) => model.begin({ kind: 'single', action: 'start', name: 'api-1', sessionId: 'session-a' });
const advance = (milliseconds: number) => act(() => vi.advanceTimersByTime(milliseconds));
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-08T12:00:00Z')); });
afterEach(() => vi.useRealTimers());

it('starts the five-second success lifetime only when the final refresh has settled', () => {
  const { result } = renderHook(useOperationFeedback);
  let id = 0;
  act(() => { id = begin(result.current); });
  advance(20_000);
  expect(result.current.pending?.id).toBe(id);
  expect(result.current.completed).toBeNull();
  act(() => result.current.finish(id, single(), true));
  const record = result.current.completed;
  expect(record).toMatchObject({ sessionId: 'session-a', completedAt: '2026-09-08T12:00:20.000Z', refreshed: true });
  expect(result.current.detailsOpen).toBe(false);
  advance(4_999);
  expect(result.current.messageVisible).toBe(true);
  advance(1);
  expect(result.current.messageVisible).toBe(false);
  expect(result.current.completed).toBe(record);
  act(() => result.current.openDetails());
  expect(result.current.detailsOpen).toBe(true);
});

it('does not let an older timer expire a newer success or a late completion replace its target', () => {
  const { result } = renderHook(useOperationFeedback);
  let first = 0, second = 0;
  act(() => { first = begin(result.current); result.current.finish(first, single(), true); });
  advance(4_000);
  act(() => { second = result.current.begin({ kind: 'single', action: 'stop', name: 'db-2', sessionId: 'session-b' }); });
  act(() => result.current.finish(first, single('resultUnknown'), false));
  expect(result.current.pending?.id).toBe(second);
  act(() => result.current.finish(second, single('succeeded', { name: 'db-2', action: 'stop' }), true));
  advance(1_000);
  expect(result.current.messageVisible).toBe(true);
  expect(result.current.completed?.sessionId).toBe('session-b');
  advance(4_000);
  expect(result.current.messageVisible).toBe(false);
});

it.each(['failed', 'resultUnknown'] as const)('keeps %s until dismissed and preserves the original safety facts and details', outcome => {
  const { result } = renderHook(useOperationFeedback);
  const payload = single(outcome, { mutationBlocked: true, reconciliation: 'failed' });
  Object.freeze(payload.operation);
  act(() => { const id = begin(result.current); result.current.finish(id, payload, false); });
  const record = result.current.completed;
  advance(60_000);
  expect(result.current.messageVisible).toBe(true);
  expect(result.current.detailsOpen).toBe(false);
  act(() => result.current.dismissMessage());
  expect(result.current.completed).toBe(record);
  expect(record?.result.operation).toMatchObject({ outcome, mutationBlocked: true, reconciliation: 'failed' });
  act(() => result.current.openDetails());
  expect(result.current.detailsOpen).toBe(true);
  act(() => result.current.closeDetails());
  expect(result.current.detailsOpen).toBe(false);
  expect(result.current.messageVisible).toBe(false);
});

it('keeps an unconfirmed inventory warning separate from a successful command result', () => {
  const { result } = renderHook(useOperationFeedback);
  act(() => { const id = begin(result.current); result.current.finish(id, single(), false); });
  advance(60_000);
  expect(result.current.messageVisible).toBe(true);
  expect(operationFeedbackText(result.current.completed!, 'ko').full).toBe('시작 · 성공 · api-1 · 목록 확인 실패');
  expect(operationFeedbackTone(result.current.completed!)).toBe('warning');
  expect(result.current.completed?.result.operation).toMatchObject({ outcome: 'succeeded', mutationBlocked: false });
});

it.each(['failed', 'resultUnknown', 'skipped', 'notExecuted'] as const)('does not auto-hide bulk results containing %s', outcome => {
  const { result } = renderHook(useOperationFeedback);
  act(() => { const id = result.current.begin({ kind: 'bulk', action: 'stop', count: 2, sessionId: 'session-a' }); result.current.finish(id, bulk(['succeeded', outcome]), true); });
  advance(60_000);
  expect(result.current.messageVisible).toBe(true);
  expect(operationFeedbackTone(result.current.completed!)).toBe(outcome === 'failed' ? 'danger' : 'warning');
});

it('counts each bulk category distinctly and auto-hides only all-success results', () => {
  const record = completion(bulk(['succeeded', 'failed', 'resultUnknown', 'skipped', 'notExecuted']));
  expect(operationFeedbackText(record, 'ko').outcome).toBe('성공 1 · 실패 1 · 결과 불명 1 · 제외 1 · 미실행 1');
  expect(operationFeedbackText(record, 'en').target).toBe('5 targets');
  expect(operationFeedbackTone(completion(bulk([])))).toBe('warning');
  const { result } = renderHook(useOperationFeedback);
  act(() => { const id = result.current.begin({ kind: 'bulk', action: 'stop', count: 2, sessionId: 'session-a' }); result.current.finish(id, bulk(['succeeded', 'succeeded']), true); });
  advance(5_000);
  expect(result.current.messageVisible).toBe(false);
  expect(result.current.completed?.result.kind).toBe('bulk');
});

it('cancels only the current pending attempt while retaining the previous completed record', () => {
  const { result } = renderHook(useOperationFeedback);
  let first = 0, second = 0;
  act(() => { first = begin(result.current); result.current.finish(first, single(), true); });
  const record = result.current.completed;
  act(() => { second = begin(result.current); });
  act(() => result.current.cancel(first));
  expect(result.current.pending?.id).toBe(second);
  act(() => result.current.cancel(second));
  expect(result.current.pending).toBeNull();
  expect(result.current.completed).toBe(record);
  act(() => result.current.finish(second, single('failed'), true));
  expect(result.current.completed).toBe(record);
});

let model: OperationFeedbackModel;
function Harness() {
  model = useOperationFeedback();
  const preferences = usePreferences();
  return <><button onClick={() => preferences.setLanguage('en')}>English</button><button onClick={() => preferences.setTheme('light')}>Light</button><OperationFeedback model={model} detailsId="result-details" /></>;
}
const mountFeedback = () => render(<PreferencesProvider initialPreferences={{ language: 'ko', theme: 'dark' }}><Harness /></PreferencesProvider>);

it('preserves the original success deadline across language/theme changes and retains a named result button', () => {
  mountFeedback();
  act(() => { const id = begin(model); model.finish(id, single(), true); });
  const deadline = model.hideAt;
  advance(2_000);
  fireEvent.click(screen.getByText('English'));
  fireEvent.click(screen.getByText('Light'));
  expect(screen.getByRole('status', { name: 'Operation notification' })).toHaveTextContent('Start · Succeeded');
  expect(model.hideAt).toBe(deadline);
  expect(document.documentElement.dataset.theme).toBe('light');
  const trigger = screen.getByRole('button', { name: 'Show latest operation details' });
  trigger.focus();
  advance(3_000);
  expect(screen.getByRole('status', { name: 'Operation notification' })).toBeEmptyDOMElement();
  expect(trigger).toBe(screen.getByRole('button', { name: 'Show latest operation details' }));
  expect(trigger).toHaveFocus();
  fireEvent.click(trigger);
  expect(trigger).toHaveAttribute('aria-expanded', 'true');
  expect(trigger).toHaveAttribute('aria-controls', 'result-details');
});

it('restores focus to the retained result button when a warning is dismissed', () => {
  mountFeedback();
  act(() => { const id = begin(model); model.finish(id, single('resultUnknown'), true); });
  const dismiss = screen.getByRole('button', { name: '작업 알림 닫기' });
  dismiss.focus();
  fireEvent.click(dismiss);
  expect(screen.getByRole('button', { name: '최근 작업 결과 상세 보기' })).toHaveFocus();
  expect(screen.queryByRole('button', { name: '작업 알림 닫기' })).not.toBeInTheDocument();
  expect(model.completed?.result.operation).toMatchObject({ outcome: 'resultUnknown' });
  expect(model.detailsOpen).toBe(false);
});
