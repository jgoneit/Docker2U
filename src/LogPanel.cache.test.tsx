import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Container, ContainerList } from './api';
import { LogPanel } from './LogPanel';
import type { LogSnapshot } from './logSnapshot';
import { PreferencesProvider } from './preferences';
import { createStandaloneLogViewCache, type StandaloneLogViewCache } from './standaloneLogViewCache';

const alpha: Container = { handle: 'alpha-1', fullId: 'a'.repeat(64), shortId: 'a'.repeat(12), composeProject: null, composeService: null, name: 'same-name', image: 'image', state: 'running', health: null, healthConfigured: null, ports: [], createdAt: '' };
const beta: Container = { ...alpha, handle: 'beta-1', fullId: 'b'.repeat(64), shortId: 'b'.repeat(12) };
const snapshot: ContainerList = { sessionId: 'session-1', generation: 1, containers: [alpha, beta], refreshedAt: '', stale: false };
function frame(container = alpha, text = 'historical marker\nold alpha text', sequence = 1): LogSnapshot {
  return { sessionId: snapshot.sessionId, generation: 1, handle: container.handle, fetchedAt: '2026-09-12T01:00:00Z', text, byteCount: text.length, truncated: false, command: '', stderr: '', source: 'live', streamId: `${container.fullId}-stream`, sequence, receivedBytes: text.length };
}
function panel(cache: StandaloneLogViewCache, container = alpha, logs: LogSnapshot | null = frame(container), currentSnapshot = snapshot, load = vi.fn(), clear = vi.fn(), language: 'ko' | 'en' = 'en') {
  return <PreferencesProvider initialPreferences={{ language, theme: 'dark' }}><LogPanel viewCache={cache} container={container} snapshot={currentSnapshot} logs={logs} logsError={null} loadingLogs={false} liveStatus={logs && (logs.sequence ?? -1) >= 0 ? 'following' : 'connecting'} refreshing={false} mutating={false} loadLogs={load} clearLogs={clear} copy={vi.fn()} expanded={false} onExpandedChange={vi.fn()} /></PreferencesProvider>;
}
const output = () => screen.getByLabelText('Recent log content');
function scroll(top: number) {
  Object.defineProperties(output(), { scrollHeight: { configurable: true, value: 2500 }, clientHeight: { configurable: true, value: 200 } });
  output().scrollTop = top; fireEvent.scroll(output());
}
function pauseAndSearch() {
  fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
  fireEvent.click(screen.getByRole('button', { name: 'Open log search' }));
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search logs' }), { target: { value: 'marker' } });
}
afterEach(() => vi.useRealTimers());

describe('standalone target view restoration', () => {
  it('restores frozen search, manual pause and fractional scroll across same-name targets and new follow frames', async () => {
    const cache = createStandaloneLogViewCache();
    const old = frame();
    const view = render(panel(cache, alpha, old));
    pauseAndSearch();
    await waitFor(() => expect(screen.getByText('1 / 1 matches')).toBeVisible());
    scroll(143.5);
    // App clears the transport before applying the target change.
    view.rerender(panel(cache, alpha, null));
    view.rerender(panel(cache, beta, old));
    expect(output()).not.toHaveTextContent('old alpha text');
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pause' })).toBeVisible();
    view.rerender(panel(cache, alpha, null));
    expect(output()).toHaveTextContent('old alpha text');
    expect(output().scrollTop).toBe(143.5);
    expect(screen.getByRole('searchbox')).toHaveValue('marker');
    expect(screen.getByRole('button', { name: 'Resume' })).toBeVisible();
    await waitFor(() => expect(screen.getByText('1 / 1 matches')).toBeVisible());
    expect(output().scrollTop).toBe(143.5);
    view.rerender(panel(cache, alpha, frame(alpha, '', -1)));
    expect(output()).toHaveTextContent('old alpha text');
    view.rerender(panel(cache, alpha, frame(alpha, 'new alpha text', 2)));
    expect(output()).toHaveTextContent('old alpha text');
    fireEvent.click(screen.getByRole('button', { name: 'Close log search' }));
    expect(output()).toHaveTextContent('old alpha text');
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(output()).toHaveTextContent('new alpha text');
    expect(output().scrollTop).toBe(143.5);
  });

  it('retains an unpaused last display through a quiet connecting stream and replaces only on a real frame', () => {
    vi.useFakeTimers();
    const cache = createStandaloneLogViewCache();
    const load = vi.fn();
    const first = render(panel(cache, alpha, frame(), snapshot, load));
    scroll(255.5); first.unmount();
    const second = render(panel(cache, alpha, frame(alpha, '', -1), snapshot, load));
    expect(output()).toHaveTextContent('old alpha text');
    expect(output().scrollTop).toBe(255.5);
    act(() => vi.advanceTimersByTime(30_000));
    expect(output()).toHaveTextContent('old alpha text');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(load).not.toHaveBeenCalled();
    second.rerender(panel(cache, alpha, frame(alpha, 'new frame', 3), snapshot, load));
    expect(output()).toHaveTextContent('new frame');
    expect(output().scrollTop).toBe(255.5);
  });

  it('accepts the first pinned frame after the same full ID rotates through multiple inventory handles', () => {
    const cache = createStandaloneLogViewCache();
    const view = render(panel(cache, alpha, null));
    const secondHandle = { ...alpha, handle: 'alpha-2' };
    view.rerender(panel(cache, secondHandle, null, { ...snapshot, generation: 2, containers: [secondHandle, beta] }));
    const thirdHandle = { ...alpha, handle: 'alpha-3' };
    view.rerender(panel(cache, thirdHandle, frame(alpha, '', -1), { ...snapshot, generation: 3, containers: [thirdHandle, beta] }));
    view.rerender(panel(cache, thirdHandle, frame(alpha, 'first pinned frame', 0), { ...snapshot, generation: 3, containers: [thirdHandle, beta] }));
    expect(output()).toHaveTextContent('first pinned frame');
    view.rerender(panel(cache, beta, frame(alpha, 'first pinned frame', 0)));
    expect(output()).not.toHaveTextContent('first pinned frame');
  });

  it('invalidates on a new session and explicit reconnect clear without old cleanup repopulating state', () => {
    const cache = createStandaloneLogViewCache();
    const view = render(panel(cache)); pauseAndSearch();
    cache.clear();
    view.rerender(panel(cache, alpha, null));
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    expect(output()).not.toHaveTextContent('old alpha text');
    view.rerender(panel(cache)); pauseAndSearch();
    view.rerender(panel(cache, alpha, frame(), { ...snapshot, sessionId: 'session-2' }));
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    expect(output()).not.toHaveTextContent('old alpha text');
    expect(cache.sessionId).toBe('session-2');
    expect(cache.read(alpha.fullId)?.lastLogs).toBeNull();
  });

  it.each([
    { language: 'en' as const, notice: /screen cache limit/, resume: 'Resume', clear: 'Clear displayed logs', content: 'Recent log content' },
    { language: 'ko' as const, notice: /화면 캐시 상한/, resume: '재개', clear: '로그 화면 비우기', content: '최근 로그 내용' },
  ])('explains the evicted range after a real replacement and resets the reason on Clear ($language)', ({ language, notice, resume, clear, content }) => {
    const cache = createStandaloneLogViewCache();
    cache.sessionId = snapshot.sessionId;
    cache.save(alpha.fullId, { query: 'marker', searchOpen: true, manuallyPaused: true, frozenLogs: null, lastLogs: null, scrollTop: 17.5, followingBottom: false, atBottom: false, payloadEvicted: true });
    const show = (logs: LogSnapshot | null) => panel(cache, alpha, logs, snapshot, vi.fn(), vi.fn(), language);
    const view = render(show(frame(alpha, '', -1)));
    expect(screen.getByRole('searchbox')).toHaveValue('marker');
    expect(screen.getByRole('button', { name: resume })).toBeVisible();
    expect(screen.queryByText(notice)).not.toBeInTheDocument();
    view.rerender(show(frame(alpha, 'replacement marker', 4)));
    expect(screen.getByLabelText(content)).toHaveTextContent('replacement marker');
    expect(screen.getByText(notice)).toHaveAttribute('role', 'status');
    view.rerender(show(frame(alpha, 'later frame', 5)));
    expect(screen.getByLabelText(content)).toHaveTextContent('replacement marker');
    expect(screen.getByText(notice)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: clear }));
    expect(screen.queryByText(notice)).not.toBeInTheDocument();
    expect(cache.read(alpha.fullId)?.payloadEvicted).toBe(false);
    view.rerender(show(null)); view.unmount();
    render(show(frame(alpha, '', -1)));
    expect(screen.queryByText(notice)).not.toBeInTheDocument();
  });

  it('does not resurrect a cleared frozen display or search on remount', () => {
    const cache = createStandaloneLogViewCache();
    const old = frame();
    const clear = vi.fn();
    const first = render(panel(cache, alpha, old, snapshot, vi.fn(), clear));
    pauseAndSearch();
    fireEvent.click(screen.getByRole('button', { name: 'Clear displayed logs' }));
    expect(clear).toHaveBeenCalledOnce();
    expect(output()).not.toHaveTextContent('old alpha text');
    first.rerender(panel(cache, alpha, null)); first.unmount();
    render(panel(cache, alpha, frame(alpha, '', -1)));
    expect(output()).not.toHaveTextContent('old alpha text');
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resume' })).toBeVisible();
  });
});
