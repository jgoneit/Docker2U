import { api, type Environment } from '../../api';
import { observationApi, projectLogApi, type ObservationRead, type ProjectLogPage } from '../../observationApi';

// Test-only observers of real IPC. No production result, timer or request is mocked.
let environment: Environment | null = null;
const getEnvironment = api.getEnvironment;
api.getEnvironment = async () => { const result = await getEnvironment(); environment = result; return result; };
const visibility: { state: string; at: number }[] = [];
document.addEventListener('visibilitychange', () => visibility.push({ state: document.visibilityState, at: Date.now() }));
let baseline: { at: number; sequence: number; generation: number; sessionId: string } | null = null;
type RecordStep = (name: string, detail?: Record<string, unknown>) => void;
type Binding = { runId: string; binarySha256: string; startedAtMs: number };
const project = 'native-smoke-project';
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
// DOM presence alone does not prove that the virtualized tail is inside its
// viewport. Include every clipping ancestor and the visible window in this check.
function visibleLogTimes(): HTMLTimeElement[] {
  return [...document.querySelectorAll<HTMLTimeElement>('.project-log-row time[datetime]')].filter(time => {
    const row = time.closest<HTMLElement>('.project-log-row');
    if (!row) return false;
    const rect = row.getBoundingClientRect();
    let left = 0; let top = 0; let right = innerWidth; let bottom = innerHeight;
    for (let parent = row.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const bounds = parent.getBoundingClientRect();
      if (style.overflowX !== 'visible') { left = Math.max(left, bounds.left); right = Math.min(right, bounds.right); }
      if (style.overflowY !== 'visible') { top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom); }
    }
    return rect.height > 0 && rect.top >= top - 0.5 && rect.bottom <= bottom + 0.5
      && Math.min(rect.right, right) - Math.max(rect.left, left) >= 24;
  });
}
async function collected(): Promise<{ observation: ObservationRead; logs: ProjectLogPage }> {
  const sessionId = environment?.sessionId;
  assert(sessionId, 'Connect to the owned fixture first');
  const observation = await observationApi.read(sessionId, 0);
  const logs = await projectLogApi.query(sessionId, project, { sourceIds: [], keyword: '', offset: null, limit: 160, throughSequence: null });
  assert(observation.sessionId === sessionId && logs.sessionId === sessionId, 'Native observation belongs to another session');
  return { observation, logs };
}
async function ready() {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    try {
      const data = await collected();
      if (data.observation.scope.kind === 'project' && data.observation.scope.name === project
        && data.observation.eventStatus === 'following' && data.logs.sources.filter(source => source.selected && source.status === 'following').length === 2
        && data.observation.resources.some(point => point.available) && data.logs.rows.length >= 2) return data;
    } catch { /* Core and App complete their initial inventory/configuration. */ }
    await wait(100);
  }
  throw new Error('Native project observation did not become ready');
}

export async function captureObservationBaseline(record: RecordStep) {
  const select = document.querySelector<HTMLSelectElement>('.project-select-control select');
  assert(select, 'Project selector is unavailable');
  const value = JSON.stringify(['project', project]);
  assert([...select.options].some(option => option.value === value), 'Owned fixture project is missing');
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, value);
  select.dispatchEvent(new Event('change', { bubbles: true }));
  const { observation, logs } = await ready();
  assert(observation.inventory && !observation.inventory.stale, 'Latest native inventory must be actionable');
  const pipes = new Set(logs.rows.map(row => row.pipe));
  assert(pipes.has('tty') && pipes.has('stdout'), 'Native fixture must exercise both TTY and multiplex logs');
  assert(environment?.engineId === 'native-smoke-engine' && environment.contextName === 'native-smoke-local', 'Observation must belong to the owned native fixture');
  const bindingPage = await projectLogApi.query(observation.sessionId, project, { sourceIds: [], keyword: 'NATIVE_PROJECT_RUN ', offset: 0, limit: 10, throughSequence: null });
  const bindings = bindingPage.rows.filter(row => row.text.startsWith('NATIVE_PROJECT_RUN ')).map(row => JSON.parse(row.text.slice('NATIVE_PROJECT_RUN '.length)) as Binding);
  const binding = bindings[0];
  assert(binding && binding.runId && /^[a-f0-9]{64}$/.test(binding.binarySha256) && Number.isSafeInteger(binding.startedAtMs), 'Owned Engine API launch binding is missing');
  assert(bindings.every(item => JSON.stringify(item) === JSON.stringify(binding)), 'Engine API log sources belong to different launches');
  baseline = { at: Date.now(), sequence: logs.maxSequence, generation: observation.inventory.generation, sessionId: observation.sessionId };
  visibility.length = 0;
  record('captured native project observation baseline', { ...baseline, sources: logs.sources.filter(source => source.selected).length,
    resourcePoints: observation.resources.length, eventStatus: observation.eventStatus, pipes: [...pipes], engineId: environment.engineId,
    contextName: environment.contextName, endpoint: environment.endpoint, fullIds: logs.sources.filter(source => source.selected).map(source => source.fullId), binding });
  return binding;
}

export async function verifyObservationRestore(record: RecordStep) {
  assert(baseline, 'Capture the native observation baseline before minimizing');
  const restoredAt = Date.now();
  assert(restoredAt - baseline.at >= 15_000, 'Keep the native window minimized for at least 15 seconds');
  const { observation, logs } = await collected();
  assert(observation.sessionId === baseline.sessionId, 'Minimizing replaced the Engine session');
  const hidden = visibility.find(item => item.state === 'hidden' && item.at >= baseline!.at);
  const restored = hidden && visibility.find(item => item.state === 'visible' && item.at > hidden.at);
  assert(hidden && restored && restored.at - hidden.at >= 10_000, 'Native WebView must report a hidden interval of at least 10 seconds');
  const samples = observation.resources.filter(point => point.available && Date.parse(point.sampledAt) > hidden.at + 1000 && Date.parse(point.sampledAt) < restored.at - 1000);
  const rows = logs.rows.filter(row => Date.parse(row.receivedAt) > hidden.at + 1000 && Date.parse(row.receivedAt) < restored.at - 1000);
  const events = observation.events.filter(event => event.kind.startsWith('health_status') && Date.parse(event.observedAt) > hidden.at + 1000 && Date.parse(event.observedAt) < restored.at - 1000);
  assert(samples.length >= 2, 'No resource samples were collected inside the hidden interval');
  assert(rows.length >= 2 && logs.maxSequence > baseline.sequence, 'No project logs were collected inside the hidden interval; enable fixture live-on');
  assert(events.length > 0, 'No Engine Health events were recorded while hidden');
  assert(observation.inventory && observation.inventory.generation > baseline.generation && !observation.inventory.stale, 'Background inventory did not refresh');
  const renderedReceipt = () => visibleLogTimes()
    .some(time => Date.parse(time.dateTime) > hidden.at);
  const displayedInventory = () => Date.parse(document.querySelector<HTMLTimeElement>('.refresh-age[datetime]')?.dateTime ?? '');
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && (!renderedReceipt() || !(displayedInventory() > hidden.at))) await wait(50);
  assert(renderedReceipt() && displayedInventory() > hidden.at, 'Restored screen has not displayed background log rows inside the visible viewport');
  record('verified native background collection and restore', { sessionId: observation.sessionId, hiddenAt: hidden.at, restoredAt: restored.at,
    hiddenResourcePoints: samples.length, hiddenLogRows: rows.length, hiddenEvents: events.length,
    beforeGeneration: baseline.generation, afterGeneration: observation.inventory.generation,
    beforeLogSequence: baseline.sequence, afterLogSequence: logs.maxSequence, renderedRows: document.querySelectorAll('.project-log-row').length,
    visibleLogRows: visibleLogTimes().length,
    resourceReceipts: samples.map(point => ({ fullId: point.fullId, at: Date.parse(point.sampledAt) })),
    logReceipts: rows.map(row => ({ fullId: row.fullId, at: Date.parse(row.receivedAt) })),
    eventReceipts: events.map(event => ({ fullId: event.fullId, at: Date.parse(event.observedAt) })),
    displayedInventoryAt: displayedInventory(),
    visibility: [...visibility] });
}
