import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';

export const DEFAULT_DETAIL_HEIGHT = 300;
const MIN_DETAIL_HEIGHT = 220;
const MIN_INVENTORY_HEIGHT = 200;
const SEPARATOR_HEIGHT = 10;
const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));

/** Presentation-only state: resizing never changes the selected container or its log stream. */
export function usePaneResize() {
  const workspaceRef = useRef<HTMLElement>(null);
  const [workspaceHeight, setWorkspaceHeight] = useState(650);
  const [preferredHeight, setPreferredHeight] = useState(DEFAULT_DETAIL_HEIGHT);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ pointerId: number; y: number; height: number; target: HTMLButtonElement } | null>(null);
  const maximum = Math.max(0, workspaceHeight - MIN_INVENTORY_HEIGHT - SEPARATOR_HEIGHT);
  const minimum = Math.min(MIN_DETAIL_HEIGHT, maximum);
  const height = clamp(preferredHeight, minimum, maximum);

  useLayoutEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const measure = () => {
      const next = workspace.getBoundingClientRect().height;
      if (next > 0) setWorkspaceHeight(next);
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(workspace);
    window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); };
  }, []);

  function finish(cancelled = false) {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    if (cancelled) setPreferredHeight(current.height);
    setDragging(false);
    if (current.target.hasPointerCapture?.(current.pointerId)) current.target.releasePointerCapture(current.pointerId);
  }
  useEffect(() => {
    const cancel = () => finish(true);
    window.addEventListener('blur', cancel);
    return () => {
      window.removeEventListener('blur', cancel);
      const current = drag.current;
      drag.current = null;
      if (current?.target.hasPointerCapture?.(current.pointerId)) current.target.releasePointerCapture(current.pointerId);
    };
  }, []);

  return {
    workspaceRef, height, dragging,
    workspaceStyle: { gridTemplateRows: `minmax(0, 1fr) ${SEPARATOR_HEIGHT}px ${height}px` },
    separatorProps: {
      'aria-valuemin': minimum, 'aria-valuemax': maximum, 'aria-valuenow': height,
      onPointerDown(event: PointerEvent<HTMLButtonElement>) {
        if (event.button !== 0 || drag.current) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { pointerId: event.pointerId, y: event.clientY, height, target: event.currentTarget };
        setDragging(true);
      },
      onPointerMove(event: PointerEvent<HTMLButtonElement>) {
        const current = drag.current;
        if (current && current.pointerId === event.pointerId) setPreferredHeight(clamp(current.height + current.y - event.clientY, minimum, maximum));
      },
      onPointerUp(event: PointerEvent<HTMLButtonElement>) { if (drag.current?.pointerId === event.pointerId) finish(); },
      onPointerCancel(event: PointerEvent<HTMLButtonElement>) { if (drag.current?.pointerId === event.pointerId) finish(true); },
      onLostPointerCapture(event: PointerEvent<HTMLButtonElement>) { if (drag.current?.pointerId === event.pointerId) finish(); },
      onDoubleClick() { setPreferredHeight(DEFAULT_DETAIL_HEIGHT); },
      onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
        const next = event.key === 'ArrowUp' ? height + 20 : event.key === 'ArrowDown' ? height - 20
          : event.key === 'Home' ? minimum : event.key === 'End' ? maximum : null;
        if (next === null) return;
        event.preventDefault();
        setPreferredHeight(clamp(next, minimum, maximum));
      },
    },
  };
}
