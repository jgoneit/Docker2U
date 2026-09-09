import { useCallback, useEffect, useRef, useState } from 'react';
import { operationFeedbackTone, type CompletedOperation, type OperationCompletion, type PendingOperation } from './operationFeedbackModel';

export interface OperationFeedbackState {
  pending: (PendingOperation & { id: number }) | null;
  completed: OperationCompletion | null;
  messageVisible: boolean;
  detailsOpen: boolean;
  hideAt: number | null;
}
export const OPERATION_SUCCESS_DURATION = 5_000;

/** Presentation only: dismissing or expiring a message never changes Core/session gates. */
export function useOperationFeedback() {
  const sequence = useRef(0);
  const active = useRef<(PendingOperation & { id: number }) | null>(null);
  const [state, setState] = useState<OperationFeedbackState>({ pending: null, completed: null, messageVisible: false, detailsOpen: false, hideAt: null });
  const begin = useCallback((target: PendingOperation) => {
    const pending = { ...target, id: ++sequence.current };
    active.current = pending;
    setState(previous => ({ ...previous, pending, messageVisible: false, detailsOpen: false, hideAt: null }));
    return pending.id;
  }, []);
  // Call after the final inventory refresh settles, including a failed refresh.
  const finish = useCallback((id: number, result: CompletedOperation, refreshed: boolean) => {
    const pending = active.current;
    if (!pending || pending.id !== id) return;
    active.current = null;
    const now = Date.now();
    const completed: OperationCompletion = { id, result, sessionId: pending.sessionId, completedAt: new Date(now).toISOString(), refreshed };
    const hideAt = operationFeedbackTone(completed) === 'success' ? now + OPERATION_SUCCESS_DURATION : null;
    setState({ pending: null, completed, messageVisible: true, detailsOpen: false, hideAt });
  }, []);
  const cancel = useCallback((id: number) => {
    if (active.current?.id !== id) return;
    active.current = null;
    setState(previous => previous.pending?.id === id ? { ...previous, pending: null } : previous);
  }, []);
  const dismissMessage = useCallback(() => setState(previous => ({ ...previous, messageVisible: false, hideAt: null })), []);
  const openDetails = useCallback(() => setState(previous => previous.completed ? { ...previous, detailsOpen: true } : previous), []);
  const closeDetails = useCallback(() => setState(previous => ({ ...previous, detailsOpen: false })), []);
  useEffect(() => {
    const { completed, hideAt, messageVisible } = state;
    if (!completed || !messageVisible || hideAt === null) return;
    const id = completed.id;
    const timer = setTimeout(() => setState(previous => previous.completed?.id === id && previous.hideAt === hideAt
      ? { ...previous, messageVisible: false, hideAt: null } : previous), Math.max(0, hideAt - Date.now()));
    return () => clearTimeout(timer);
  }, [state.completed, state.hideAt, state.messageVisible]);
  return { ...state, begin, finish, cancel, dismissMessage, openDetails, closeDetails };
}

export type OperationFeedbackModel = ReturnType<typeof useOperationFeedback>;
