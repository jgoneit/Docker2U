import { invoke, isTauri } from '@tauri-apps/api/core';
import { frontendError } from './frontendErrors';
import { sessionDiagnostics, type FrontendSession } from './frontendSession';
import type { ContainerDetails } from './containerDetailsTypes';
export type { ContainerDetails } from './containerDetailsTypes';

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
  healthConfigured: boolean | null;
  ports: string[];
  createdAt: string;
  startedAt?: string | null;
  composeProject: string | null;
  composeService: string | null;
}
export interface LogStreamStart { sessionId: string; streamId: string; fullId: string }
export interface LogStreamRead {
  sessionId: string; streamId: string; sequence: number; text: string;
  truncated: boolean; terminal: boolean; error: CoreError | null;
}
export interface ContainerStatsItem {
  handle: string; fullId: string; cpuPercent: number | null;
  memoryUsage: string | null; memoryPercent: number | null; available: boolean;
  memoryUsageBytes?: number | null; memoryLimitBytes?: number | null;
}
export interface ContainerStats {
  sessionId: string; generation: number; sampledAt: string;
  items: ContainerStatsItem[]; error: CoreError | null;
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
  startLogStream: (sessionId: string, generation: number, handle: string) => call<LogStreamStart>('start_log_stream', { sessionId, generation, handle }),
  readLogStream: (sessionId: string, streamId: string) => call<LogStreamRead>('read_log_stream', { sessionId, streamId }),
  stopLogStream: (sessionId: string, streamId: string) => call<void>('stop_log_stream', { sessionId, streamId }),
  getContainerStats: (sessionId: string, generation: number, handles: string[]) => call<ContainerStats>('get_container_stats', { sessionId, generation, handles }),
  getContainerDetails: (sessionId: string, generation: number, handle: string) => call<ContainerDetails>('get_container_details', { sessionId, generation, handle }),
  mutateContainer: (sessionId: string, handle: string, action: Action) => call<MutationResult>('mutate_container', { sessionId, handle, action }),
  mutateContainers: (sessionId: string, generation: number, handles: string[], action: Action) => call<BulkMutationResult>('mutate_containers', { sessionId, generation, handles, action }),
};
// Explicit allowlist: no output, logs, credentials, or ambient environment.
export function diagnosticsText(environment: Environment | null, frontendSession?: FrontendSession): string {
  return JSON.stringify({
    app: 'Docker2U', version: '0.1.0-alpha.1', status: environment?.status ?? null, contextName: environment?.contextName ?? null,
    endpoint: environment?.endpoint ?? null, dockerPath: environment?.dockerPath ?? null, dockerConfigPath: environment?.dockerConfigPath ?? null,
    clientVersion: environment?.clientVersion ?? null, errorCode: environment?.error?.code ?? null,
    serverVersion: environment?.serverVersion ?? null, apiVersion: environment?.apiVersion ?? null, engineId: environment?.engineId ?? null,
    osType: environment?.osType ?? null, architecture: environment?.architecture ?? null, mutationAllowed: environment?.mutationAllowed ?? null,
    ...(frontendSession ? { frontendSession: sessionDiagnostics(frontendSession) } : {}),
  }, null, 2);
}
