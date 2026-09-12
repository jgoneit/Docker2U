import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';

export const DEFAULT_INVENTORY_WIDTH = 320;
const MIN_INVENTORY_WIDTH = 280;
const MAX_INVENTORY_WIDTH = 440;
const MIN_DETAIL_WIDTH = 600;
const SEPARATOR_WIDTH = 10;
const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));

/** Presentation-only state: resizing never changes the selected target or its log stream. */
export function usePaneResize() {
  const workspaceRef = useRef<HTMLElement>(null);
  const [workspaceWidth, setWorkspaceWidth] = useState(1024);
  const [preferredWidth, setPreferredWidth] = useState(DEFAULT_INVENTORY_WIDTH);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ pointerId: number; x: number; width: number; target: HTMLButtonElement } | null>(null);
  const maximum = Math.min(MAX_INVENTORY_WIDTH, Math.max(MIN_INVENTORY_WIDTH, workspaceWidth - MIN_DETAIL_WIDTH - SEPARATOR_WIDTH));
  const minimum = MIN_INVENTORY_WIDTH;
  const width = clamp(preferredWidth, minimum, maximum);

  useLayoutEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const measure = () => {
      const next = workspace.getBoundingClientRect().width;
      if (next > 0) setWorkspaceWidth(next);
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
    if (cancelled) setPreferredWidth(current.width);
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
    workspaceRef, width, dragging,
    workspaceStyle: { gridTemplateColumns: `${width}px ${SEPARATOR_WIDTH}px minmax(${MIN_DETAIL_WIDTH}px, 1fr)` },
    separatorProps: {
      'aria-orientation': 'vertical' as const,
      'aria-valuemin': minimum, 'aria-valuemax': maximum, 'aria-valuenow': width,
      onPointerDown(event: PointerEvent<HTMLButtonElement>) {
        if (event.button !== 0 || drag.current) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { pointerId: event.pointerId, x: event.clientX, width, target: event.currentTarget };
        setDragging(true);
      },
      onPointerMove(event: PointerEvent<HTMLButtonElement>) {
        const current = drag.current;
        if (current && current.pointerId === event.pointerId) setPreferredWidth(clamp(current.width + event.clientX - current.x, minimum, maximum));
      },
      onPointerUp(event: PointerEvent<HTMLButtonElement>) { if (drag.current?.pointerId === event.pointerId) finish(); },
      onPointerCancel(event: PointerEvent<HTMLButtonElement>) { if (drag.current?.pointerId === event.pointerId) finish(true); },
      onLostPointerCapture(event: PointerEvent<HTMLButtonElement>) { if (drag.current?.pointerId === event.pointerId) finish(); },
      onDoubleClick() { setPreferredWidth(DEFAULT_INVENTORY_WIDTH); },
      onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
        const next = event.key === 'ArrowRight' ? width + 20 : event.key === 'ArrowLeft' ? width - 20
          : event.key === 'Home' ? minimum : event.key === 'End' ? maximum : null;
        if (next === null) return;
        event.preventDefault();
        setPreferredWidth(clamp(next, minimum, maximum));
      },
    },
  };
}
