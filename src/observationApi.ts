import { invoke, isTauri } from '@tauri-apps/api/core';
import type { ContainerList, CoreError } from './api';
import type { ProjectFilter } from './projects';

export interface ResourcePoint {
  sequence: number; fullId: string; sampledAt: string; cpuPercent: number | null;
  memoryUsageBytes: number | null; memoryLimitBytes: number | null; available: boolean;
}
export interface ObservationEvent {
  sequence: number; fullId: string | null; name: string | null; composeProject: string | null;
  composeService: string | null; kind: string; occurredAt: string; observedAt: string; detail: string | null;
}
export interface ObservationRead {
  sessionId: string; sequence: number; scope: ProjectFilter; inventory: ContainerList | null;
  resources: ResourcePoint[]; events: ObservationEvent[]; resourceTruncated: boolean; eventTruncated: boolean;
  inventoryError: CoreError | null; statsError: CoreError | null; eventError: CoreError | null;
  resourceRetainedFrom?: string | null; eventRetainedFrom?: string | null;
  eventStatus: 'starting' | 'following' | 'retrying' | 'error' | 'stopped';
}
export interface ObservationHold { sessionId: string; holdId: string; inventory: ContainerList }
export const observationApi = {
  available: () => isTauri(),
  configure: (sessionId: string, scope: ProjectFilter) => invoke<ObservationRead>('configure_observation', { sessionId, scope }),
  read: (sessionId: string, afterSequence: number) => invoke<ObservationRead>('read_observation', { sessionId, afterSequence }),
  hold: (sessionId: string) => invoke<ObservationHold>('hold_observation', { sessionId }),
  retryEvents: (sessionId: string) => invoke<ObservationRead>('retry_observation_events', { sessionId }),
  release: (sessionId: string, holdId: string) => invoke<void>('release_observation_hold', { sessionId, holdId }),
};

export interface ProjectLogRow {
  rowId: string; sequence: number; sourceId: string; fullId: string; serviceName: string | null;
  containerName: string; timestamp: string | null; receivedAt: string; pipe: 'stdout' | 'stderr' | 'tty'; text: string; truncated: boolean;
}
export interface ProjectLogSource {
  sourceId: string; fullId: string; serviceName: string | null; containerName: string; selected: boolean;
  status: 'idle' | 'starting' | 'following' | 'retrying' | 'ended' | 'removed' | 'error'; error: CoreError | null; droppedRows: number; coverageGaps?: number;
}
export interface ProjectLogPage {
  sessionId: string; project: string; revision: number; maxSequence: number; rows: ProjectLogRow[]; sources: ProjectLogSource[];
  totalRows: number; offset: number; droppedRows: number; needsSelection: boolean; error: CoreError | null;
  retainedFrom: string | null; retainedTo: string | null; anchorLost?: boolean; coverageGaps?: number;
}
export interface ProjectLogQuery {
  sourceIds: string[]; keyword: string; offset: number | null; limit: number; throughSequence: number | null; anchorRowId?: string | null;
  afterSequence?: number | null;
}
export const projectLogApi = {
  configure: (sessionId: string, project: string, handles: string[] | null) => invoke<ProjectLogPage>('configure_project_logs', { sessionId, project, handles }),
  query: (sessionId: string, project: string, query: ProjectLogQuery) => invoke<ProjectLogPage>('query_project_logs', { sessionId, query: { project, ...query } }),
  stop: (sessionId: string) => invoke<void>('stop_project_logs', { sessionId }),
  retry: (sessionId: string) => invoke<ProjectLogPage>('retry_project_logs', { sessionId }),
};
