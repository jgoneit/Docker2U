import { api, type Container, type ContainerList } from '../api';
import { composeApi, type ComposeAction, type ComposeApplySelection, type ComposeOperation, type ComposePreparation, type ComposeProject, type ComposeProjectInput, type ComposeProjectPreview, type ComposeServicePreview, type ComposeStage } from '../composeApi';

/** Visual development fixture only: every Compose transport is replaced, no native command is run. */
export function installComposeFixture() {
  type Mode = 'success' | 'failed' | 'quiet';
  type ApplyMode = 'success' | 'pull-failed' | 'build-failed' | 'recreate-failed' | 'between-stages-cancelled';
  let mode = (new URLSearchParams(location.search).get('composeMode') ?? 'success') as Mode;
  let applyMode = (new URLSearchParams(location.search).get('applyMode') ?? 'success') as ApplyMode;
  const calls: Record<string, number> = {};
  const projects: ComposeProject[] = [];
  const previews = new Map<string, ComposeProjectPreview>();
  const preparations = new Map<string, ComposePreparation>();
  const jobs = new Map<string, { operation: ComposeOperation; mode: Mode; applyMode: ApplyMode; deadline: number }>();
  const started = new Map<string, ComposeOperation>();
  const synthetic = new Map<string, Container[]>();
  let sequence = 0;
  const services: ComposeServicePreview[] = [{ name: 'web', image: 'fixture.invalid/web:local', build: true, profiles: [] }, { name: 'db', image: 'fixture.invalid/db:local', build: false, profiles: [] }];
  const count = (key: string) => { calls[key] = (calls[key] ?? 0) + 1; };
  function stages(selections: ComposeApplySelection[]): ComposeStage[] {
    return (['pull', 'build', 'recreate'] as const).map(kind => {
      const names = selections.filter(item => kind === 'recreate' || item.preparation === kind).map(item => item.service);
      return { kind, services: names, status: names.length ? 'pending' : 'skipped', exitCode: null, error: null };
    });
  }
  let lastInventory: ContainerList | null = null;
  const originalDetails = api.getContainerDetails;
  const originalList = api.listContainers;
  Object.assign(api, { listContainers: async (sessionId: string) => {
    const result = await originalList(sessionId);
    lastInventory = { ...result, containers: [...result.containers, ...[...synthetic.values()].flat().map(item => ({ ...item, handle: `${sessionId}-${result.generation}-${item.fullId}` }))] };
    return lastInventory;
  } });
  api.getContainerDetails = async (sessionId, generation, handle) => {
    const target = lastInventory?.sessionId === sessionId && lastInventory.generation === generation
      ? lastInventory.containers.find(item => item.handle === handle && [...synthetic.values()].flat().some(row => row.fullId === item.fullId)) : null;
    if (!target) return originalDetails(sessionId, generation, handle);
    return { sessionId, generation, handle, fullId: target.fullId, observedAt: new Date().toISOString(),
      diagnostics: { state: target.state, exitCode: target.state === 'exited' ? 0 : null, startedAt: target.createdAt,
        finishedAt: target.state === 'exited' ? new Date().toISOString() : null, oomKilled: false, restartCount: 0,
        healthAvailable: true, healthConfigured: target.healthConfigured,
        health: target.health ? { status: target.health, failingStreak: target.health === 'unhealthy' ? 1 : 0, recentFailures: [] } : null },
      connectivity: { networkMode: 'bridge', portsAvailable: true, networksAvailable: true, ports: [], networks: [] } };
  };
  function settle(job: { operation: ComposeOperation; mode: Mode; applyMode: ApplyMode; deadline: number }) {
    const op = job.operation;
    if (op.phase === 'finished' || Date.now() < job.deadline) return;
    if (op.action === 'apply') {
      const failedKind = job.applyMode.endsWith('-failed') ? job.applyMode.replace('-failed', '') : null;
      let stopped = false;
      for (const stage of op.stages ?? []) {
        if (!stage.services.length) continue;
        if (stopped) { stage.status = 'skipped'; continue; }
        if (op.cancelRequested) {
          stage.status = 'resultUnknown'; stage.error = { code: 'ResultUnknown', message: 'Synthetic command interrupted. Accepted changes may remain.' }; stopped = true;
        } else if (stage.kind === failedKind) {
          stage.status = 'failed'; stage.exitCode = 1; stage.error = { code: 'CommandFailed', message: `Synthetic ${stage.kind} failed.` }; stopped = true;
        } else if (stage.kind === 'recreate' && job.applyMode === 'between-stages-cancelled') {
          stage.status = 'skipped'; stopped = true;
        } else { stage.status = 'succeeded'; stage.exitCode = 0; }
      }
      op.phase = 'finished'; op.finishedAt = new Date().toISOString(); op.reconciliation = 'succeeded';
      op.outcome = op.cancelRequested ? 'resultUnknown' : job.applyMode === 'between-stages-cancelled' ? 'cancelled' : failedKind ? 'failed' : 'succeeded';
      op.exitCode = op.outcome === 'succeeded' ? 0 : op.outcome === 'failed' ? 1 : null;
      op.error = op.stages?.find(stage => stage.error)?.error ?? null;
      const recreate = op.stages?.find(stage => stage.kind === 'recreate');
      if (recreate?.status === 'succeeded') {
        count('recreate');
        const old = synthetic.get(op.projectName) ?? [];
        const selected = new Set(op.selections?.map(item => item.service));
        const replacement = services.filter(service => selected.has(service.name)).map((service, index): Container => ({ handle: 'replaced-on-read', fullId: `${op.id}-${service.name}`.padEnd(64, 'f'), shortId: `${op.id}-${index}`, name: `${op.projectName}-${service.name}-1`, composeProject: op.projectName, composeService: service.name, state: 'running', image: service.image!, health: service.name === 'web' ? (new URLSearchParams(location.search).get('composeHealth') ?? 'healthy') : null, healthConfigured: service.name === 'web', ports: [], createdAt: op.startedAt }));
        synthetic.set(op.projectName, [...old.filter(item => !selected.has(item.composeService ?? '')), ...replacement]);
      }
      op.observedContainers = synthetic.get(op.projectName)?.length ?? 0;
      return;
    }
    op.phase = 'finished'; op.outcome = op.cancelRequested ? 'resultUnknown' : job.mode === 'failed' ? 'failed' : 'succeeded';
    op.exitCode = op.cancelRequested ? null : job.mode === 'failed' ? 1 : 0; op.finishedAt = new Date().toISOString(); op.reconciliation = 'succeeded';
    op.observedContainers = 2;
    if (op.outcome === 'failed') op.error = { code: 'ComposeFailed', message: 'Synthetic second service startup failed.' };
    synthetic.set(op.projectName, services.map((service, i) => ({ handle: 'replaced-on-read', fullId: `${op.projectId}-${service.name}`.padEnd(64, 'f'), shortId: `${op.projectId}-${i}`, name: `${op.projectName}-${service.name}-1`, composeProject: op.projectName, composeService: service.name, state: op.action === 'stop' || (op.outcome === 'failed' && i === 1) ? 'exited' : 'running', image: service.image!, health: i === 0 && op.action !== 'stop' ? (new URLSearchParams(location.search).get('composeHealth') ?? 'healthy') : null, healthConfigured: i === 0, ports: [], createdAt: op.startedAt })));
  }
  Object.assign(window, { __docker2uComposeFixture: { calls, setMode: (value: Mode) => { mode = value; }, setApplyMode: (value: ApplyMode) => { applyMode = value; }, finish: () => { for (const job of jobs.values()) job.deadline = 0; }, operations: () => [...jobs.values()].map(job => structuredClone(job.operation)), projects } });
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
    previewApply: async (_sessionId: string, projectId: string, revision: number) => {
      count('previewApply'); const project = projects.find(item => item.id === projectId && item.revision === revision);
      if (!project) throw { code: 'RegistrationChanged', message: 'Synthetic registration changed.' };
      return { project: structuredClone(project), composeVersion: 'Docker Compose fixture v2', services: services.map(service => ({ ...service, preparations: service.build ? ['pull', 'build', 'none'] as const : ['pull', 'none'] as const, blockedReason: null })).map(service => ({ ...service, preparations: [...service.preparations] })) };
    },
    prepare: async (_sessionId: string, projectId: string, revision: number, action: ComposeAction, selections?: ComposeApplySelection[]) => {
      count('prepare'); const project = projects.find(item => item.id === projectId && item.revision === revision); if (!project) throw { code: 'RegistrationChanged', message: 'Synthetic registration changed.' };
      if (action === 'apply' && (!selections?.length || selections.some(item => !services.some(service => service.name === item.service && (item.preparation !== 'build' || service.build))))) throw { code: 'InvalidApplySelection', message: 'Synthetic unsupported service selection.' };
      const value: ComposePreparation = { prepareId: `prepare-${++sequence}`, project: structuredClone(project), action, services, composeVersion: 'Docker Compose fixture v2', existingContainers: synthetic.get(project.name)?.length ?? 0, recreatePossible: action !== 'stop', selections: action === 'apply' ? structuredClone(selections!) : [], stages: action === 'apply' ? stages(selections!) : [], warnings: [] };
      preparations.set(value.prepareId, value); return structuredClone(value);
    },
    start: async (sessionId: string, prepareId: string, requestId: string) => {
      count('start'); if (started.has(requestId)) return structuredClone(started.get(requestId)!);
      const preparation = preparations.get(prepareId); if (!preparation) throw { code: 'PreparationExpired', message: 'Synthetic preparation expired.' };
      const operation: ComposeOperation = { id: `job-${++sequence}`, sessionId, requestId, selections: structuredClone(preparation.selections ?? []), stages: structuredClone(preparation.stages ?? []), warnings: structuredClone(preparation.warnings ?? []), projectId: preparation.project.id, projectName: preparation.project.name, action: preparation.action, phase: 'running', outcome: null, cancelRequested: false, exitCode: null, startedAt: new Date().toISOString(), finishedAt: null, reconciliation: 'pending', observedContainers: null, error: null };
      const running = operation.stages?.find(stage => stage.status === 'pending'); if (running) running.status = 'running';
      jobs.set(operation.id, { operation, mode, applyMode, deadline: mode === 'quiet' ? Infinity : Date.now() + 1800 }); started.set(requestId, operation); return structuredClone(operation);
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
