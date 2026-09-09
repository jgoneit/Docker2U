import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api, coreError, diagnosticsText } from './api';
import type { Environment } from './api';
import type { FrontendSession, SessionIssue } from './frontendSession';

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
    await expect(api.mutateContainers('session', 1, ['handle'], 'start')).rejects.toMatchObject({ code: 'NATIVE_REQUIRED' });
    await expect(api.getContainerDetails('session', 1, 'handle')).rejects.toMatchObject({ code: 'NATIVE_REQUIRED' });
    expect(native.invoke).not.toHaveBeenCalled();
  });

  it('sends only the typed session, opaque handle and action across IPC', async () => {
    native.invoke.mockResolvedValue({});
    await api.getEnvironment();
    await api.listContainers('session-a');
    await api.getRecentLogs('session-a', 'opaque-handle');
    await api.getContainerDetails('session-a', 7, 'opaque-handle');
    await api.mutateContainer('session-a', 'opaque-handle', 'restart');
    await api.mutateContainers('session-a', 7, ['opaque-a', 'opaque-b'], 'stop');
    expect(native.invoke.mock.calls).toEqual([
      ['get_environment', undefined],
      ['list_containers', { sessionId: 'session-a' }],
      ['get_recent_logs', { sessionId: 'session-a', handle: 'opaque-handle' }],
      ['get_container_details', { sessionId: 'session-a', generation: 7, handle: 'opaque-handle' }],
      ['mutate_container', { sessionId: 'session-a', handle: 'opaque-handle', action: 'restart' }],
      ['mutate_containers', { sessionId: 'session-a', generation: 7, handles: ['opaque-a', 'opaque-b'], action: 'stop' }],
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

  it('does not retry a bulk operation when its response is lost', async () => {
    const failure = new Error('WebView disconnected after dispatch');
    native.invoke.mockRejectedValue(failure);
    await expect(api.mutateContainers('session', 2, ['first', 'second'], 'restart')).rejects.toBe(failure);
    expect(native.invoke).toHaveBeenCalledExactlyOnceWith('mutate_containers', {
      sessionId: 'session', generation: 2, handles: ['first', 'second'], action: 'restart',
    });
  });
});

describe('diagnostics export', () => {
  it('exports frontend evidence without an environment and strips unknown nested fields', () => {
    const issue: SessionIssue & { message: string; stderr: string; sessionId: string } = {
      stage: 'connect', origin: 'exception', code: 'IPC_FAILURE', occurredAt: '2026-09-06T01:00:00Z', requiresReconnect: true, scope: 'current',
      message: 'message-secret', stderr: 'stderr-secret', sessionId: 'private-session',
    };
    const frontendSession: FrontendSession & { credentials: string } = {
      currentStatus: 'disconnected', effectiveMutationBlocked: true, reconnectRequired: false,
      inventoryStale: null, inventoryRefreshedAt: null, issue, credentials: 'credential-secret',
    };
    const exported = diagnosticsText(null, frontendSession);
    const parsed = JSON.parse(exported);
    expect(parsed).toMatchObject({ status: null, mutationAllowed: null, frontendSession: {
      currentStatus: 'disconnected', effectiveMutationBlocked: true, inventoryStale: null,
      issue: { code: 'IPC_FAILURE', origin: 'exception', occurredAt: issue.occurredAt },
    } });
    expect(Object.keys(parsed.frontendSession).sort()).toEqual(['currentStatus', 'effectiveMutationBlocked', 'reconnectRequired', 'inventoryStale', 'inventoryRefreshedAt', 'issue'].sort());
    expect(Object.keys(parsed.frontendSession.issue).sort()).toEqual(['stage', 'origin', 'code', 'occurredAt', 'requiresReconnect', 'scope'].sort());
    expect(exported).not.toMatch(/secret|private-session|credentials|stderr/);
  });

  it('copies the connection allowlist and excludes raw diagnostics and extra sensitive fields', () => {
    const environment: Environment & { credentials: string; logs: string } = {
      status: 'ready', sessionId: 'private-session', contextName: 'colima-docker2u',
      endpoint: 'unix:///local/docker.sock', dockerPath: '/tools/docker', dockerConfigPath: '/local/.docker',
      clientVersion: '29.8.0', serverVersion: '29.5.2', apiVersion: '1.54',
      engineId: 'engine-id', osType: 'linux', architecture: 'arm64', mutationAllowed: true,
      error: { code: 'Configuration', message: 'token=message-secret', command: 'command-secret', stderr: 'stderr-secret' }, diagnostics: ['token=diagnostic-secret'], credentials: 'credential-secret', logs: 'application-secret',
    };
    const exported = diagnosticsText(environment);
    const parsed: Record<string, unknown> = JSON.parse(exported);
    expect(parsed).toMatchObject({ app: 'Docker2U', contextName: 'colima-docker2u', serverVersion: '29.5.2', mutationAllowed: true });
    expect(Object.keys(parsed).sort()).toEqual([
      'app', 'version', 'status', 'contextName', 'endpoint', 'dockerPath', 'dockerConfigPath',
      'clientVersion', 'errorCode', 'serverVersion', 'apiVersion', 'engineId',
      'osType', 'architecture', 'mutationAllowed',
    ].sort());
    expect(exported).not.toMatch(/secret|private-session|credentials|diagnostics|logs/);
  });
});
