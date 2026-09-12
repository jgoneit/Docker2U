import { beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { observationApi, projectLogApi } from './observationApi';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: () => true }));
beforeEach(() => vi.resetAllMocks());
it('sends the bounded project log query as the Rust command query DTO', async () => {
  const query = { sourceIds: ['full-id'], keyword: 'Error[DB]', offset: 120, limit: 160, throughSequence: 500, anchorRowId: 'row-9' };
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
