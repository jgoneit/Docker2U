import type { LogSnapshot } from './logSnapshot';

export interface StandaloneLogViewState {
  query: string; searchOpen: boolean; manuallyPaused: boolean;
  frozenLogs: LogSnapshot | null; lastLogs: LogSnapshot | null;
  payloadEvicted: boolean;
  scrollTop: number; followingBottom: boolean; atBottom: boolean;
}
export const STANDALONE_LOG_VIEW_BUDGET = 8 * 1024 * 1024;
export interface StandaloneLogViewCache {
  sessionId: string | null; version: number; retainedBytes: number;
  read: (fullId: string) => StandaloneLogViewState | undefined;
  save: (fullId: string, state: StandaloneLogViewState) => void;
  clear: () => void;
}
/** App owns this cache. Eviction discards payloads, never view preferences. */
export function createStandaloneLogViewCache(): StandaloneLogViewCache {
  const views = new Map<string, StandaloneLogViewState>();
  const costs = new Map<string, number>(), recent = new Map<string, true>();
  const cache: StandaloneLogViewCache = {
    sessionId: null, version: 0, retainedBytes: 0,
    read(fullId) {
      if (recent.has(fullId)) { recent.delete(fullId); recent.set(fullId, true); }
      return views.get(fullId);
    },
    save(fullId, state) {
      const payloads = new Set([state.frozenLogs, state.lastLogs]);
      let bytes = [...payloads].reduce((total, value) => total + (value ? 512 + (value.text.length + value.stderr.length + value.command.length) * 2 : 0), 0);
      if (bytes > STANDALONE_LOG_VIEW_BUDGET) { state = { ...state, frozenLogs: null, lastLogs: null, payloadEvicted: true }; bytes = 0; }
      cache.retainedBytes += bytes - (costs.get(fullId) ?? 0);
      views.set(fullId, state); costs.set(fullId, bytes); recent.delete(fullId);
      if (bytes) recent.set(fullId, true);
      while (cache.retainedBytes > STANDALONE_LOG_VIEW_BUDGET) {
        const oldest = recent.keys().next().value;
        if (oldest === undefined) break;
        views.set(oldest, { ...views.get(oldest)!, frozenLogs: null, lastLogs: null, payloadEvicted: true });
        cache.retainedBytes -= costs.get(oldest) ?? 0;
        costs.delete(oldest); recent.delete(oldest);
      }
    },
    clear() { cache.sessionId = null; cache.version++; cache.retainedBytes = 0; views.clear(); costs.clear(); recent.clear(); },
  };
  return cache;
}
