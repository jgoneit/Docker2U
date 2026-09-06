import { invoke, isTauri } from '@tauri-apps/api/core';
import { frontendError } from './frontendErrors';

export type Action = 'start' | 'stop' | 'restart';
export interface Environment {
  status: 'ready' | 'unavailable' | 'unsupported';
  sessionId: string | null;
  contextName: string | null;
  endpoint: string | null;
  dockerPath: string | null;
  dockerConfigPath: string | null;
  clientVersion: string | null;
  serverVersion: string | null;
  apiVersion: string | null;
  engineId: string | null;
  osType: string | null;
  architecture: string | null;
  mutationAllowed: boolean;
  error: CoreError | null;
  diagnostics: string[];
}
export type ConnectionTarget = Pick<Environment, 'contextName' | 'endpoint' | 'engineId'>;
export interface Container {
  handle: string;
  fullId: string;
  shortId: string;
  name: string;
  image: string;
  state: string;
  health: string | null;
  ports: string[];
  createdAt: string;
}
export interface ContainerList {
  sessionId: string;
  generation: number;
  containers: Container[];
  refreshedAt: string;
  stale: boolean;
}
export interface RecentLogs {
  sessionId: string;
  generation: number;
  handle: string;
  text: string;
  truncated: boolean;
  byteCount: number;
  command: string;
  stderr: string;
}
export interface MutationResult {
  outcome: 'succeeded' | 'failed' | 'resultUnknown';
  message: string;
  command: string;
  stderr: string;
  reconciliation: 'succeeded' | 'failed' | 'notNeeded';
  mutationBlocked: boolean;
  exitCode?: number | null;
  durationMs?: number;
  observedState?: string | null;
}
export interface BulkMutationItem {
  handle: string;
  fullId: string;
  name: string;
  outcome: MutationResult['outcome'] | 'skipped' | 'notExecuted';
  message: string;
  result?: MutationResult | null;
  error?: CoreError | null;
}
export interface BulkMutationResult {
  sessionId: string;
  generation: number;
  action: Action;
  items: BulkMutationItem[];
  mutationBlocked: boolean;
}
export interface CoreError { code: string; message: string; command?: string; stderr?: string }
export function coreError(error: unknown): CoreError {
  if (typeof error === 'object' && error !== null && 'code' in error && 'message' in error
      && typeof error.code === 'string' && typeof error.message === 'string') return error as CoreError;
  return error instanceof Error ? { code: 'IPC_FAILURE', message: error.message } : frontendError('ipcFailure');
}
async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw frontendError('nativeRequired');
  return invoke<T>(command, args);
}
export const api = {
  getEnvironment: () => call<Environment>('get_environment'),
  listContainers: (sessionId: string) => call<ContainerList>('list_containers', { sessionId }),
  getRecentLogs: (sessionId: string, handle: string) => call<RecentLogs>('get_recent_logs', { sessionId, handle }),
  mutateContainer: (sessionId: string, handle: string, action: Action) => call<MutationResult>('mutate_container', { sessionId, handle, action }),
  mutateContainers: (sessionId: string, generation: number, handles: string[], action: Action) => call<BulkMutationResult>('mutate_containers', { sessionId, generation, handles, action }),
};
// Explicit allowlist: no output, logs, credentials, or ambient environment.
export function diagnosticsText(environment: Environment): string {
  return JSON.stringify({
    app: 'Docker2U', version: '0.1.0-alpha.1', status: environment.status, contextName: environment.contextName,
    endpoint: environment.endpoint, dockerPath: environment.dockerPath, dockerConfigPath: environment.dockerConfigPath,
    clientVersion: environment.clientVersion, errorCode: environment.error?.code ?? null,
    serverVersion: environment.serverVersion, apiVersion: environment.apiVersion, engineId: environment.engineId,
    osType: environment.osType, architecture: environment.architecture, mutationAllowed: environment.mutationAllowed,
  }, null, 2);
}
