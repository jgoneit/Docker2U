import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api, coreError, diagnosticsText } from './api';
import type { Environment } from './api';

const native = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => native);

beforeEach(() => {
  native.invoke.mockReset();
  native.isTauri.mockReturnValue(true);
});

describe('native IPC boundary', () => {
  it('requires the native app and never simulates a browser connection', async () => {
    native.isTauri.mockReturnValue(false);
    await expect(api.getEnvironment()).rejects.toMatchObject({ code: 'NATIVE_REQUIRED' });
    await expect(api.mutateContainer('session', 'handle', 'start')).rejects.toMatchObject({ code: 'NATIVE_REQUIRED' });
    expect(native.invoke).not.toHaveBeenCalled();
  });

  it('sends only the typed session, opaque handle and action across IPC', async () => {
    native.invoke.mockResolvedValue({});
    await api.getEnvironment();
    await api.listContainers('session-a');
    await api.getRecentLogs('session-a', 'opaque-handle');
    await api.mutateContainer('session-a', 'opaque-handle', 'restart');
    expect(native.invoke.mock.calls).toEqual([
      ['get_environment', undefined],
      ['list_containers', { sessionId: 'session-a' }],
      ['get_recent_logs', { sessionId: 'session-a', handle: 'opaque-handle' }],
      ['mutate_container', { sessionId: 'session-a', handle: 'opaque-handle', action: 'restart' }],
    ]);
  });

  it('preserves native rejection without retrying a mutation', async () => {
    const failure = { code: 'WorkerFailed', message: 'Native worker interrupted' };
    native.invoke.mockRejectedValue(failure);
    await expect(api.mutateContainer('session', 'handle', 'stop')).rejects.toBe(failure);
    expect(native.invoke).toHaveBeenCalledTimes(1);
    expect(coreError(failure)).toBe(failure);
  });

  it('classifies an unstructured transport error as an IPC failure', () => {
    expect(coreError(new Error('WebView disconnected'))).toEqual({ code: 'IPC_FAILURE', message: 'WebView disconnected' });
    expect(coreError(null).code).toBe('IPC_FAILURE');
    expect(coreError({ code: 42, message: 'invalid error' }).code).toBe('IPC_FAILURE');
  });
});

describe('diagnostics export', () => {
  it('copies the connection allowlist and excludes raw diagnostics and extra sensitive fields', () => {
    const environment: Environment & { credentials: string; logs: string } = {
      status: 'ready', sessionId: 'private-session', profile: 'colima-docker2u',
      endpoint: 'unix:///local/docker.sock', dockerPath: '/tools/docker', colimaPath: '/tools/colima',
      clientVersion: '29.8.0', runtimeVersion: '0.10.3', serverVersion: '29.5.2', apiVersion: '1.54',
      engineId: 'engine-id', osType: 'linux', architecture: 'arm64', mutationAllowed: true,
      diagnostics: ['token=diagnostic-secret'], credentials: 'credential-secret', logs: 'application-secret',
    };
    const exported = diagnosticsText(environment);
    const parsed: Record<string, unknown> = JSON.parse(exported);
    expect(parsed).toMatchObject({ app: 'Docker2U', profile: 'colima-docker2u', serverVersion: '29.5.2', mutationAllowed: true });
    expect(Object.keys(parsed).sort()).toEqual([
      'app', 'version', 'status', 'profile', 'endpoint', 'dockerPath', 'colimaPath',
      'clientVersion', 'runtimeVersion', 'serverVersion', 'apiVersion', 'engineId',
      'osType', 'architecture', 'mutationAllowed',
    ].sort());
    expect(exported).not.toMatch(/secret|private-session|credentials|diagnostics|logs/);
  });
});
