import { describe, expect, it } from 'vitest';
import type { LogSnapshot } from './logSnapshot';
import { createStandaloneLogViewCache, STANDALONE_LOG_VIEW_BUDGET, type StandaloneLogViewState } from './standaloneLogViewCache';

function state(id: number, length = 64 * 1024): StandaloneLogViewState {
  const logs: LogSnapshot = { sessionId: 'session', generation: 1, handle: `handle-${id}`, fetchedAt: '', text: 'x'.repeat(length), byteCount: length, truncated: false, command: '', stderr: '' };
  return { query: `marker-${id}`, searchOpen: true, manuallyPaused: true, frozenLogs: logs, lastLogs: logs, scrollTop: id + 0.5, followingBottom: false, atBottom: false, payloadEvicted: false };
}

describe('standalone log view payload budget', () => {
  it('evicts least recently read payloads across many 64 KiB containers while retaining view controls', () => {
    const cache = createStandaloneLogViewCache();
    for (let id = 0; id < 63; id++) cache.save(String(id), state(id));
    expect(cache.retainedBytes).toBeLessThanOrEqual(STANDALONE_LOG_VIEW_BUDGET);
    expect(cache.read('0')?.lastLogs).not.toBeNull();
    cache.save('63', state(63));
    expect(cache.read('0')?.lastLogs).not.toBeNull();
    expect(cache.read('1')).toMatchObject({ query: 'marker-1', searchOpen: true, manuallyPaused: true, scrollTop: 1.5, followingBottom: false, frozenLogs: null, lastLogs: null, payloadEvicted: true });
    for (let id = 64; id < 100; id++) cache.save(String(id), state(id));
    expect(cache.retainedBytes).toBeLessThanOrEqual(STANDALONE_LOG_VIEW_BUDGET);
    expect(cache.read('99')?.lastLogs?.text).toHaveLength(64 * 1024);
  });

  it('does not evict useful smaller payloads for an oversized view and clears session controls too', () => {
    const cache = createStandaloneLogViewCache();
    cache.sessionId = 'session';
    cache.save('small', state(1));
    cache.save('huge', state(2, STANDALONE_LOG_VIEW_BUDGET));
    expect(cache.read('small')?.lastLogs).not.toBeNull();
    expect(cache.read('huge')).toMatchObject({ query: 'marker-2', lastLogs: null, frozenLogs: null, payloadEvicted: true });
    const version = cache.version;
    cache.clear();
    expect(cache).toMatchObject({ version: version + 1, sessionId: null, retainedBytes: 0 });
    expect(cache.read('small')).toBeUndefined();
    expect(cache.read('huge')).toBeUndefined();
  });
});
