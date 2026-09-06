import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LogSearchReply, LogSearchRequest } from './logSearch';
import { LogSearchController, type LogSearchInput, type LogSearchState, type LogSearchWorker } from './logSearchController';

class FakeWorker implements LogSearchWorker {
  onmessage: Worker['onmessage'] = null;
  onerror: Worker['onerror'] = null;
  onmessageerror: Worker['onmessageerror'] = null;
  postMessage = vi.fn<(request: LogSearchRequest) => void>();
  terminate = vi.fn();
  emit(reply: LogSearchReply) { this.onmessage?.call(this as unknown as Worker, new MessageEvent('message', { data: reply })); }
  fail() { this.onerror?.call(this as unknown as Worker, new ErrorEvent('error', { cancelable: true })); }
  request<T extends LogSearchRequest['type']>(type: T) {
    const messages = this.postMessage.mock.calls.map(([message]) => message).filter(message => message.type === type);
    return messages.at(-1) as Extract<LogSearchRequest, { type: T }>;
  }
  result(total = 3) {
    const request = this.request('search');
    this.emit({ type: 'result', snapshotId: request.snapshotId, searchId: request.searchId, total, match: total ? { ordinal: 0, start: 0, length: 1 } : undefined });
  }
  located() {
    const request = this.request('locate');
    this.emit({ type: 'located', searchId: request.searchId, navigationId: request.navigationId, match: { ordinal: request.ordinal, start: request.ordinal * 2, length: 1 } });
  }
}
const initial: LogSearchInput = { target: 'session/container', text: 'a a a', query: 'a' };

describe('log search controller', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('creates the worker lazily, sends one snapshot, and retains it across query clearing', () => {
    const worker = new FakeWorker();
    const makeWorker = vi.fn(() => worker);
    const publish = vi.fn<(state: LogSearchState) => void>();
    const controller = new LogSearchController(publish, makeWorker);
    controller.update({ ...initial, query: '' });
    expect(makeWorker).not.toHaveBeenCalled();
    controller.update(initial);
    controller.update({ ...initial, query: 'aa' });
    expect(worker.postMessage).not.toHaveBeenCalled();
    worker.emit({ type: 'ready' });
    expect(worker.request('search').query).toBe('aa');
    controller.update({ ...initial, query: '' });
    expect(worker.request('cancel')).toEqual({ type: 'cancel' });
    controller.update(initial);
    expect(worker.postMessage.mock.calls.filter(([request]) => request.type === 'snapshot')).toHaveLength(1);
    controller.update({ ...initial, text: 'a new snapshot' });
    expect(worker.postMessage.mock.calls.filter(([request]) => request.type === 'snapshot')).toHaveLength(2);
    controller.dispose();
  });

  it('ignores old searches and accumulates rapid navigation before accepting only the latest result', () => {
    const worker = new FakeWorker();
    const publish = vi.fn<(state: LogSearchState) => void>();
    const controller = new LogSearchController(publish, () => worker);
    controller.update(initial); worker.emit({ type: 'ready' });
    const old = worker.request('search');
    controller.update({ ...initial, query: 'A' });
    worker.emit({ type: 'result', snapshotId: old.snapshotId, searchId: old.searchId, total: 999 });
    expect(publish.mock.lastCall?.[0].status).toBe('searching');
    worker.result();
    controller.move(1);
    const firstMove = worker.request('locate');
    controller.move(1);
    expect(worker.request('locate').ordinal).toBe(2);
    worker.emit({ type: 'located', searchId: firstMove.searchId, navigationId: firstMove.navigationId, match: { ordinal: 1, start: 2, length: 1 } });
    expect(publish.mock.lastCall?.[0].activeIndex).toBe(0);
    worker.located();
    expect(publish.mock.lastCall?.[0]).toMatchObject({ activeIndex: 2, activeStart: 4 });
    controller.move(1); worker.located();
    expect(publish.mock.lastCall?.[0].activeIndex).toBe(0);
    controller.move(-1); worker.located();
    expect(publish.mock.lastCall?.[0].activeIndex).toBe(2);
    controller.dispose();
  });

  it.each(['target', 'clear', 'dispose'] as const)('rejects late worker results after %s', action => {
    const worker = new FakeWorker();
    const publish = vi.fn<(state: LogSearchState) => void>();
    const controller = new LogSearchController(publish, () => worker);
    controller.update(initial); worker.emit({ type: 'ready' });
    const old = worker.request('search');
    if (action === 'target') controller.update({ ...initial, target: 'other', query: '' });
    else if (action === 'clear') controller.update({ ...initial, text: '' });
    else controller.dispose();
    const calls = publish.mock.calls.length;
    worker.emit({ type: 'result', snapshotId: old.snapshotId, searchId: old.searchId, total: 3, match: { ordinal: 0, start: 0, length: 1 } });
    expect(publish).toHaveBeenCalledTimes(calls);
    if (action !== 'dispose') expect(worker.request('reset')).toEqual({ type: 'reset' });
    controller.dispose();
  });

  it.each(['constructor', 'timeout', 'error', 'messageerror'] as const)('uses cooperative exact search after worker %s failure', async failure => {
    const worker = new FakeWorker();
    const publish = vi.fn<(state: LogSearchState) => void>();
    const controller = new LogSearchController(publish, () => {
      if (failure === 'constructor') throw new Error('Worker unavailable');
      return worker;
    });
    controller.update(initial);
    if (failure === 'error') worker.fail();
    else if (failure === 'messageerror') worker.onmessageerror?.call(worker as unknown as Worker, new MessageEvent('messageerror'));
    expect(publish.mock.lastCall?.[0].status).toBe('searching');
    await vi.runAllTimersAsync();
    expect(publish.mock.lastCall?.[0]).toMatchObject({ status: 'ready', total: 3, activeIndex: 0, activeStart: 0 });
    controller.move(-1); await vi.runAllTimersAsync();
    expect(publish.mock.lastCall?.[0]).toMatchObject({ activeIndex: 2, activeStart: 4 });
    if (failure !== 'constructor') expect(worker.terminate).toHaveBeenCalledOnce();
    controller.dispose();
  });

  it('restores the latest desired position after a runtime fallback and continues navigation from it', async () => {
    const worker = new FakeWorker();
    const publish = vi.fn<(state: LogSearchState) => void>();
    const controller = new LogSearchController(publish, () => worker);
    controller.update(initial); worker.emit({ type: 'ready' }); worker.result();
    controller.move(1); controller.move(1);
    worker.fail();
    expect(publish.mock.lastCall?.[0].status).toBe('searching');
    await vi.runAllTimersAsync();
    expect(publish.mock.lastCall?.[0]).toMatchObject({ status: 'ready', activeIndex: 2, activeStart: 4 });
    controller.move(1); await vi.runAllTimersAsync();
    expect(publish.mock.lastCall?.[0]).toMatchObject({ activeIndex: 0, activeStart: 0 });
    controller.dispose();
  });

  it('cancels a dense fallback search before its queued work runs', async () => {
    const publish = vi.fn<(state: LogSearchState) => void>();
    const controller = new LogSearchController(publish, () => { throw new Error('unavailable'); });
    controller.update({ ...initial, text: 'a'.repeat(2 * 1024 * 1024) });
    controller.update({ ...initial, text: '' });
    const calls = publish.mock.calls.length;
    await vi.runAllTimersAsync();
    expect(publish).toHaveBeenCalledTimes(calls);
    expect(publish.mock.lastCall?.[0]).toMatchObject({ status: 'idle', total: 0 });
    controller.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});
