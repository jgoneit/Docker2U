import { invoke, isTauri } from '@tauri-apps/api/core';
import type { CoreError } from './api';

export interface ImageExportSource {
  sessionId: string; containerId: string; containerName: string; imageId: string; imageReference: string;
  engineName: string; engineEndpoint: string; engineId: string;
}
export interface ImageExportPreview extends ImageExportSource { prepareId: string; expiresAt: string }
export interface ImageExportDestination { destinationToken: string; path: string }
export interface ImageExportOperation extends ImageExportSource {
  id: string; requestId: string; path: string;
  phase: 'queued' | 'exporting' | 'publishing' | 'finished';
  outcome: null | 'succeeded' | 'failed' | 'cancelledBeforeStart' | 'cancelled' | 'timedOut';
  bytesWritten: number; elapsedMs: number; startedAt: string; finishedAt: string | null; exitCode: number | null;
  stderr: string; stderrTruncated: boolean; error: CoreError | null; cleanupWarning: string | null;
}
/** Native destination tokens bind user-selected files to the inspected image. */
export const imageExportApi = {
  available: () => isTauri(),
  prepare: (sessionId: string, generation: number, handle: string) => invoke<ImageExportPreview>('prepare_image_export', { sessionId, generation, handle }),
  pick: (sessionId: string, prepareId: string) => invoke<ImageExportDestination | null>('pick_image_export_destination', { sessionId, prepareId }),
  start: (sessionId: string, prepareId: string, destinationToken: string, requestId: string) => invoke<ImageExportOperation>('start_image_export', { sessionId, prepareId, destinationToken, requestId }),
  read: (sessionId: string, requestId: string) => invoke<ImageExportOperation>('read_image_export', { sessionId, requestId }),
  list: (sessionId: string) => invoke<ImageExportOperation[]>('list_image_exports', { sessionId }),
  cancel: (sessionId: string, requestId: string) => invoke<ImageExportOperation>('cancel_image_export', { sessionId, requestId }),
};

const phases = ['queued', 'exporting', 'publishing', 'finished'];
const outcomes = ['succeeded', 'failed', 'cancelledBeforeStart', 'cancelled', 'timedOut'];
export function validImageExportSource(value: ImageExportSource): boolean {
  return !!value && ['sessionId', 'containerId', 'containerName', 'imageId', 'imageReference', 'engineName', 'engineEndpoint', 'engineId'].every(key => typeof value[key as keyof ImageExportSource] === 'string')
    && !!value.sessionId && !!value.containerId && /^sha256:[a-f0-9]{64}$/.test(value.imageId);
}
export function validImageExportOperation(value: ImageExportOperation): boolean {
  return validImageExportSource(value) && typeof value.id === 'string' && !!value.id && typeof value.requestId === 'string' && !!value.requestId && typeof value.path === 'string'
    && phases.includes(value.phase) && (value.phase === 'finished' ? outcomes.includes(value.outcome ?? '') : value.outcome === null)
    && Number.isSafeInteger(value.bytesWritten) && value.bytesWritten >= 0 && Number.isSafeInteger(value.elapsedMs) && value.elapsedMs >= 0
    && typeof value.startedAt === 'string' && (value.finishedAt === null || typeof value.finishedAt === 'string')
    && (value.exitCode === null || Number.isInteger(value.exitCode)) && typeof value.stderr === 'string' && typeof value.stderrTruncated === 'boolean'
    && (value.cleanupWarning === null || typeof value.cleanupWarning === 'string') && (value.error === null || (typeof value.error?.code === 'string' && typeof value.error?.message === 'string'));
}
