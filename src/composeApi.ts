import { invoke, isTauri } from '@tauri-apps/api/core';
import type { CoreError } from './api';

export interface ComposeProjectInput {
  id?: string | null; expectedRevision?: number | null; name: string; composeFile: string; workingDirectory: string; envFile?: string | null;
}
export interface ComposeProject {
  id: string; revision: number; name: string; composeFile: string; workingDirectory: string; envFile: string | null;
}
export interface ComposeServicePreview { name: string; image: string | null; build: boolean; profiles: string[] }
export interface ComposeProjectPreview {
  previewId: string; project: ComposeProjectInput; composeVersion: string; services: ComposeServicePreview[];
  existingContainers: number; provenance: 'new' | 'matched';
}
export type ComposeAction = 'up' | 'stop';
export interface ComposePreparation {
  prepareId: string; project: ComposeProject; action: ComposeAction; composeVersion: string; services: ComposeServicePreview[];
  existingContainers: number; recreatePossible: boolean;
}
export interface ComposeOperation {
  id: string; sessionId: string; projectId: string; projectName: string; action: ComposeAction;
  phase: 'preparing' | 'running' | 'reconciling' | 'finished'; outcome: null | 'succeeded' | 'failed' | 'resultUnknown' | 'cancelledBeforeStart';
  cancelRequested: boolean; exitCode: number | null; startedAt: string; finishedAt: string | null;
  reconciliation: 'pending' | 'succeeded' | 'failed' | 'skipped'; observedContainers: number | null; error: CoreError | null;
}
export interface ComposeOperationRead { operation: ComposeOperation; text: string; oldestSequence: number; nextSequence: number; truncated: boolean }
/** Kept separate from container IPC so registration never invents container handles. */
export const composeApi = {
  available: () => isTauri(),
  pick: (kind: 'file' | 'directory' | 'env') => invoke<string | null>('pick_compose_path', { kind }),
  list: () => invoke<ComposeProject[]>('list_compose_projects'),
  preview: (sessionId: string, input: ComposeProjectInput) => invoke<ComposeProjectPreview>('preview_compose_project', { sessionId, input }),
  save: (previewId: string) => invoke<ComposeProject>('save_compose_project', { previewId }),
  remove: (projectId: string, expectedRevision: number) => invoke<void>('remove_compose_project', { projectId, expectedRevision }),
  prepare: (sessionId: string, projectId: string, expectedRevision: number, action: ComposeAction) => invoke<ComposePreparation>('prepare_compose_operation', { sessionId, projectId, expectedRevision, action }),
  start: (sessionId: string, prepareId: string, requestId: string) => invoke<ComposeOperation>('start_compose_operation', { sessionId, prepareId, requestId }),
  operations: (sessionId: string) => invoke<ComposeOperation[]>('list_compose_operations', { sessionId }),
  read: (sessionId: string, operationId: string, afterSequence: number) => invoke<ComposeOperationRead>('read_compose_operation', { sessionId, operationId, afterSequence }),
  cancel: (sessionId: string, operationId: string) => invoke<ComposeOperation>('cancel_compose_operation', { sessionId, operationId }),
};
