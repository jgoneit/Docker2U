import { api, type Container } from '../api';
import { composeApi, type ComposeOperation, type ComposePreparation, type ComposeProject, type ComposeProjectInput, type ComposeProjectPreview, type ComposeServicePreview } from '../composeApi';

/** Visual development fixture only: every Compose transport is replaced, no native command is run. */
export function installComposeFixture() {
  type Mode = 'success' | 'failed' | 'quiet';
  let mode = (new URLSearchParams(location.search).get('composeMode') ?? 'success') as Mode;
  const calls: Record<string, number> = {};
  const projects: ComposeProject[] = [];
  const previews = new Map<string, ComposeProjectPreview>();
  const preparations = new Map<string, ComposePreparation>();
  const jobs = new Map<string, { operation: ComposeOperation; mode: Mode; deadline: number }>();
  const started = new Map<string, ComposeOperation>();
  const synthetic = new Map<string, Container[]>();
  let sequence = 0;
  const services: ComposeServicePreview[] = [{ name: 'web', image: 'fixture.invalid/web:local', build: true, profiles: [] }, { name: 'db', image: 'fixture.invalid/db:local', build: false, profiles: [] }];
  const count = (key: string) => { calls[key] = (calls[key] ?? 0) + 1; };
  const originalList = api.listContainers;
  Object.assign(api, { listContainers: async (sessionId: string) => {
    const result = await originalList(sessionId);
    return { ...result, containers: [...result.containers, ...[...synthetic.values()].flat().map(item => ({ ...item, handle: `${sessionId}-${result.generation}-${item.fullId}` }))] };
  } });
  function settle(job: { operation: ComposeOperation; mode: Mode; deadline: number }) {
    const op = job.operation;
    if (op.phase === 'finished' || Date.now() < job.deadline) return;
    op.phase = 'finished'; op.outcome = op.cancelRequested ? 'resultUnknown' : job.mode === 'failed' ? 'failed' : 'succeeded';
    op.exitCode = op.cancelRequested ? null : job.mode === 'failed' ? 1 : 0; op.finishedAt = new Date().toISOString(); op.reconciliation = 'succeeded';
    op.observedContainers = 2;
    if (op.outcome === 'failed') op.error = { code: 'ComposeFailed', message: 'Synthetic second service startup failed.' };
    synthetic.set(op.projectName, services.map((service, i) => ({ handle: 'replaced-on-read', fullId: `${op.projectId}-${service.name}`.padEnd(64, 'f'), shortId: `${op.projectId}-${i}`, name: `${op.projectName}-${service.name}-1`, composeProject: op.projectName, composeService: service.name, state: op.action === 'stop' || (op.outcome === 'failed' && i === 1) ? 'exited' : 'running', image: service.image!, health: null, ports: [], createdAt: op.startedAt })));
  }
  Object.assign(window, { __docker2uComposeFixture: { calls, setMode: (value: Mode) => { mode = value; }, finish: () => { for (const job of jobs.values()) job.deadline = 0; }, projects } });
  Object.assign(composeApi, {
    available: () => true,
    pick: async (kind: 'file' | 'directory' | 'env') => { count(`pick:${kind}`); return kind === 'file' ? '/synthetic/compose-demo/compose.yaml' : kind === 'directory' ? '/synthetic/compose-demo' : '/synthetic/compose-demo/.env'; },
    list: async () => { count('list'); return structuredClone(projects); },
    preview: async (_sessionId: string, input: ComposeProjectInput) => {
      count('preview');
      if (input.name === 'invalid') throw { code: 'InvalidComposeProject', message: 'Synthetic invalid Compose configuration.' };
      const project = { ...input, name: input.name || 'compose-demo', envFile: input.envFile ?? `${input.workingDirectory}/.env` };
      const value: ComposeProjectPreview = { previewId: `preview-${++sequence}`, project, composeVersion: 'Docker Compose fixture v2', services, existingContainers: input.name === 'orders' ? 2 : synthetic.get(project.name)?.length ?? 0, provenance: input.name === 'orders' ? 'matched' : 'new' };
      previews.set(value.previewId, value); return structuredClone(value);
    },
    save: async (previewId: string) => {
      count('save'); const preview = previews.get(previewId); if (!preview) throw { code: 'PreparationExpired', message: 'Synthetic preview expired.' };
      if (projects.some(item => item.name === preview.project.name && item.id !== preview.project.id)) throw { code: 'DuplicateProject', message: 'Synthetic duplicate project name.' };
      const project: ComposeProject = { id: preview.project.id ?? `project-${++sequence}`, revision: (preview.project.expectedRevision ?? 0) + 1, name: preview.project.name, composeFile: preview.project.composeFile, workingDirectory: preview.project.workingDirectory, envFile: preview.project.envFile ?? null };
      const old = projects.findIndex(item => item.id === project.id); if (old >= 0) projects.splice(old, 1);
      projects.push(project); return structuredClone(project);
    },
    remove: async (projectId: string, revision: number) => { count('remove'); const index = projects.findIndex(item => item.id === projectId && item.revision === revision); if (index < 0) throw { code: 'RegistrationChanged', message: 'Synthetic registration changed.' }; projects.splice(index, 1); },
    prepare: async (_sessionId: string, projectId: string, revision: number, action: 'up' | 'stop') => {
      count('prepare'); const project = projects.find(item => item.id === projectId && item.revision === revision); if (!project) throw { code: 'RegistrationChanged', message: 'Synthetic registration changed.' };
      const value: ComposePreparation = { prepareId: `prepare-${++sequence}`, project: structuredClone(project), action, services, composeVersion: 'Docker Compose fixture v2', existingContainers: synthetic.get(project.name)?.length ?? 0, recreatePossible: action === 'up' };
      preparations.set(value.prepareId, value); return structuredClone(value);
    },
    start: async (sessionId: string, prepareId: string, requestId: string) => {
      count('start'); if (started.has(requestId)) return structuredClone(started.get(requestId)!);
      const preparation = preparations.get(prepareId); if (!preparation) throw { code: 'PreparationExpired', message: 'Synthetic preparation expired.' };
      const operation: ComposeOperation = { id: `job-${++sequence}`, sessionId, projectId: preparation.project.id, projectName: preparation.project.name, action: preparation.action, phase: 'running', outcome: null, cancelRequested: false, exitCode: null, startedAt: new Date().toISOString(), finishedAt: null, reconciliation: 'pending', observedContainers: null, error: null };
      jobs.set(operation.id, { operation, mode, deadline: mode === 'quiet' ? Infinity : Date.now() + 1800 }); started.set(requestId, operation); return structuredClone(operation);
    },
    operations: async (_sessionId: string) => { count('operations'); return [...jobs.values()].map(job => structuredClone(job.operation)); },
    read: async (sessionId: string, operationId: string, afterSequence: number) => {
      count('read'); const job = jobs.get(operationId); if (!job || job.operation.sessionId !== sessionId) throw { code: 'StaleSession', message: 'Synthetic old Compose job.' };
      settle(job);
      const finished = job.operation.phase === 'finished';
      const lines = job.mode === 'quiet' ? [] : ['Synthetic Compose output: web Preparing\n', ...(finished ? [`Synthetic Compose output: ${job.operation.outcome}\n`] : [])];
      return { operation: structuredClone(job.operation), text: lines.slice(afterSequence).join(''), oldestSequence: 1, nextSequence: lines.length, truncated: false };
    },
    cancel: async (sessionId: string, operationId: string) => { count('cancel'); const job = jobs.get(operationId); if (!job || job.operation.sessionId !== sessionId) throw { code: 'StaleSession', message: 'Synthetic old Compose job.' }; job.operation.cancelRequested = true; job.deadline = Date.now() + 500; return structuredClone(job.operation); },
  } satisfies typeof composeApi);
}
