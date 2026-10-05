import { beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { observationApi, projectLogApi, standaloneLogApi } from './observationApi';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: () => true }));
beforeEach(() => vi.resetAllMocks());
it('sends the bounded project log query as the Rust command query DTO', async () => {
  const query = { sourceIds: ['full-id'], keyword: 'Error[DB]', offset: 120, limit: 160, throughSequence: 500, anchorRowId: 'row-9', afterSequence: 20 };
  await projectLogApi.query('session', 'orders', query);
  expect(invoke).toHaveBeenCalledExactlyOnceWith('query_project_logs', { sessionId: 'session', query: { project: 'orders', ...query } });
});
it('uses typed scope and a separate hold token without supplying engine or command text', async () => {
  await observationApi.configure('session', { kind: 'project', name: 'orders' });
  expect(invoke).toHaveBeenLastCalledWith('configure_observation', { sessionId: 'session', scope: { kind: 'project', name: 'orders' } });
  await observationApi.hold('session');
  expect(invoke).toHaveBeenLastCalledWith('hold_observation', { sessionId: 'session' });
  await observationApi.release('session', 'hold');
  expect(invoke).toHaveBeenLastCalledWith('release_observation_hold', { sessionId: 'session', holdId: 'hold' });
});
it('retries events in the same session without configuring a new environment', async () => {
  await observationApi.retryEvents('session');
  expect(invoke).toHaveBeenCalledExactlyOnceWith('retry_observation_events', { sessionId: 'session' });
});
it('uses distinct standalone configure/query/retry commands without a project name or endpoint', async () => {
  const query = { sourceIds: ['old-full-id'], keyword: '', offset: null, limit: 160, throughSequence: 25,
    timeFrom: '2026-09-16T00:58:00Z', timeTo: '2026-09-16T01:02:00Z', anchorTime: '2026-09-16T01:00:00Z' };
  await standaloneLogApi.configure('session', ['opaque-handle']); await standaloneLogApi.query('session', query); await standaloneLogApi.retry('session');
  expect(vi.mocked(invoke).mock.calls).toEqual([
    ['configure_standalone_logs', { sessionId: 'session', handles: ['opaque-handle'] }],
    ['query_standalone_logs', { sessionId: 'session', query }], ['retry_standalone_logs', { sessionId: 'session' }],
  ]);
});
