import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { usePaneResize } from './usePaneResize';
let measure: () => void;
let availableWidth = 1280;
function Fixture() {
  const pane = usePaneResize();
  return <main ref={pane.workspaceRef} style={pane.workspaceStyle}>
    <button role="separator" aria-label="Resize" {...pane.separatorProps} />
    <textarea aria-label="Retained content" defaultValue="selected log" />
  </main>;
}
beforeEach(() => {
  availableWidth = 1280;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ width: availableWidth }) as DOMRect);
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { measure = callback; } observe() {} disconnect() {} });
  vi.stubGlobal('PointerEvent', MouseEvent);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('resizes the left navigation with horizontal keys and resets without replacing content', () => {
  render(<Fixture />); const separator = screen.getByRole('separator'); const content = screen.getByRole('textbox');
  expect(separator).toHaveAttribute('aria-orientation', 'vertical');
  expect(separator).toHaveAttribute('aria-valuenow', '320');
  fireEvent.keyDown(separator, { key: 'ArrowRight' }); expect(separator).toHaveAttribute('aria-valuenow', '340');
  fireEvent.keyDown(separator, { key: 'Home' }); expect(separator).toHaveAttribute('aria-valuenow', '280');
  fireEvent.keyDown(separator, { key: 'ArrowLeft' }); expect(separator).toHaveAttribute('aria-valuenow', '280');
  fireEvent.keyDown(separator, { key: 'End' }); expect(separator).toHaveAttribute('aria-valuenow', '440');
  fireEvent.keyDown(separator, { key: 'ArrowDown' }); expect(separator).toHaveAttribute('aria-valuenow', '440');
  fireEvent.doubleClick(separator); expect(separator).toHaveAttribute('aria-valuenow', '320');
  expect(screen.getByRole('textbox')).toBe(content);
  expect(screen.getByRole('main')).toHaveStyle({ gridTemplateColumns: '320px 10px minmax(600px, 1fr)' });
});
it('keeps 600px for details and restores the preferred navigation width when space returns', () => {
  render(<Fixture />); const separator = screen.getByRole('separator');
  fireEvent.keyDown(separator, { key: 'End' });
  availableWidth = 1024; act(() => measure()); expect(separator).toHaveAttribute('aria-valuenow', '414');
  availableWidth = 920; act(() => measure()); expect(separator).toHaveAttribute('aria-valuenow', '310');
  availableWidth = 760; act(() => measure()); expect(separator).toHaveAttribute('aria-valuenow', '280');
  availableWidth = 1280; act(() => measure()); expect(separator).toHaveAttribute('aria-valuenow', '440');
});
it('drags horizontally with capture and cancels cleanly when focus leaves the app', () => {
  render(<Fixture />); const separator = screen.getByRole('separator');
  const capture = vi.fn(); const release = vi.fn();
  Object.assign(separator, { setPointerCapture: capture, hasPointerCapture: () => true, releasePointerCapture: release });
  fireEvent.pointerDown(separator, { button: 0, clientX: 320 });
  fireEvent.pointerMove(separator, { clientX: 400 }); expect(separator).toHaveAttribute('aria-valuenow', '400');
  fireEvent(window, new Event('blur')); expect(separator).toHaveAttribute('aria-valuenow', '320');
  expect(capture).toHaveBeenCalledOnce(); expect(release).toHaveBeenCalledOnce();
  fireEvent.pointerMove(separator, { clientX: 0 }); expect(separator).toHaveAttribute('aria-valuenow', '320');
  fireEvent.pointerDown(separator, { button: 0, clientX: 320 }); fireEvent.pointerMove(separator, { clientX: 900 });
  fireEvent.pointerUp(separator); expect(separator).toHaveAttribute('aria-valuenow', '440');
});
