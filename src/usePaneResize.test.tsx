import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { usePaneResize } from './usePaneResize';
let measure: () => void;
let availableHeight = 650;
function Fixture() {
  const pane = usePaneResize();
  return <main ref={pane.workspaceRef} style={pane.workspaceStyle}>
    <button role="separator" aria-label="Resize" {...pane.separatorProps} />
    <textarea aria-label="Retained content" defaultValue="selected log" />
  </main>;
}
beforeEach(() => {
  availableHeight = 650;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ height: availableHeight }) as DOMRect);
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { measure = callback; } observe() {} disconnect() {} });
  vi.stubGlobal('PointerEvent', MouseEvent);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('resizes by keyboard within bounds and resets without replacing content', () => {
  render(<Fixture />); const separator = screen.getByRole('separator'); const content = screen.getByRole('textbox');
  expect(separator).toHaveAttribute('aria-valuenow', '300');
  fireEvent.keyDown(separator, { key: 'ArrowUp' }); expect(separator).toHaveAttribute('aria-valuenow', '320');
  fireEvent.keyDown(separator, { key: 'Home' }); expect(separator).toHaveAttribute('aria-valuenow', '220');
  fireEvent.keyDown(separator, { key: 'ArrowDown' }); expect(separator).toHaveAttribute('aria-valuenow', '220');
  fireEvent.keyDown(separator, { key: 'End' }); expect(separator).toHaveAttribute('aria-valuenow', '440');
  fireEvent.doubleClick(separator); expect(separator).toHaveAttribute('aria-valuenow', '300');
  expect(screen.getByRole('textbox')).toBe(content);
});
it('clamps on window resize and restores the preferred height when space returns', () => {
  render(<Fixture />); const separator = screen.getByRole('separator');
  fireEvent.keyDown(separator, { key: 'End' });
  availableHeight = 470; act(() => measure()); expect(separator).toHaveAttribute('aria-valuenow', '260');
  availableHeight = 650; act(() => measure()); expect(separator).toHaveAttribute('aria-valuenow', '440');
});
it('drags using pointer capture and cancels cleanly when focus leaves the app', () => {
  render(<Fixture />); const separator = screen.getByRole('separator');
  const capture = vi.fn(); const release = vi.fn();
  Object.assign(separator, { setPointerCapture: capture, hasPointerCapture: () => true, releasePointerCapture: release });
  fireEvent.pointerDown(separator, { button: 0, clientY: 400 });
  fireEvent.pointerMove(separator, { clientY: 300 }); expect(separator).toHaveAttribute('aria-valuenow', '400');
  fireEvent(window, new Event('blur')); expect(separator).toHaveAttribute('aria-valuenow', '300');
  expect(capture).toHaveBeenCalledOnce(); expect(release).toHaveBeenCalledOnce();
  fireEvent.pointerMove(separator, { clientY: 0 }); expect(separator).toHaveAttribute('aria-valuenow', '300');
  fireEvent.pointerDown(separator, { button: 0, clientY: 400 }); fireEvent.pointerMove(separator, { clientY: 0 });
  fireEvent.pointerUp(separator); expect(separator).toHaveAttribute('aria-valuenow', '440');
});
