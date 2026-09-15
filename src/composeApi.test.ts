import { beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { composeApi } from './composeApi';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: vi.fn(() => true) }));
beforeEach(() => vi.clearAllMocks());

it('previews apply eligibility using the registered project and current session only', async () => {
  await composeApi.previewApply('session', 'project', 4);
  expect(invoke).toHaveBeenCalledExactlyOnceWith('preview_compose_apply', { sessionId: 'session', projectId: 'project', expectedRevision: 4 });
});
it('sends typed service and image preparation choices while launch receives only the reviewed token', async () => {
  const selections = [{ service: 'web', preparation: 'build' as const }, { service: 'db', preparation: 'none' as const }];
  await composeApi.prepare('session', 'project', 4, 'apply', selections);
  expect(invoke).toHaveBeenLastCalledWith('prepare_compose_operation', { sessionId: 'session', projectId: 'project', expectedRevision: 4, action: 'apply', selections });
  await composeApi.start('session', 'prepared', 'request');
  expect(invoke).toHaveBeenLastCalledWith('start_compose_operation', { sessionId: 'session', prepareId: 'prepared', requestId: 'request' });
});
it.each(['up', 'stop'] as const)('preserves the existing %s IPC input without apply options', async action => {
  await composeApi.prepare('session', 'project', 4, action);
  expect(invoke).toHaveBeenCalledExactlyOnceWith('prepare_compose_operation', { sessionId: 'session', projectId: 'project', expectedRevision: 4, action });
});
