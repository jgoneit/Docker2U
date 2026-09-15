import { api, type ContainerList } from '../api';
import { imageExportApi, type ImageExportOperation, type ImageExportPreview } from '../imageExportApi';

/** Synthetic browser transport. It never opens a native picker or writes an archive. */
export function installImageExportFixture() {
  type Mode = 'success' | 'failed' | 'quiet' | 'timedOut' | 'lost-reply' | 'picker-cancel' | 'cleanup-warning';
  let mode = (new URLSearchParams(location.search).get('imageExportMode') ?? 'success') as Mode;
  const calls: Record<string, number> = {};
  const previews = new Map<string, ImageExportPreview>();
  const destinations = new Map<string, { prepareId: string; path: string }>();
  const jobs = new Map<string, { operation: ImageExportOperation; deadline: number; mode: Mode }>();
  let inventory: ContainerList | null = null, sequence = 0;
  const count = (name: string) => { calls[name] = (calls[name] ?? 0) + 1; };
  const originalList = api.listContainers;
  api.listContainers = async sessionId => { const result = await originalList(sessionId); inventory = result; return result; };
  const unavailable = () => ({ code: 'ImageExportUnavailable', message: 'Synthetic export request was not found.' });
  function settle(job: { operation: ImageExportOperation; deadline: number; mode: Mode }) {
    const value = job.operation;
    if (value.phase === 'finished') return;
    value.elapsedMs = Math.max(value.elapsedMs, Date.now() - Date.parse(value.startedAt));
    value.bytesWritten = Math.max(value.bytesWritten, 4096 + Math.floor(value.elapsedMs / 100) * 512);
    if (Date.now() < job.deadline) return;
    value.phase = 'finished'; value.finishedAt = new Date().toISOString();
    value.outcome = job.mode === 'failed' || job.mode === 'cleanup-warning' ? 'failed' : job.mode === 'timedOut' ? 'timedOut' : 'succeeded';
    value.exitCode = value.outcome === 'succeeded' ? 0 : 1;
    if (value.outcome !== 'succeeded') { value.error = { code: 'ImageExportFailed', message: 'Synthetic image archive could not be saved.' }; value.stderr = 'Synthetic image save failed'; }
    if (job.mode === 'cleanup-warning') value.cleanupWarning = 'Synthetic temporary archive cleanup could not be confirmed.';
  }
  Object.assign(window, { __docker2uImageExportFixture: { calls, setMode: (value: Mode) => { mode = value; }, finish: () => { for (const job of jobs.values()) job.deadline = 0; }, operations: () => [...jobs.values()].map(job => structuredClone(job.operation)) } });
  Object.assign(imageExportApi, {
    available: () => true,
    prepare: async (sessionId: string, generation: number, handle: string) => {
      count('prepare'); const container = inventory?.sessionId === sessionId && inventory.generation === generation ? inventory.containers.find(item => item.handle === handle) : null;
      if (!container) throw { code: 'StaleHandle', message: 'Synthetic container selection is stale.' };
      const value: ImageExportPreview = { prepareId: `image-preview-${++sequence}`, sessionId, containerId: container.fullId, containerName: container.name, imageId: `sha256:${'a'.repeat(64)}`, imageReference: container.image, engineName: 'Synthetic Engine', engineEndpoint: 'unix:///synthetic/docker.sock', engineId: 'synthetic-engine', expiresAt: new Date(Date.now() + 300_000).toISOString() };
      previews.set(value.prepareId, value); return structuredClone(value);
    },
    pick: async (sessionId: string, prepareId: string) => {
      count('pick'); const preview = previews.get(prepareId);
      if (!preview || preview.sessionId !== sessionId) throw { code: 'ImageExportPreparationExpired', message: 'Synthetic image preview expired.' };
      if (mode === 'picker-cancel') return null;
      const destinationToken = `image-destination-${++sequence}`, path = `/synthetic/exports/${preview.containerName}.tar`;
      destinations.set(destinationToken, { prepareId, path }); return { destinationToken, path };
    },
    start: async (sessionId: string, prepareId: string, destinationToken: string, requestId: string) => {
      count('start'); const old = jobs.get(requestId); if (old) return structuredClone(old.operation);
      const preview = previews.get(prepareId), destination = destinations.get(destinationToken);
      if (!preview || preview.sessionId !== sessionId) throw { code: 'ImageExportPreparationExpired', message: 'Synthetic image preview expired.' };
      if (!destination || destination.prepareId !== prepareId) throw { code: 'ImageExportDestinationUnavailable', message: 'Synthetic export destination is unavailable.' };
      const operation: ImageExportOperation = { ...preview, id: `image-export-${++sequence}`, requestId, path: destination.path, phase: 'exporting', outcome: null, bytesWritten: 4096, elapsedMs: 0, startedAt: new Date().toISOString(), finishedAt: null, exitCode: null, stderr: '', stderrTruncated: false, error: null, cleanupWarning: null };
      jobs.set(requestId, { operation, deadline: mode === 'quiet' ? Infinity : Date.now() + 1800, mode });
      if (mode === 'lost-reply') throw new Error('Synthetic lost export start reply');
      return structuredClone(operation);
    },
    list: async (_sessionId: string) => { count('list'); return [...jobs.values()].slice(-10).reverse().map(job => structuredClone(job.operation)); },
    read: async (sessionId: string, requestId: string) => { count('read'); const job = jobs.get(requestId); if (!job || job.operation.sessionId !== sessionId) throw unavailable(); settle(job); return structuredClone(job.operation); },
    cancel: async (sessionId: string, requestId: string) => {
      count('cancel'); const job = jobs.get(requestId); if (!job || job.operation.sessionId !== sessionId) throw unavailable();
      if (job.operation.phase !== 'finished') { job.operation.phase = 'finished'; job.operation.outcome = 'cancelled'; job.operation.finishedAt = new Date().toISOString(); }
      return structuredClone(job.operation);
    },
  } satisfies typeof imageExportApi);
}
