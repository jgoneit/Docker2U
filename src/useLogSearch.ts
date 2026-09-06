import { useCallback, useEffect, useRef, useState } from 'react';
import { emptyLogSearchState, LogSearchController, sameLogSearchInput, type LogSearchInput, type LogSearchState } from './logSearchController';

export function useLogSearch({ target, text, query }: LogSearchInput) {
  const controller = useRef<LogSearchController | null>(null);
  const [state, setState] = useState<LogSearchState | null>(null);
  useEffect(() => {
    const instance = new LogSearchController(setState);
    controller.current = instance;
    return () => { instance.dispose(); controller.current = null; };
  }, []);
  useEffect(() => { controller.current?.update({ target, text, query }); }, [target, text, query]);
  const move = useCallback((direction: 1 | -1) => controller.current?.move(direction), []);
  const input = { target, text, query };
  // A changed input must never paint the previous query's count or highlight,
  // even in the render before its effect starts the replacement search.
  const current = state && sameLogSearchInput(state.input, input) ? state : emptyLogSearchState(input);
  return { status: current.status, total: current.total, activeIndex: current.activeIndex, activeStart: current.activeStart, activeLength: current.activeLength, move };
}
