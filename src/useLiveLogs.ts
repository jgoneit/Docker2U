import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type CoreError } from './api';
import { emptyLogState, LiveLogController, type LiveLogInput } from './liveLogController';
export type { LiveLogStatus } from './liveLogController';

export function useLiveLogs({ onError, ...input }: LiveLogInput & {
  onError?: (error: unknown, failure: CoreError, sessionId: string) => boolean | void;
}) {
  const [state, setState] = useState(emptyLogState);
  const controller = useRef<LiveLogController | null>(null);
  const onErrorRef = useRef(onError); onErrorRef.current = onError;
  const inputRef = useRef(input); inputRef.current = input;
  useEffect(() => {
    const current = new LiveLogController(api, setState, (...args) => onErrorRef.current?.(...args));
    controller.current = current;
    current.update(inputRef.current);
    return () => { controller.current = null; current.destroy(); };
  }, []);
  useEffect(() => controller.current?.update(input), [input.container, input.snapshot, input.enabled, input.invalidated, input.restartVersion, input.replaceVersion]);
  const loadLogs = useCallback(() => controller.current?.reload(), []);
  const clearLogs = useCallback(() => controller.current?.clear(), []);
  return { ...state, loadLogs, clearLogs };
}
