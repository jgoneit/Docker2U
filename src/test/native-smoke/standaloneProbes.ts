import { observationApi, projectLogApi, standaloneLogApi, type ObservationEvent, type ProjectLogQuery, type StandaloneLogPage } from '../../observationApi';
import { terminalApi } from '../../terminalApi';
import { nativeObservationEnvironment } from './observationProbes';

type RecordStep = (name: string, detail?: Record<string, unknown>) => void;
type Binding = { runId: string; binarySha256: string; startedAtMs: number };
const ids = [3, 4, 5].map(number => number.toString(16).padStart(64, '0'));
const fullId = ids[0]!;
const counts = { configure: 0, stop: 0, retry: 0, terminalStarts: 0 };
const nativeConfigure = standaloneLogApi.configure;
standaloneLogApi.configure = (...args) => { ++counts.configure; return nativeConfigure(...args); };
const nativeProjectConfigure = projectLogApi.configure;
projectLogApi.configure = (...args) => { ++counts.configure; return nativeProjectConfigure(...args); };
const nativeStop = projectLogApi.stop;
projectLogApi.stop = (...args) => { ++counts.stop; return nativeStop(...args); };
const nativeRetry = standaloneLogApi.retry;
standaloneLogApi.retry = (...args) => { ++counts.retry; return nativeRetry(...args); };
const nativeStart = terminalApi.start;
terminalApi.start = (...args) => { ++counts.terminalStarts; return nativeStart(...args); };
type IncidentRead = { sessionId: string; query: ProjectLogQuery; page: StandaloneLogPage; requestedAt: number; repliedAt: number };
let latestIncident: IncidentRead | null = null;
const nativeQuery = standaloneLogApi.query;
standaloneLogApi.query = async (sessionId, query) => {
  const requestedAt = Date.now(), page = await nativeQuery(sessionId, query);
  if (query.timeFrom && query.timeTo) latestIncident = { sessionId, query: { ...query, sourceIds: [...query.sourceIds] }, page, requestedAt, repliedAt: Date.now() };
  return page;
};
let baseline: { binding: Binding; sessionId: string; event: ObservationEvent } | null = null;
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
async function waitFor(check: () => unknown | Promise<unknown>, description: string, timeout = 20_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${description}`);
}
function sameCounts(before: typeof counts) { return Object.keys(counts).every(key => counts[key as keyof typeof counts] === before[key as keyof typeof counts]); }
function group() { return document.querySelector<HTMLElement>('.project-tree-item[data-log-scope="standalone"]'); }
async function selectGroup() {
  await waitFor(group, 'standalone group');
  if (group()!.getAttribute('aria-expanded') === 'false') group()!.querySelector<HTMLButtonElement>('.project-disclosure')?.click();
  group()!.click();
  await waitFor(() => group()?.getAttribute('aria-selected') === 'true', 'standalone group selected');
}
async function tab(name: 'logs' | 'history') {
  await waitFor(() => document.getElementById(`project-${name}-tab`), `${name} group tab`);
  document.getElementById(`project-${name}-tab`)!.click();
  await waitFor(() => document.getElementById(`project-${name}-tab`)?.getAttribute('aria-selected') === 'true', `${name} group panel selected`);
}
function incident() { return document.querySelector<HTMLElement>('.incident-detail'); }
function incidentSequence() { return Number(incident()?.dataset.incidentSequence); }
function buttonByText(korean: string, english: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => !node.closest('[hidden]') && [korean, english].includes(node.textContent?.trim() ?? ''));
  assert(button && !button.disabled, `Enabled control missing: ${english}`); return button;
}
function withinViewport(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  let top = 0, bottom = innerHeight, left = 0, right = innerWidth;
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent), bounds = parent.getBoundingClientRect();
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (style.overflowY !== 'visible') { top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom); }
    if (style.overflowX !== 'visible') { left = Math.max(left, bounds.left); right = Math.min(right, bounds.right); }
  }
  return Math.min(bottom, rect.bottom) - Math.max(top, rect.top) >= 12 && Math.min(right, rect.right) - Math.max(left, rect.left) >= 30;
}
async function displayedIncident(event: ObservationEvent, minutes: number) {
  await waitFor(() => incidentSequence() === event.sequence && latestIncident?.query.sourceIds.length === 1 && latestIncident.query.sourceIds[0] === fullId
    && Date.parse(latestIncident.query.timeTo!) - Date.parse(latestIncident.query.timeFrom!) === minutes * 120_000
    && incident()?.querySelector('.incident-log-row'), 'exact native incident rows rendered');
  const read = latestIncident!;
  assert(read.sessionId === baseline?.sessionId && read.page.sessionId === baseline.sessionId && read.page.project === null, 'Incident response changed scope or native session');
  assert(read.page.rows.length > 0 && read.page.rows.length <= 500 && read.page.rows.every(row => row.fullId === fullId && row.sourceId === fullId
    && Date.parse(row.timestamp ?? row.receivedAt) >= Date.parse(read.query.timeFrom!) && Date.parse(row.timestamp ?? row.receivedAt) <= Date.parse(read.query.timeTo!)), 'Incident response contains another ID or time interval');
  const viewport = incident()!.querySelector<HTMLElement>('.incident-log-viewport')!;
  viewport.scrollIntoView({ block: 'center' });
  await waitFor(() => [...viewport.querySelectorAll<HTMLElement>('.incident-log-row')].some(withinViewport), 'native incident rows inside viewport');
  assert(incident()!.querySelectorAll('.incident-time-marker').length === 2, 'Both resource graphs must mark the incident time');
  return { fullId, eventSequence: event.sequence, occurredAt: event.occurredAt, sessionId: baseline.sessionId,
    minutes, timeFrom: read.query.timeFrom, timeTo: read.query.timeTo, rows: read.page.rows.length,
    allRowsExactId: true, allRowsInWindow: true, visibleRows: true, graphMarkers: 2,
    requestedAt: read.requestedAt, repliedAt: read.repliedAt };
}
async function openEvent(event: ObservationEvent) {
  await tab('history');
  await waitFor(() => document.querySelector(`[data-event-sequence="${event.sequence}"]`), 'retained standalone event trigger');
  const trigger = document.querySelector<HTMLButtonElement>(`[data-event-sequence="${event.sequence}"]`)!;
  if (trigger.getAttribute('aria-expanded') !== 'true') trigger.click();
}
function currentDisabled() {
  const buttons = incident()?.querySelectorAll<HTMLButtonElement>('.incident-current button');
  return buttons?.length === 4 && [...buttons].every(button => button.disabled);
}

/** All actions are UI navigation and read-only native queries. Fixture lifecycle is controlled separately by the owned runner. */
export async function standaloneIncidentProbe(record: RecordStep) {
  const environment = nativeObservationEnvironment();
  assert(environment?.sessionId && environment.engineId === 'native-smoke-engine' && environment.contextName === 'native-smoke-local', 'Connect to the owned native fixture first');
  const sessionId = environment.sessionId;
  await selectGroup(); await tab('logs');
  let page: StandaloneLogPage | null = null;
  let event: ObservationEvent | null = null;
  let resourcePoints = 0;
  await waitFor(async () => {
    page = await standaloneLogApi.query(sessionId, { sourceIds: [], keyword: '', offset: null, limit: 500, throughSequence: null });
    const observed = await observationApi.read(sessionId, 0);
    event = observed.events.filter(item => item.fullId === fullId && item.composeProject === null && item.kind.startsWith('health_status')).at(-1) ?? null;
    resourcePoints = observed.resources.filter(point => [ids[0], ids[1]].includes(point.fullId) && point.available).length;
    return page.sources.filter(source => source.selected && source.status === 'following').length === 2 && event && resourcePoints >= 2;
  }, 'two standalone streams, resource samples and Health event');
  const collected = page as unknown as StandaloneLogPage;
  const selectedEvent = event as unknown as ObservationEvent;
  assert(collected.project === null && collected.sessionId === sessionId && collected.rows.every(row => [ids[0], ids[1]].includes(row.fullId)), 'Group logs contain foreign sources');
  assert(new Set(collected.rows.map(row => row.fullId)).size === 2, 'Both standalone sources must contribute retained logs');
  const headers = await standaloneLogApi.query(sessionId, { sourceIds: [], keyword: 'NATIVE_PROJECT_RUN ', offset: 0, limit: 10, throughSequence: null });
  const bindings = headers.rows.map(row => JSON.parse(row.text.slice('NATIVE_PROJECT_RUN '.length)) as Binding);
  const binding = bindings[0];
  assert(binding && binding.runId.startsWith('d2u-smoke-') && /^[a-f0-9]{64}$/.test(binding.binarySha256) && Number.isSafeInteger(binding.startedAtMs)
    && new Set(headers.rows.map(row => row.fullId)).size === 2 && bindings.every(item => JSON.stringify(item) === JSON.stringify(binding)), 'Standalone streams lack matching owned launch binding');
  baseline = { binding, sessionId, event: selectedEvent };
  record('standalone group collected', { binding, sessionId, engineId: environment.engineId, endpoint: environment.endpoint,
    fullIds: [ids[0], ids[1]], logRows: collected.rows.length, resourcePoints, eventSequence: selectedEvent.sequence,
    fullId, occurredAt: selectedEvent.occurredAt, counts: { ...counts } });
  const before = { ...counts };
  await openEvent(selectedEvent);
  await displayedIncident(selectedEvent, 2);
  for (const minutes of [1, 5, 2]) {
    incident()!.querySelectorAll<HTMLButtonElement>('.incident-window button')[[1, 2, 5].indexOf(minutes)]!.click();
    await displayedIncident(selectedEvent, minutes);
  }
  const previous = latestIncident;
  incident()!.querySelector<HTMLButtonElement>('.incident-toolbar > button')!.click();
  await waitFor(() => latestIncident !== previous, 'explicit incident refresh reads native retained logs');
  const evidence = await displayedIncident(selectedEvent, 2);
  assert(sameCounts(before), 'Incident query changed collection or opened a terminal');
  record('standalone incident rendered', { ...evidence, testedMinutes: [1, 5, 2], refreshed: true, counts: { ...counts } });
  for (const [index, tabName] of [[0, 'diagnostics'], [3, 'terminal']] as const) {
    incident()!.querySelectorAll<HTMLButtonElement>('.incident-current button')[index]!.click();
    await waitFor(() => document.querySelector(`[data-detail-tab="${tabName}"][aria-selected="true"]`), `current ${tabName} tab`);
    assert(document.querySelector('.container-row[aria-selected="true"]')?.getAttribute('title') === 'native-smoke-3', 'Current details selected another container');
    if (tabName === 'terminal') await waitFor(() => document.querySelector('.terminal-connect'), 'terminal ready without automatic connection');
    else {
      await waitFor(() => document.querySelector('.container-insights')?.textContent?.includes('NATIVE_STANDALONE_HEALTH_FAILURE'), 'native diagnostics response rendered');
      const disclosure = document.querySelector<HTMLDetailsElement>('.insights-output-disclosure')!;
      if (!disclosure.open) disclosure.querySelector('summary')!.click();
      const output = document.querySelector<HTMLElement>('.insights-health-output')!;
      output.scrollIntoView({ block: 'center' });
      await waitFor(() => withinViewport(output), 'native diagnostic failure output in viewport');
    }
    buttonByText('사건으로 돌아가기', 'Back to incident').click();
    await displayedIncident(selectedEvent, 2);
    await waitFor(() => document.activeElement?.getAttribute('data-event-sequence') === String(selectedEvent.sequence), 'incident trigger focus restored');
  }
  assert(sameCounts(before), 'Current detail navigation changed collection or auto-connected terminal');
  record('standalone incident returned', { sessionId, fullId, eventSequence: selectedEvent.sequence, minutes: 2,
    diagnosticsVisited: true, terminalVisited: true, terminalNotStarted: true, focusRestored: true, counts: { ...counts } });
  return binding;
}

export async function standaloneArchiveProbe(record: RecordStep, empty = false) {
  assert(baseline && nativeObservationEnvironment()?.sessionId === baseline.sessionId, 'Run standalone incident first in this same native session');
  const { sessionId, event, binding } = baseline;
  const expected = empty ? [] : [ids[1], ids[2]];
  await waitFor(async () => {
    const observed = await observationApi.read(sessionId, 0);
    const actual = observed.inventory?.containers.filter(row => !row.composeProject).map(row => row.fullId).sort();
    return actual && JSON.stringify(actual) === JSON.stringify(expected);
  }, empty ? 'owned fixture standalone-remove-all applied' : 'owned fixture standalone-recreate applied');
  await selectGroup(); await openEvent(event);
  const before = { ...counts }, previous = latestIncident;
  await waitFor(() => incident()?.querySelector<HTMLButtonElement>('.incident-toolbar > button')?.disabled === false, 'archive refresh enabled');
  incident()!.querySelector<HTMLButtonElement>('.incident-toolbar > button')!.click();
  await waitFor(() => latestIncident !== previous, 'fresh archive query after deletion');
  const evidence = await displayedIncident(event, 2);
  assert(currentDisabled() && sameCounts(before), 'Deleted ID was connected to current information or collection changed');
  assert(group()?.getAttribute('aria-selected') === 'true', 'Archived standalone group is not selectable');
  record(empty ? 'standalone empty archive verified' : 'standalone replaced archive verified', { ...evidence,
    currentIds: expected, currentDisabled: true, groupSelected: true, countsBefore: before, countsAfter: { ...counts } });
  return binding;
}
