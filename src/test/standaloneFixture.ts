import { api, type Container, type ContainerList, type Environment } from '../api';
import { observationApi, projectLogApi, standaloneLogApi, type ObservationEvent, type ObservationRead, type ProjectLogPage, type RetainedLogPage, type StandaloneLogPage, type ResourcePoint } from '../observationApi';
import { containerDetailsFixture } from './containerDetailsFixture';
import { queryObservationFixtureLogs } from './observationFixture';

/** Development fixture only: models retained records and IDs; never runs Docker. */
export function installStandaloneFixture() {
  let sessionNumber = 0, sessionId = '', generation = 1, sequence = 10;
  let current: Container[] = [], retained: Container[] = [], events: ObservationEvent[] = [];
  let active: string | null = null, selected: Set<string> | null = null;
  let sourceCatalog = new Set<string>();
  const withoutEvents = new URLSearchParams(location.search).get('standaloneEvents') === 'none';
  const calls: Record<string, number> = {};
  const started = Date.now();
  const at = new Date(started).toISOString();
  const count = (name: string) => { calls[name] = (calls[name] ?? 0) + 1; };
  function make(id: string, name: string, project: string | null): Container {
    return { fullId: id.repeat(64), shortId: id.repeat(12), handle: `standalone-${id}-g${generation}`, name, image: 'fixture.invalid/alpine:standalone', state: 'running', health: null, healthConfigured: false, ports: [], createdAt: at, startedAt: at, composeProject: project, composeService: project ? 'web' : null };
  }
  function event(container: Container, kind: string) {
    if (withoutEvents) return;
    events.push({ sequence: ++sequence, fullId: container.fullId, name: container.name, composeProject: container.composeProject, composeService: container.composeService, kind, occurredAt: at, observedAt: at, detail: null });
  }
  function reset() {
    generation = 1; sequence = 10; active = null; selected = null; sourceCatalog.clear();
    current = [make('1', 'compose-web', 'orders'), make('3', 'standalone-api', null), make('4', 'standalone-worker', null)]; retained = [...current]; events = []; event(current[1]!, 'oom');
  }
  function changed() { ++generation; ++sequence; current = current.map(item => ({ ...item, handle: `standalone-${item.fullId[0]}-g${generation}` })); }
  const inventory = (): ContainerList => ({ sessionId, generation, containers: current, refreshedAt: new Date().toISOString(), stale: false });
  async function observation(): Promise<ObservationRead> {
    const list = await api.listContainers(sessionId);
    const resources: ResourcePoint[] = retained.map((container, index) => ({ sequence: index + 1, fullId: container.fullId, sampledAt: at, cpuPercent: 25 + index, memoryUsageBytes: (64 + index) * 1024 ** 2, memoryLimitBytes: 512 * 1024 ** 2, available: true }));
    return { sessionId, sequence, scope: { kind: 'all' }, inventory: list, resources, events, resourceTruncated: false, eventTruncated: false, inventoryError: null, statsError: null, eventError: null, eventStatus: 'following' };
  }
  function logs(project: string | null): RetainedLogPage {
    const containers = retained.filter(item => item.composeProject === project);
    const rows = Array.from({ length: containers.length * 300 }, (_, index) => {
      const container = containers[index % containers.length]!;
      const timestamp = new Date(started - 60_000 + index * 200).toISOString();
      return { rowId: `${project ?? 'standalone'}-${container.fullId}-${index}`, sequence: index + 1, sourceId: container.fullId, fullId: container.fullId, serviceName: container.composeService,
        containerName: container.name, timestamp: index === 2 ? null : timestamp, receivedAt: timestamp, pipe: 'stdout' as const,
        text: `${container.name} retained log ${index} · 보관 로그`, truncated: false };
    });
    const matchesActive = active === (project ?? 'standalone');
    if (matchesActive) for (const container of current.filter(item => item.composeProject === project)) sourceCatalog.add(container.fullId);
    return { sessionId, project, revision: rows.length, maxSequence: rows.length, rows, totalRows: rows.length, offset: 0,
      sources: containers.filter(container => matchesActive && sourceCatalog.has(container.fullId)).map(container => ({ sourceId: container.fullId, fullId: container.fullId, serviceName: container.composeService, containerName: container.name,
        selected: matchesActive && (selected === null || selected.has(container.fullId)), status: current.some(item => item.fullId === container.fullId) ? 'following' : 'removed', error: null, droppedRows: 0 })),
      droppedRows: 0, needsSelection: selected === null && current.filter(item => item.composeProject === project).length > 64, error: null,
      retainedFrom: rows[0]?.receivedAt ?? null, retainedTo: rows.at(-1)?.receivedAt ?? null };
  }
  function configure(project: string | null, handles: string[] | null) {
    active = project ?? 'standalone';
    // Native collector catalogs are rebuilt on scope changes; retained rows
    // remain queryable even when a deleted source no longer has a descriptor.
    sourceCatalog = new Set(current.filter(item => item.composeProject === project).map(item => item.fullId));
    selected = handles === null ? null : new Set(current.filter(item => handles.includes(item.handle)).map(item => item.fullId));
    const result = logs(project); return { ...result, offset: Math.max(0, result.totalRows - 160), rows: result.rows.slice(-160) };
  }
  api.getEnvironment = async () => { sessionId = `standalone-fixture-${++sessionNumber}`; reset(); return { status: 'ready', sessionId, contextName: 'standalone-fixture', endpoint: 'unix:///fixture.sock', engineId: 'fixture', mutationAllowed: true, error: null, diagnostics: [], dockerPath: '/fixture/docker', dockerConfigPath: null, clientVersion: 'fixture', serverVersion: 'fixture', apiVersion: '1.47', osType: 'linux', architecture: 'aarch64' } satisfies Environment; };
  api.listContainers = async () => inventory();
  api.getContainerDetails = async (_session, _generation, handle) => {
    const container = current.find(item => item.handle === handle)!; return containerDetailsFixture(container, inventory());
  };
  Object.assign(observationApi, {
    available: () => true, configure: async () => { count('configure'); return observation(); }, read: async () => { count('read'); return observation(); },
    retryEvents: async () => observation(), hold: async () => ({ sessionId, holdId: 'standalone-hold', inventory: inventory() }), release: async () => {},
  } satisfies typeof observationApi);
  Object.assign(projectLogApi, {
    configure: async (_session, project, handles) => { count('configureLogs'); return configure(project, handles) as ProjectLogPage; },
    query: async (_session, project, query) => { count('queryLogs'); return queryObservationFixtureLogs(logs(project) as ProjectLogPage, query); },
    retry: async () => { count('retryLogs'); return logs(active!) as ProjectLogPage; }, stop: async () => { count('stopLogs'); active = null; sourceCatalog.clear(); },
  } satisfies typeof projectLogApi);
  Object.assign(standaloneLogApi, {
    configure: async (_session, handles) => { count('configureStandaloneLogs'); return configure(null, handles) as StandaloneLogPage; },
    query: async (_session, query) => { count('queryStandaloneLogs'); return queryObservationFixtureLogs(logs(null) as StandaloneLogPage, query); },
    retry: async () => { count('retryStandaloneLogs'); return logs(null) as StandaloneLogPage; },
  } satisfies typeof standaloneLogApi);
  const controls = {
    removeApi() { for (const container of current.filter(item => item.name === 'standalone-api')) event(container, 'destroy'); current = current.filter(item => item.name !== 'standalone-api'); changed(); },
    recreateApi() { controls.removeApi(); const next = make('5', 'standalone-api', null); current.push(next); retained.push(next); event(next, 'create'); changed(); },
    removeAllStandalone() { for (const container of current.filter(item => item.composeProject === null)) event(container, 'destroy'); current = current.filter(item => item.composeProject !== null); changed(); },
    emptyInventory() { for (const container of current) event(container, 'destroy'); current = []; changed(); },
  };
  Object.assign(window, { __docker2uObservationCalls: calls, __docker2uStandaloneFixture: controls });
}
