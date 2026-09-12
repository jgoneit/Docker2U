import { api, type ContainerList } from '../api';
import { observationApi, projectLogApi, type ObservationRead, type ProjectLogPage, type ProjectLogRow } from '../observationApi';
import type { ProjectFilter } from '../projects';

/** Development-only transport fixture. It never invokes native commands or Docker. */
export function installObservationFixture() {
  let snapshot: ContainerList | null = null;
  let scope: ProjectFilter = { kind: 'all' };
  let selected: Set<string> | null = null;
  let configuredProject = '';
  let held = false;
  let lastInventory = Date.now();
  let sequence = 0;
  const started = Date.now();
  const calls: Record<string, number> = {};
  Object.assign(window, { __docker2uObservationCalls: calls });
  const count = (name: string) => { calls[name] = (calls[name] ?? 0) + 1; };
  async function observation(sessionId: string, cursor = 0): Promise<ObservationRead> {
    if (!snapshot || (!held && Date.now() - lastInventory > 3000)) { snapshot = await api.listContainers(sessionId); lastInventory = Date.now(); }
    const resources = snapshot.containers.filter(item => item.state === 'running').flatMap(container => Array.from({ length: 24 }, (_, i) => ({ sequence: ++sequence, fullId: container.fullId, sampledAt: new Date(Date.now() - (23 - i) * 5000).toISOString(), cpuPercent: i === 10 ? null : 90 + Math.sin(i / 2) * 55, memoryUsageBytes: i === 10 ? null : (64 + i) * 1024 * 1024, memoryLimitBytes: 2 * 1024 ** 3, available: i !== 10 })));
    const events = [{ sequence: ++sequence, fullId: snapshot.containers[0]!.fullId, name: snapshot.containers[0]!.name, composeProject: 'orders', composeService: 'api', kind: 'start', occurredAt: new Date(started).toISOString(), observedAt: new Date(started).toISOString(), detail: null }];
    return { sessionId, sequence, scope, inventory: snapshot, resources: resources.filter(item => item.sequence > cursor), events, inventoryError: null, statsError: null, eventError: null, eventStatus: 'following', resourceTruncated: false, eventTruncated: false };
  }
  async function logs(sessionId: string, project: string): Promise<ProjectLogPage> {
    if (!snapshot) snapshot = await api.listContainers(sessionId);
    const containers = snapshot.containers.filter(container => container.composeProject === project);
    const rows: ProjectLogRow[] = Array.from({ length: 3000 + Math.floor((Date.now() - started) / 500) }, (_, i) => {
      const container = containers[i % containers.length]!;
      const timestamp = new Date(started - 60000 + i * 25).toISOString().replace('Z', '123456Z');
      return { rowId: `row-${i}`, sequence: i + 1, sourceId: container.fullId, fullId: container.fullId, serviceName: container.composeService,
        containerName: container.name, timestamp, receivedAt: new Date().toISOString(), pipe: i % 13 === 0 ? 'stderr' : 'stdout', text: i % 13 === 0 ? `ERROR[DB] database connection rejected · 데이터베이스 연결 확인 ${i}` : `request=${i} service ready · 요청 처리 완료`, truncated: false };
    });
    return { sessionId, project, revision: rows.length, maxSequence: rows.length, rows, totalRows: rows.length, offset: 0, sources: containers.map(container => ({ sourceId: container.fullId, fullId: container.fullId, serviceName: container.composeService, containerName: container.name, selected: selected === null || selected.has(container.fullId), status: 'following', error: null, droppedRows: 0 })), needsSelection: false, error: null, droppedRows: 17, retainedFrom: rows[0]?.timestamp ?? null, retainedTo: rows.at(-1)?.timestamp ?? null };
  }
  Object.assign(observationApi, {
    available: () => true,
    configure: async (sessionId: string, next: ProjectFilter) => { count('configure'); scope = next; return observation(sessionId); },
    read: async (sessionId: string, cursor: number) => { count('read'); return observation(sessionId, cursor); },
    retryEvents: async (sessionId: string) => { count('retryEvents'); return observation(sessionId); },
    hold: async (sessionId: string) => { count('hold'); held = true; snapshot = await api.listContainers(sessionId); return { sessionId, holdId: 'fixture-hold', inventory: snapshot }; },
    release: async () => { count('release'); held = false; },
  } satisfies typeof observationApi);
  Object.assign(projectLogApi, {
    configure: async (sessionId: string, project: string, handles: string[] | null) => { count('configureLogs'); configuredProject = project; selected = handles === null ? null : new Set(snapshot?.containers.filter(item => handles.includes(item.handle)).map(item => item.fullId)); const result = await logs(sessionId, project); return { ...result, offset: Math.max(0, result.rows.length - 160), rows: result.rows.slice(-160) }; },
    query: async (sessionId, project, query) => {
      count('queryLogs'); const result = await logs(sessionId, project);
      const rows = result.rows.filter(row => (!query.sourceIds.length || query.sourceIds.includes(row.sourceId)) && row.text.toLowerCase().includes(query.keyword.toLowerCase()) && (query.throughSequence === null || row.sequence <= query.throughSequence));
      let offset = query.offset === null ? Math.max(0, rows.length - query.limit) : query.offset;
      if (query.anchorRowId) { const index = rows.findIndex(row => row.rowId === query.anchorRowId); if (index >= 0) offset = index; }
      return { ...result, rows: rows.slice(offset, offset + query.limit), offset, totalRows: rows.length, anchorLost: !!query.anchorRowId && !rows.some(row => row.rowId === query.anchorRowId) };
    },
    stop: async () => { count('stopLogs'); configuredProject = ''; },
    retry: async (sessionId: string) => { count('retryLogs'); if (!configuredProject) throw new Error('No configured project'); return logs(sessionId, configuredProject); },
  } satisfies typeof projectLogApi);
}
