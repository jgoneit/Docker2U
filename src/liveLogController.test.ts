import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Container, ContainerList } from './api';
import { emptyLogState, LiveLogController, type LiveLogState, type LogTransport } from './liveLogController';
import { appendLogText, LOG_BUFFER_BYTES } from './logSnapshot';

const a: Container = { handle: 'a1', fullId: 'a'.repeat(64), shortId: 'a'.repeat(12), composeProject: null, composeService: null, name: 'alpha', image: 'alpine', state: 'running', health: null, ports: [], createdAt: '' };
const b: Container = { ...a, handle: 'b1', fullId: 'b'.repeat(64), name: 'beta' };
const list: ContainerList = { sessionId: 'session', generation: 1, containers: [a, b], refreshedAt: '', stale: false };
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const flush = async () => { for (let index = 0; index < 8; ++index) await Promise.resolve(); };
function setup() {
  let state: LiveLogState = emptyLogState();
  const report = vi.fn();
  const transport: LogTransport = {
    startLogStream: vi.fn(async (_session, _generation, handle) => ({ sessionId: 'session', streamId: `stream-${handle}`, fullId: handle[0].repeat(64) })),
    readLogStream: vi.fn(async (_session, streamId) => ({ sessionId: 'session', streamId, sequence: 1, text: 'first\n', terminal: false, truncated: false, error: null })),
    stopLogStream: vi.fn(async () => {}),
    getRecentLogs: vi.fn(async (sessionId, handle) => ({ sessionId, generation: 1, handle, text: 'snapshot', truncated: false, byteCount: 8, command: '', stderr: '' })),
  };
  const publish = vi.fn((value: LiveLogState) => { state = value; });
  const controller = new LiveLogController(transport, publish, report);
  return { controller, transport, report, publish, state: () => state };
}

describe('live log lifecycle', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it('keeps a pinned stream across handle refresh and temporary mutation/refresh gating', async () => {
    const { controller, transport, state } = setup();
    controller.update({ container: a, snapshot: list, enabled: true }); await flush();
    expect(state().logs?.text).toBe('first\n');
    controller.update({ container: { ...a, handle: 'a2' }, snapshot: { ...list, generation: 2 }, enabled: false });
    await vi.advanceTimersByTimeAsync(1000);
    controller.update({ container: { ...a, handle: 'a3' }, snapshot: { ...list, generation: 3 }, enabled: true });
    expect(transport.startLogStream).toHaveBeenCalledTimes(1);
    expect(transport.stopLogStream).not.toHaveBeenCalled();
    expect(transport.readLogStream).toHaveBeenCalledTimes(5);
    expect(state().logs?.text).toBe('first\n'); // duplicate frames are not duplicated
    controller.destroy();
  });
  it('serializes slow reads and waits 250ms after each response', async () => {
    const { controller, transport } = setup();
    const frame = deferred<Awaited<ReturnType<LogTransport['readLogStream']>>>();
    vi.mocked(transport.readLogStream).mockReturnValue(frame.promise);
    controller.update({ container: a, snapshot: list, enabled: true }); await flush();
    await vi.advanceTimersByTimeAsync(3000);
    expect(transport.readLogStream).toHaveBeenCalledTimes(1);
    frame.resolve({ sessionId: 'session', streamId: 'stream-a1', sequence: 1, text: 'one', terminal: false, truncated: false, error: null }); await flush();
    await vi.advanceTimersByTimeAsync(249); expect(transport.readLogStream).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(transport.readLogStream).toHaveBeenCalledTimes(2);
    controller.destroy();
  });
  it('acknowledges empty and duplicate frames without publishing or changing the receipt time', async () => {
    const { controller, transport, publish, state } = setup();
    let sequence = 0;
    vi.mocked(transport.readLogStream).mockImplementation(async (_session, streamId) => ({
      sessionId: 'session', streamId, sequence: ++sequence, text: sequence === 1 ? 'first\n' : '',
      terminal: false, truncated: false, error: null,
    }));
    controller.update({ container: a, snapshot: list, enabled: true }); await flush();
    const received = state();
    publish.mockClear();
    await vi.advanceTimersByTimeAsync(1000);
    expect(transport.readLogStream).toHaveBeenCalledTimes(5);
    expect(publish).not.toHaveBeenCalled();
    expect(state()).toBe(received);
    vi.mocked(transport.readLogStream).mockResolvedValue({ sessionId: 'session', streamId: 'stream-a1', sequence: 6,
      text: 'next\n', terminal: false, truncated: false, error: null });
    await vi.advanceTimersByTimeAsync(250);
    expect(state().logs?.text).toBe('first\nnext\n');
    expect(state().logs?.fetchedAt).not.toBe(received.logs?.fetchedAt);
    const next = state();
    publish.mockClear();
    await vi.advanceTimersByTimeAsync(500);
    expect(publish).not.toHaveBeenCalled();
    expect(state()).toBe(next);
    controller.destroy();
  });
  it('rejects sequence regression after acknowledging unpublished empty frames', async () => {
    const { controller, transport, state, report } = setup();
    controller.update({ container: a, snapshot: list, enabled: true }); await flush();
    vi.mocked(transport.readLogStream).mockResolvedValueOnce({ sessionId: 'session', streamId: 'stream-a1', sequence: 3,
      text: '', terminal: false, truncated: false, error: null });
    await vi.advanceTimersByTimeAsync(250);
    vi.mocked(transport.readLogStream).mockResolvedValueOnce({ sessionId: 'session', streamId: 'stream-a1', sequence: 2,
      text: 'out of order', terminal: false, truncated: false, error: null });
    await vi.advanceTimersByTimeAsync(250);
    expect(state().logs?.text).toBe('first\n');
    expect(state().liveStatus).toBe('error');
    expect(report).toHaveBeenCalledTimes(1);
    controller.destroy();
  });
  it.each(['terminal', 'error'] as const)('processes empty truncation and %s frames without inventing a receipt', async outcome => {
    const { controller, transport, state, publish } = setup();
    controller.update({ container: a, snapshot: list, enabled: true }); await flush();
    const received = state().logs!;
    vi.mocked(transport.readLogStream).mockResolvedValueOnce({ sessionId: 'session', streamId: 'stream-a1', sequence: 2,
      text: '', terminal: false, truncated: true, error: null });
    await vi.advanceTimersByTimeAsync(250);
    expect(state().logs).toMatchObject({ text: received.text, fetchedAt: received.fetchedAt, truncated: true, droppedBatches: 1, receivedBytes: received.receivedBytes });
    const truncated = state().logs;
    publish.mockClear();
    vi.mocked(transport.readLogStream).mockResolvedValueOnce({ sessionId: 'session', streamId: 'stream-a1', sequence: 2,
      text: '', terminal: outcome === 'terminal', truncated: true, error: outcome === 'error' ? { code: 'CommandFailed', message: 'follow ended' } : null });
    await vi.advanceTimersByTimeAsync(250);
    expect(state().logs).toBe(truncated);
    expect(state().liveStatus).toBe(outcome === 'terminal' ? 'ended' : 'error');
    expect(publish).toHaveBeenCalledTimes(1);
    expect(transport.stopLogStream).toHaveBeenCalledExactlyOnceWith('session', 'stream-a1');
    controller.destroy();
  });
  it.each(['clear', 'select'].flatMap(action => ['reject', 'frame'].map(result => ({ action, result }))))('discards an obsolete ordinary $result failure after $action', async ({ action, result }) => {
    const { controller, transport, state, report } = setup();
    const read = deferred<Awaited<ReturnType<LogTransport['readLogStream']>>>();
    vi.mocked(transport.readLogStream).mockReturnValueOnce(read.promise);
    controller.update({ container: a, snapshot: list, enabled: true }); await flush();
    if (action === 'clear') controller.clear();
    else controller.update({ container: b, snapshot: list, enabled: true });
    const failure = { code: 'StaleHandle', message: 'old subscription stopped' };
    if (result === 'reject') read.reject(failure);
    else read.resolve({ sessionId: 'session', streamId: 'stream-a1', sequence: 1, text: '', terminal: true, truncated: false, error: failure });
    await flush();
    expect(report).not.toHaveBeenCalled();
    expect(state().logsError).toBeNull();
    expect(state().logs?.text ?? null).toBe(action === 'clear' ? null : 'first\n');
    controller.destroy();
  });
  it('keeps one read IPC across target replacement even after the old stream is stopped', async () => {
    const { controller, transport, state } = setup();
    const oldRead = deferred<Awaited<ReturnType<LogTransport['readLogStream']>>>();
    vi.mocked(transport.readLogStream).mockReturnValueOnce(oldRead.promise);
    controller.update({ container: a, snapshot: list, enabled: true }); await flush();
    expect(transport.readLogStream).toHaveBeenCalledTimes(1);
    controller.update({ container: b, snapshot: list, enabled: true }); await flush();
    expect(transport.stopLogStream).toHaveBeenCalledWith('session', 'stream-a1');
    expect(transport.startLogStream).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(transport.readLogStream).toHaveBeenCalledTimes(1);
    oldRead.resolve({ sessionId: 'session', streamId: 'stream-a1', sequence: 1, text: 'obsolete alpha', terminal: false, truncated: false, error: null }); await flush();
    expect(transport.readLogStream).toHaveBeenCalledTimes(2);
    expect(transport.readLogStream).toHaveBeenLastCalledWith('session', 'stream-b1');
    expect(state().logs?.handle).toBe('b1'); expect(state().logs?.text).toBe('first\n');
    controller.destroy();
  });
  it('clears the replacement read queue while an old target read is still in flight', async () => {
    const { controller, transport, state } = setup();
    const oldRead = deferred<Awaited<ReturnType<LogTransport['readLogStream']>>>();
    vi.mocked(transport.readLogStream).mockReturnValueOnce(oldRead.promise);
    controller.update({ container: a, snapshot: list, enabled: true }); await flush();
    controller.update({ container: b, snapshot: list, enabled: true }); await flush();
    controller.clear(); await flush();
    oldRead.resolve({ sessionId: 'session', streamId: 'stream-a1', sequence: 1, text: 'obsolete alpha', terminal: false, truncated: false, error: null }); await flush();
    await vi.advanceTimersByTimeAsync(2000);
    expect(transport.readLogStream).toHaveBeenCalledTimes(1); expect(state().logs).toBeNull();
    expect(transport.stopLogStream).toHaveBeenCalledWith('session', 'stream-b1');
    controller.destroy();
  });
  it('stops a late start before starting the newest selected target and ignores its data', async () => {
    const { controller, transport, state } = setup();
    const first = deferred<Awaited<ReturnType<LogTransport['startLogStream']>>>();
    const stopped = deferred<void>();
    vi.mocked(transport.startLogStream).mockReturnValueOnce(first.promise);
    vi.mocked(transport.stopLogStream).mockReturnValueOnce(stopped.promise);
    controller.update({ container: a, snapshot: list, enabled: true });
    controller.update({ container: b, snapshot: list, enabled: true });
    first.resolve({ sessionId: 'session', streamId: 'old', fullId: a.fullId }); await flush();
    expect(transport.stopLogStream).toHaveBeenCalledWith('session', 'old');
    expect(transport.startLogStream).toHaveBeenCalledTimes(1);
    expect(transport.readLogStream).not.toHaveBeenCalled();
    stopped.resolve(); await flush();
    expect(transport.startLogStream).toHaveBeenLastCalledWith('session', 1, 'b1');
    expect(state().logs?.handle).toBe('b1');
    controller.destroy();
  });
  it('does not respawn a naturally ended stream until an explicit refresh/mutation revision', async () => {
    const { controller, transport, state } = setup();
    vi.mocked(transport.readLogStream).mockResolvedValue({ sessionId: 'session', streamId: 'stream-a1', sequence: 1, text: 'last', terminal: true, truncated: false, error: null });
    controller.update({ container: a, snapshot: list, enabled: true, restartVersion: 0 }); await flush();
    expect(state().liveStatus).toBe('ended');
    await vi.advanceTimersByTimeAsync(10000);
    controller.update({ container: { ...a }, snapshot: { ...list, generation: 2 }, enabled: true, restartVersion: 0 }); await flush();
    expect(transport.startLogStream).toHaveBeenCalledTimes(1);
    controller.update({ container: a, snapshot: list, enabled: true, restartVersion: 1 }); await flush();
    expect(transport.startLogStream).toHaveBeenCalledTimes(2);
    controller.destroy();
  });
  it('reopens once when refresh completion arrives immediately before the terminal read', async () => {
    const { controller, transport } = setup();
    controller.update({ container: a, snapshot: list, enabled: true, restartVersion: 0 }); await flush();
    vi.mocked(transport.readLogStream).mockResolvedValueOnce({ sessionId: 'session', streamId: 'stream-a1', sequence: 2, text: 'last', terminal: true, truncated: false, error: null });
    controller.update({ container: { ...a, handle: 'a2' }, snapshot: { ...list, generation: 2 }, enabled: true, restartVersion: 1 });
    await vi.advanceTimersByTimeAsync(250); await flush();
    expect(transport.startLogStream).toHaveBeenCalledTimes(2);
    expect(transport.startLogStream).toHaveBeenLastCalledWith('session', 2, 'a2');
    controller.destroy();
  });
  it('expires a refresh restart intent when the next read confirms the stream is still active', async () => {
    const { controller, transport } = setup();
    controller.update({ container: a, snapshot: list, enabled: true, restartVersion: 0 }); await flush();
    controller.update({ container: a, snapshot: list, enabled: true, restartVersion: 1 });
    await vi.advanceTimersByTimeAsync(250);
    vi.mocked(transport.readLogStream).mockResolvedValueOnce({ sessionId: 'session', streamId: 'stream-a1', sequence: 2, text: 'last', terminal: true, truncated: false, error: null });
    await vi.advanceTimersByTimeAsync(250);
    expect(transport.startLogStream).toHaveBeenCalledTimes(1);
    controller.destroy();
  });
  it.each([false, true])('replaces once after successful Restart without waiting for a delayed old read (terminal=%s)', async terminal => {
    const { controller, transport, state } = setup();
    controller.update({ container: a, snapshot: list, enabled: true, replaceVersion: 0 }); await flush();
    const oldRead = deferred<Awaited<ReturnType<LogTransport['readLogStream']>>>();
    const stopped = deferred<void>();
    vi.mocked(transport.readLogStream).mockReturnValueOnce(oldRead.promise);
    await vi.advanceTimersByTimeAsync(250);
    vi.mocked(transport.stopLogStream).mockReturnValueOnce(stopped.promise);
    const updated = { container: { ...a, handle: 'a2' }, snapshot: { ...list, generation: 2 }, enabled: true, replaceVersion: 1 };
    controller.update(updated); await flush();
    expect(transport.stopLogStream).toHaveBeenCalledExactlyOnceWith('session', 'stream-a1');
    expect(transport.startLogStream).toHaveBeenCalledTimes(1);
    stopped.resolve(); await flush();
    expect(transport.startLogStream).toHaveBeenLastCalledWith('session', 2, 'a2');
    expect(transport.readLogStream).toHaveBeenCalledTimes(2);
    vi.mocked(transport.readLogStream).mockResolvedValueOnce({ sessionId: 'session', streamId: 'stream-a2', sequence: 1, text: 'fresh tail\n', terminal: true, truncated: false, error: null });
    oldRead.resolve({ sessionId: 'session', streamId: 'stream-a1', sequence: 2, text: 'obsolete tail\n', terminal, truncated: false, error: null }); await flush();
    expect(state().logs?.text).toBe('fresh tail\n');
    expect(state().logs?.handle).toBe('a2');
    expect(state().liveStatus).toBe('ended');
    controller.update({ ...updated });
    await vi.advanceTimersByTimeAsync(10000);
    expect(transport.startLogStream).toHaveBeenCalledTimes(2);
    controller.destroy();
  });
  it('does not apply a replacement revision to a changed target or override Clear', async () => {
    const { controller, transport, state } = setup();
    controller.update({ container: a, snapshot: list, enabled: true, replaceVersion: 0 }); await flush();
    controller.clear();
    controller.update({ container: { ...a, handle: 'a2' }, snapshot: { ...list, generation: 2 }, enabled: true, replaceVersion: 1 }); await flush();
    expect(state().logs).toBeNull(); expect(transport.startLogStream).toHaveBeenCalledTimes(1);
    controller.update({ container: b, snapshot: list, enabled: true, replaceVersion: 2 }); await flush();
    expect(transport.startLogStream).toHaveBeenCalledTimes(2);
    expect(transport.startLogStream).toHaveBeenLastCalledWith('session', 1, 'b1');
    controller.destroy();
  });
  it('clear stops collection and survives inventory/operation refresh until manual reload or a new target', async () => {
    const { controller, transport, state } = setup();
    controller.update({ container: a, snapshot: list, enabled: true, restartVersion: 0 }); await flush();
    controller.clear(); await flush();
    controller.update({ container: { ...a }, snapshot: { ...list, generation: 2 }, enabled: true, restartVersion: 1 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(state().logs).toBeNull(); expect(transport.startLogStream).toHaveBeenCalledTimes(1);
    controller.reload(); await flush(); expect(transport.startLogStream).toHaveBeenCalledTimes(2);
    controller.clear(); controller.update({ container: b, snapshot: list, enabled: true, restartVersion: 1 }); await flush();
    expect(transport.startLogStream).toHaveBeenCalledTimes(3);
    controller.destroy();
  });
  it('preserves captured text on stream errors and immediately stops on session invalidation', async () => {
    const { controller, transport, report, state } = setup();
    controller.update({ container: a, snapshot: list, enabled: true }); await flush();
    vi.mocked(transport.readLogStream).mockRejectedValueOnce({ code: 'DOCKER_UNAVAILABLE', message: 'engine stopped' });
    await vi.advanceTimersByTimeAsync(250);
    expect(state().logs?.text).toBe('first\n'); expect(state().liveStatus).toBe('error');
    expect(report).toHaveBeenCalledTimes(1);
    controller.reload(); await flush();
    controller.update({ container: a, snapshot: list, enabled: true, invalidated: true }); await flush();
    const reads = vi.mocked(transport.readLogStream).mock.calls.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(transport.readLogStream).toHaveBeenCalledTimes(reads);
    expect(transport.stopLogStream).toHaveBeenCalledTimes(2);
    controller.destroy();
  });
  it.each(['created', 'exited', 'dead'])('takes a single snapshot for %s containers', async containerState => {
    const { controller, transport, state } = setup();
    controller.update({ container: { ...a, state: containerState }, snapshot: list, enabled: true }); await flush();
    expect(transport.getRecentLogs).toHaveBeenCalledExactlyOnceWith('session', 'a1');
    expect(transport.startLogStream).not.toHaveBeenCalled(); expect(state().logs?.text).toBe('snapshot');
    await vi.advanceTimersByTimeAsync(1000); expect(transport.getRecentLogs).toHaveBeenCalledTimes(1);
    controller.destroy();
  });
  it('reports a current-session late read failure after Clear without restoring text', async () => {
    const { controller, transport, report, state } = setup();
    const read = deferred<Awaited<ReturnType<LogTransport['readLogStream']>>>();
    vi.mocked(transport.readLogStream).mockReturnValueOnce(read.promise);
    report.mockReturnValue(true);
    controller.update({ container: a, snapshot: list, enabled: true }); await flush();
    controller.clear();
    read.reject({ code: 'EnvironmentChanged', message: 'new engine detected' }); await flush();
    expect(report).toHaveBeenCalledTimes(1); expect(state().logs).toBeNull(); expect(state().logsError).toBeNull();
    controller.reload(); await flush(); expect(transport.startLogStream).toHaveBeenCalledTimes(1);
    controller.destroy();
  });
  it('blocks the queued start synchronously when the error callback invalidates the session', async () => {
    const { controller, transport, report } = setup();
    const start = deferred<Awaited<ReturnType<LogTransport['startLogStream']>>>();
    vi.mocked(transport.startLogStream).mockReturnValueOnce(start.promise); report.mockReturnValue(true);
    controller.update({ container: a, snapshot: list, enabled: true });
    controller.update({ container: b, snapshot: list, enabled: true });
    start.reject({ code: 'EnvironmentChanged', message: 'new engine detected' }); await flush();
    expect(transport.startLogStream).toHaveBeenCalledTimes(1); expect(report).toHaveBeenCalledTimes(1);
    controller.destroy();
  });
  it('discards late reads after clear and unmount without reporting obsolete errors', async () => {
    const { controller, transport, report, state } = setup();
    const read = deferred<Awaited<ReturnType<LogTransport['readLogStream']>>>();
    vi.mocked(transport.readLogStream).mockReturnValueOnce(read.promise);
    controller.update({ container: a, snapshot: list, enabled: true }); await flush();
    controller.clear(); controller.destroy();
    read.reject({ code: 'DOCKER_UNAVAILABLE', message: 'late' }); await flush();
    expect(state().logs).toBeNull(); expect(report).not.toHaveBeenCalled();
    expect(transport.stopLogStream).toHaveBeenCalledExactlyOnceWith('session', 'stream-a1');
  });
});

describe('bounded UTF-8 log buffer', () => {
  it('retains a valid tail within 2MiB and reports cumulative append loss', () => {
    const first = appendLogText('', '한'.repeat(LOG_BUFFER_BYTES));
    expect(first.byteCount).toBeLessThanOrEqual(LOG_BUFFER_BYTES);
    expect(first.text).not.toContain('\ufffd');
    expect(new TextEncoder().encode(first.text).byteLength).toBe(first.byteCount);
    const next = appendLogText(first.text, 'new');
    expect(next.text.endsWith('new')).toBe(true); expect(next.droppedBytes).toBe(3);
  });
});
