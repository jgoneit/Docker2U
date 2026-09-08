import type { Action, BulkMutationResult, Container, ContainerList, CoreError, Environment, MutationResult, RecentLogs } from '../api';

// This entry is reached only from visual.html; production main never imports it.
// Do not mount App until every API method has been replaced with an in-memory fake.
if (import.meta.env.DEV) {
  const scenarios = {
    live: 'Live — continuous bilingual output',
    normal: 'Normal — 300 bilingual log lines',
    'dense-logs': 'Dense 2 MiB logs — exact search stress case',
    'long-metadata': 'Long container name, image and 24 published ports',
    'empty-logs': 'Empty logs',
    'loading-logs': 'Logs loading (held pending)',
    'held-connection-error': 'Held log connection failure — confirmation feedback',
    'log-error': 'Log read error',
    truncated: 'Truncated logs',
    'empty-inventory': 'Empty container list',
    'connection-error': 'Connection error',
    'failed-result': 'Failed result — use a recovery action',
    'unknown-result': 'Unknown result — use a recovery action',
  } as const;
  type Scenario = keyof typeof scenarios;
  const query = new URLSearchParams(window.location.search);
  const requested = query.get('scenario') ?? 'normal';
  const scenario: Scenario = Object.hasOwn(scenarios, requested) ? requested as Scenario : 'normal';
  const toolbar = document.getElementById('visual-toolbar');
  const root = document.getElementById('visual-app');
  if (!toolbar || !root) throw new Error('Visual fixture mount points are missing.');

  if (query.get('toolbar') !== 'hidden') {
    toolbar.hidden = false;
    const heading = document.createElement('strong');
    heading.textContent = 'DEV FIXTURE · 합성 데이터 · No Docker connection';
    const label = document.createElement('label');
    label.textContent = 'Scenario';
    const select = document.createElement('select');
    for (const [value, text] of Object.entries(scenarios)) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      select.append(option);
    }
    select.value = scenario;
    select.addEventListener('change', () => {
      const next = new URL(window.location.href);
      next.searchParams.set('scenario', select.value);
      window.location.assign(next);
    });
    label.append(select);
    const fullViewport = document.createElement('a');
    const fullViewportUrl = new URL(window.location.href);
    fullViewportUrl.searchParams.set('toolbar', 'hidden');
    fullViewport.href = fullViewportUrl.toString();
    fullViewport.textContent = 'Full viewport (same fixture; Back restores controls)';
    const note = document.createElement('span');
    note.textContent = 'All recovery actions simulate results only.';
    toolbar.append(heading, label, fullViewport, note);
  }

  const { api } = await import('../api');
  const { StrictMode } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const baseContainers: Container[] = [
    {
      handle: 'visual-backend', fullId: 'a'.repeat(64), shortId: 'a'.repeat(12),
      name: 'backend-주문처리-api-development',
      image: 'fixture.invalid/team/long-service-image-name:development-build-2026-09-06',
      state: 'running', health: 'healthy',
      ports: ['127.0.0.1:18080->8080/tcp', '[::1]:18443->8443/tcp', '127.0.0.1:19090->9090/tcp'],
      composeProject: null, composeService: null, createdAt: '2026-09-06T00:00:00Z',
    },
    {
      handle: 'visual-redis', fullId: 'b'.repeat(64), shortId: 'b'.repeat(12),
      name: 'redis-캐시-stopped', image: 'fixture.invalid/redis:7', state: 'exited', health: 'none',
      ports: [], composeProject: null, composeService: null, createdAt: '2026-09-06T00:00:00Z',
    },
    {
      handle: 'visual-worker', fullId: 'c'.repeat(64), shortId: 'c'.repeat(12),
      name: 'worker-상태확인-required', image: 'fixture.invalid/worker:development',
      state: 'running', health: 'unhealthy', ports: ['127.0.0.1:19091->9091/tcp'],
      composeProject: null, composeService: null, createdAt: '2026-09-06T00:00:00Z',
    },
    {
      handle: 'visual-paused', fullId: 'd'.repeat(64), shortId: 'd'.repeat(12),
      name: 'scheduler-일시정지-paused', image: 'fixture.invalid/scheduler:development',
      state: 'paused', health: null, ports: [], composeProject: null, composeService: null, createdAt: '2026-09-06T00:00:00Z',
    },
  ];
  baseContainers[0]!.composeProject = 'orders'; baseContainers[0]!.composeService = 'api';
  baseContainers[1]!.composeProject = 'orders'; baseContainers[1]!.composeService = 'redis';
  baseContainers[2]!.composeProject = 'workers'; baseContainers[2]!.composeService = 'worker';
  if (scenario === 'long-metadata' && baseContainers[0]) {
    baseContainers[0].name = `backend-${'주문처리-service-'.repeat(12)}development`;
    baseContainers[0].image = `fixture.invalid/${'very-long-service-segment/'.repeat(14)}image:development`;
    baseContainers[0].ports = Array.from({ length: 24 }, (_, index) => `127.0.0.1:${18080 + index}->${8080 + index}/tcp`);
  }
  const logText = Array.from({ length: 300 }, (_, index) => {
    const line = String(index + 1).padStart(3, '0');
    if (index === 299) return '[300] END OF FIXTURE LOG · 마지막 로그 줄 확인 · LAST_LINE_300';
    if (index === 147) return `[${line}] Long request path /합성-요청/${'segment-'.repeat(50)} trace=fixture-only`;
    return `[${line}] 2026-09-06T00:00:${String(index % 60).padStart(2, '0')}Z INFO 요청 처리 완료 · Request processed · synthetic=true`;
  }).join('\n');
  let connection = 0;
  let sessionId = '';
  let generation = 0;
  let containers = structuredClone(baseContainers);
  let snapshot: ContainerList | null = null;
  let heldLogFailure: ((error: CoreError) => void) | undefined;
  let holdNextLogs = scenario === 'held-connection-error';
  if (holdNextLogs) Object.assign(window, {
    __docker2uRejectLogs: () => {
      if (!heldLogFailure) throw new Error('No synthetic log request is waiting.');
      heldLogFailure({ code: 'SocketMissing', message: 'Synthetic socket disappeared after log view invalidation.' });
      heldLogFailure = undefined;
    },
  });
  function reject(code: string, message: string): never {
    throw { code, message } satisfies CoreError;
  }
  function requireSession(id: string) {
    if (!sessionId || id !== sessionId) reject('StaleSession', 'Synthetic session was replaced.');
  }
  function targetFor(handle: string): Container {
    const target = snapshot?.containers.find(container => container.handle === handle);
    if (!target) return reject('StaleHandle', 'Synthetic target is not in the current list.');
    return target;
  }
  function canApply(container: Container, action: Action) {
    return action === 'start' ? ['created', 'exited'].includes(container.state) : container.state === 'running';
  }
  function resultFor(target: Container, action: Action): MutationResult {
    if (!canApply(target, action)) return reject('ActionUnavailable', 'Synthetic action is unavailable in this state.');
    const outcome = scenario === 'failed-result' ? 'failed' : scenario === 'unknown-result' ? 'resultUnknown' : 'succeeded';
    if (outcome === 'succeeded') {
      const current = containers.find(container => container.fullId === target.fullId);
      if (current) current.state = action === 'stop' ? 'exited' : 'running';
    }
    return {
      outcome,
      message: outcome === 'succeeded' ? 'Synthetic command completed.' : outcome === 'failed' ? 'Synthetic Engine error; no command was executed.' : 'Synthetic result is unknown; no command was executed or retried.',
      command: `[SIMULATED ONLY] container ${action} ${target.fullId}`,
      stderr: outcome === 'failed' ? 'Synthetic failure detail for contrast and wrapping verification.' : '',
      reconciliation: 'succeeded', mutationBlocked: false,
      exitCode: outcome === 'resultUnknown' ? null : outcome === 'failed' ? 1 : 0,
      durationMs: 0, observedState: containers.find(container => container.fullId === target.fullId)?.state ?? target.state,
    };
  }
  let streamNumber = 0;
  const streams = new Map<string, { sessionId: string; sequence: number; initial: RecentLogs | null }>();
  const fixtureApi: typeof api = {
    getEnvironment: async (): Promise<Environment> => {
      sessionId = `visual-session-${++connection}`;
      generation = 0;
      snapshot = null;
      containers = structuredClone(baseContainers);
      const unavailable = scenario === 'connection-error';
      return {
        status: unavailable ? 'unavailable' : 'ready', sessionId: unavailable ? null : sessionId,
        contextName: 'visual-fixture-local', endpoint: 'unix:///visual-fixture/no-socket.sock',
        dockerPath: '/visual-fixture/no-docker-binary', dockerConfigPath: '/visual-fixture/no-config',
        clientVersion: 'fixture', serverVersion: 'fixture', apiVersion: 'fixture', engineId: 'visual-engine',
        osType: 'linux', architecture: 'aarch64', mutationAllowed: !unavailable,
        error: unavailable ? { code: 'SocketMissing', message: 'Synthetic socket missing; there is no Docker connection.', command: '[SIMULATED ONLY] environment check', stderr: 'Synthetic diagnostic detail.' } : null,
        diagnostics: ['Synthetic development data. No Docker CLI or Engine is connected.'],
      };
    },
    listContainers: async (id): Promise<ContainerList> => {
      requireSession(id);
      const nextGeneration = ++generation;
      snapshot = {
        sessionId: id, generation: nextGeneration,
        containers: scenario === 'empty-inventory' ? [] : containers.map(container => ({ ...container, handle: `${container.handle}-g${nextGeneration}` })),
        refreshedAt: '2026-09-06T00:12:34Z', stale: false,
      };
      return structuredClone(snapshot);
    },
    getRecentLogs: async (id, handle): Promise<RecentLogs> => {
      requireSession(id);
      targetFor(handle);
      if (holdNextLogs) {
        holdNextLogs = false;
        return new Promise<RecentLogs>((_resolve, reject) => { heldLogFailure = reject; });
      }
      if (scenario === 'loading-logs') return new Promise<RecentLogs>(() => {});
      if (scenario === 'log-error') throw {
        code: 'LogsUnavailable',
        message: Array.from({ length: 40 }, (_, index) => `Synthetic logging diagnostic ${index + 1}: no Docker connection. ${index === 39 ? 'LAST_ERROR_LINE' : ''}`).join('\n'),
        command: '[SIMULATED ONLY] recent logs failure',
        stderr: Array.from({ length: 40 }, (_, index) => `Synthetic stderr ${index + 1}: logging driver detail. ${index === 39 ? 'LAST_STDERR_LINE' : ''}`).join('\n'),
      } satisfies CoreError;
      const text = scenario === 'empty-logs' ? '' : scenario === 'dense-logs' ? 'a'.repeat(2 * 1024 * 1024) : logText;
      return { sessionId: id, generation, handle, text, truncated: scenario === 'truncated', byteCount: new TextEncoder().encode(text).length, command: '[SIMULATED ONLY] recent logs', stderr: '' };
    },
    startLogStream: async (id, requestedGeneration, handle) => {
      requireSession(id);
      if (requestedGeneration !== generation) return reject('StaleHandle', 'Synthetic list generation changed.');
      const target = targetFor(handle);
      const initial = await fixtureApi.getRecentLogs(id, handle);
      const streamId = `visual-stream-${++streamNumber}`;
      streams.clear(); streams.set(streamId, { sessionId: id, sequence: 0, initial });
      return { sessionId: id, streamId, fullId: target.fullId };
    },
    readLogStream: async (id, streamId) => {
      requireSession(id);
      const stream = streams.get(streamId);
      if (!stream || stream.sessionId !== id) return reject('StaleStream', 'Synthetic stream was replaced.');
      const initial = stream.initial; stream.initial = null;
      return { sessionId: id, streamId, sequence: ++stream.sequence,
        text: initial?.text ?? (scenario === 'live' ? `\nLIVE ${stream.sequence} · 실시간 stdout/stderr 합성 출력` : ''),
        truncated: initial?.truncated ?? false, terminal: scenario !== 'live', error: null };
    },
    stopLogStream: async (_id, streamId) => { streams.delete(streamId); },
    getContainerStats: async (id, requestedGeneration, handles) => {
      requireSession(id);
      if (requestedGeneration !== generation) return reject('StaleHandle', 'Synthetic list generation changed.');
      return { sessionId: id, generation: requestedGeneration, sampledAt: new Date().toISOString(), error: null,
        items: handles.map(handle => ({ handle, fullId: targetFor(handle).fullId, cpuPercent: 125.5,
          memoryUsage: '64MiB / 2GiB', memoryPercent: 3.125, available: true })) };
    },
    mutateContainer: async (id, handle, action): Promise<MutationResult> => {
      requireSession(id);
      return resultFor(targetFor(handle), action);
    },
    mutateContainers: async (id, requestedGeneration, handles, action): Promise<BulkMutationResult> => {
      requireSession(id);
      if (requestedGeneration !== generation) return reject('StaleHandle', 'Synthetic list generation changed.');
      if (!handles.length || new Set(handles).size !== handles.length) return reject('InvalidSelection', 'Select unique synthetic targets.');
      const targets = handles.map(targetFor);
      let aborted = false;
      const items: BulkMutationResult['items'] = targets.map(target => {
        const identity = { handle: target.handle, fullId: target.fullId, name: target.name };
        if (!canApply(target, action)) return { ...identity, outcome: 'skipped', message: 'Synthetic target was ineligible in the selected list.', result: null };
        if (aborted) return { ...identity, outcome: 'notExecuted', message: 'Synthetic operation stopped after an unknown result.', result: null };
        const result = resultFor(target, action);
        aborted = result.outcome === 'resultUnknown';
        return { ...identity, outcome: result.outcome, message: result.message, result };
      });
      return { sessionId: id, generation: requestedGeneration, action, items, mutationBlocked: false };
    },
  };
  if (Object.keys(api).some(key => !Object.hasOwn(fixtureApi, key))) {
    throw new Error('Visual fixture refused to mount: an API method has no fake.');
  }
  const calls: Record<keyof typeof api, number> = { getEnvironment: 0, listContainers: 0, getRecentLogs: 0, mutateContainer: 0, mutateContainers: 0, startLogStream: 0, readLogStream: 0, stopLogStream: 0, getContainerStats: 0 };
  Object.assign(window, { __docker2uFixtureCalls: calls });
  for (const name of Object.keys(fixtureApi) as (keyof typeof api)[]) {
    const original = fixtureApi[name] as (...args: unknown[]) => unknown;
    Object.assign(api, { [name]: (...args: unknown[]) => { ++calls[name]; return original(...args); } });
  }
  const { default: App } = await import('../App');
  await import('../styles.css');
  createRoot(root).render(<StrictMode><App /></StrictMode>);
}
