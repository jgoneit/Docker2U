import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LogSearchReply, LogSearchRequest } from './logSearch';
import { useLogSearch } from './useLogSearch';

class HookWorker {
  static instances: HookWorker[] = [];
  onmessage: ((event: MessageEvent<LogSearchReply>) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  postMessage = vi.fn<(request: LogSearchRequest) => void>();
  terminate = vi.fn();
  constructor() { HookWorker.instances.push(this); }
  emit(reply: LogSearchReply) { this.onmessage?.(new MessageEvent('message', { data: reply })); }
  lastSearch() {
    const request = this.postMessage.mock.calls.map(([request]) => request).filter(request => request.type === 'search').at(-1);
    if (!request) throw new Error('No search request');
    return request;
  }
  finish() {
    const request = this.lastSearch();
    this.emit({ type: 'result', snapshotId: request.snapshotId, searchId: request.searchId, total: 2, match: { ordinal: 0, start: 0, length: 5 } });
  }
}
const initial = { target: 'session/container', text: 'ERROR error', query: 'error' };

describe('log search hook lifecycle', () => {
  beforeEach(() => { HookWorker.instances = []; vi.stubGlobal('Worker', HookWorker); });
  afterEach(() => vi.unstubAllGlobals());

  it('retains completed navigation across unchanged inputs without searching again', () => {
    const { result, rerender, unmount } = renderHook(input => useLogSearch(input), { initialProps: initial });
    const worker = HookWorker.instances[0]!;
    act(() => { worker.emit({ type: 'ready' }); worker.finish(); });
    act(() => result.current.move(1));
    const navigation = worker.postMessage.mock.calls.map(([request]) => request).filter(request => request.type === 'locate').at(-1)!;
    act(() => worker.emit({ type: 'located', searchId: navigation.searchId, navigationId: navigation.navigationId, match: { ordinal: 1, start: 6, length: 5 } }));
    const calls = worker.postMessage.mock.calls.length;
    rerender({ ...initial });
    expect(result.current).toMatchObject({ status: 'ready', total: 2, activeIndex: 1, activeStart: 6, activeLength: 5 });
    expect(worker.postMessage).toHaveBeenCalledTimes(calls);
    unmount(); expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('hides old results immediately on input replacement and ignores late replies', () => {
    const { result, rerender, unmount } = renderHook(input => useLogSearch(input), { initialProps: initial });
    const worker = HookWorker.instances[0]!;
    act(() => { worker.emit({ type: 'ready' }); worker.finish(); });
    const old = worker.lastSearch();
    rerender({ ...initial, target: 'session/another-container' });
    expect(result.current).toMatchObject({ status: 'searching', total: 0, activeStart: undefined });
    act(() => worker.emit({ type: 'result', snapshotId: old.snapshotId, searchId: old.searchId, total: 2, match: { ordinal: 0, start: 0, length: 5 } }));
    expect(result.current).toMatchObject({ status: 'searching', total: 0, activeStart: undefined });
    act(() => worker.finish());
    expect(result.current.status).toBe('ready');
    rerender({ ...initial, target: 'session/another-container', query: '' });
    expect(result.current).toMatchObject({ status: 'idle', total: 0, activeStart: undefined });
    unmount();
  });

  it('does not start a worker for empty logs or an empty query', () => {
    const { result, rerender, unmount } = renderHook(input => useLogSearch(input), { initialProps: { ...initial, text: '' } });
    expect(result.current.status).toBe('idle');
    rerender({ ...initial, query: '' });
    expect(result.current.status).toBe('idle');
    expect(HookWorker.instances).toHaveLength(0);
    unmount();
  });
});
