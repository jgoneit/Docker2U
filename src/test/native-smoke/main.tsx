import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import App from '../../App';
import { api, coreError, type ContainerDetails } from '../../api';
import { composeApi } from '../../composeApi';
import { observationApi, projectLogApi, type ObservationRead } from '../../observationApi';
import '../../styles.css';
import { initializePreferences } from '../../preferences';
import { nativeCheckpoint, nativePaneSize, readyNativeInventory, readyNativeLogs, type NativeCheckpoint } from './readiness';
import { captureObservationBaseline, verifyObservationRestore, visibleLogTimes } from './observationProbes';
import { terminalRoundtripProbe } from './terminalProbes';

const marker = 'NATIVE_SMOKE_HARNESS';
type Mode = 'worker' | 'constructor-fail' | 'never-ready';
type Evidence = { name: string; timeMs: number; detail?: Record<string, unknown> };
type Binding = { runId: string; binarySha256: string; startedAtMs: number };
const storedMode = sessionStorage.getItem(marker);
const mode: Mode = storedMode === 'constructor-fail' || storedMode === 'never-ready' ? storedMode : 'worker';
const streamEvidence = { startRequests: 0, starts: 0, reads: 0, stops: 0, activeReads: 0, maximumActiveReads: 0, nonEmptyReads: 0, receivedBytes: 0, streamId: '', fullId: '', statsReads: 0, lastStatsCount: 0, stdoutTick: 0, stderrTick: 0 };
type InventoryReply = { request: number; sessionId: string; requestedAtMs: number; repliedAtMs: number; errorCode: string | null; responseSessionId: string | null };
let inventoryRequests = 0;
let lastInventoryReply: InventoryReply | null = null;
let detailsReads = 0;
let lastDetails: ContainerDetails | null = null;
let lastObservation: ObservationRead | null = null;
const standaloneName = 'native-smoke-3';
const fixtureIds = [1, 2, 3].map(number => number.toString(16).padStart(64, '0'));
const report = { marker, mode, streamEvidence, nativeIpc: '__TAURI_INTERNALS__' in window, status: 'ready', binding: null as Binding | null, steps: [] as Evidence[], workerEvents: [] as Evidence[], failures: [] as string[] };
let changed = () => {};
function record(name: string, detail?: Record<string, unknown>) {
  report.steps.push({ name, timeMs: Date.now(), detail });
  changed();
}
function workerEvent(name: string, detail?: Record<string, unknown>) {
  report.workerEvents.push({ name, timeMs: Date.now(), detail });
  if (report.workerEvents.length > 128) report.workerEvents.shift();
  changed();
}

// Only this separate entry wraps Worker. Production App, api and native commands are unchanged.
const NativeWorker = window.Worker;
window.Worker = new Proxy(NativeWorker, {
  construct(Target, arguments_) {
    workerEvent('constructor', { url: String(arguments_[0]), mode });
    if (mode === 'constructor-fail') {
      workerEvent('injected constructor failure');
      throw new DOMException('Native smoke injected Worker construction failure', 'SecurityError');
    }
    const worker = Reflect.construct(Target, arguments_) as Worker;
    worker.addEventListener('message', event => {
      const data = event.data as { type?: string; total?: number; match?: { ordinal?: number; start?: number; length?: number } };
      workerEvent(data.type ?? 'unknown message', { total: data.total, match: data.match, suppressed: mode === 'never-ready' });
      // The native Worker really runs; only the test wrapper suppresses its delivery.
      if (mode === 'never-ready') event.stopImmediatePropagation();
    }, { capture: true });
    worker.addEventListener('error', () => workerEvent('native worker error'));
    const terminate = worker.terminate.bind(worker);
    worker.terminate = () => { workerEvent('terminated'); terminate(); };
    return worker;
  },
});

// Observe the actual IPC replies, without replacing native behavior or storing raw logs.
const nativeInventory = api.listContainers;
api.listContainers = async (...args) => {
  const request = ++inventoryRequests; const requestedAtMs = Date.now();
  try {
    const result = await nativeInventory(...args);
    lastInventoryReply = { request, sessionId: args[0], requestedAtMs, repliedAtMs: Date.now(), errorCode: null, responseSessionId: result.sessionId };
    return result;
  } catch (error) {
    lastInventoryReply = { request, sessionId: args[0], requestedAtMs, repliedAtMs: Date.now(), errorCode: coreError(error).code, responseSessionId: null };
    throw error;
  }
};
const nativeStart = api.startLogStream;
api.startLogStream = async (...args) => {
  ++streamEvidence.startRequests;
  const stream = await nativeStart(...args);
  ++streamEvidence.starts; streamEvidence.streamId = stream.streamId; streamEvidence.fullId = stream.fullId;
  streamEvidence.stdoutTick = 0; streamEvidence.stderrTick = 0; changed();
  return stream;
};
const nativeRead = api.readLogStream;
api.readLogStream = async (...args) => {
  ++streamEvidence.reads; ++streamEvidence.activeReads;
  streamEvidence.maximumActiveReads = Math.max(streamEvidence.maximumActiveReads, streamEvidence.activeReads);
  try {
    const frame = await nativeRead(...args);
    if (frame.text) ++streamEvidence.nonEmptyReads;
    streamEvidence.receivedBytes += new TextEncoder().encode(frame.text).byteLength;
    if (frame.streamId === streamEvidence.streamId) {
      for (const match of frame.text.matchAll(/NATIVE_SMOKE_LIVE_(STDOUT|STDERR) (\d+)/g)) {
        const key = match[1] === 'STDOUT' ? 'stdoutTick' : 'stderrTick';
        streamEvidence[key] = Math.max(streamEvidence[key], Number(match[2]));
      }
    }
    changed(); return frame;
  } finally { --streamEvidence.activeReads; }
};
const nativeStats = api.getContainerStats;
api.getContainerStats = async (...args) => { const sample = await nativeStats(...args); ++streamEvidence.statsReads; streamEvidence.lastStatsCount = sample.items.length; changed(); return sample; };
const nativeObservationConfigure = observationApi.configure;
observationApi.configure = async (...args) => { const result = await nativeObservationConfigure(...args); lastObservation = result; return result; };
const nativeObservationRead = observationApi.read;
observationApi.read = async (...args) => { const result = await nativeObservationRead(...args); lastObservation = result; return result; };
const nativeStop = api.stopLogStream;
api.stopLogStream = async (...args) => { await nativeStop(...args); ++streamEvidence.stops; changed(); };
const nativeDetails = api.getContainerDetails;
api.getContainerDetails = async (...args) => { const details = await nativeDetails(...args); ++detailsReads; lastDetails = details; return details; };

// Observe the real Compose IPC contract in the separate native fixture bundle.
// Only metadata is recorded: resolved configuration/environment values never enter evidence.
const nativeComposePick = composeApi.pick;
composeApi.pick = async (...args) => { const selected = await nativeComposePick(...args); record('compose picker', { kind: args[0], selected: selected !== null }); return selected; };
const nativeComposePreview = composeApi.preview;
composeApi.preview = async (...args) => {
  try { const preview = await nativeComposePreview(...args); record('compose preview', { name: preview.project.name, services: preview.services.map(service => service.name), existingContainers: preview.existingContainers }); return preview; }
  catch (error) { record('compose preview failed', { code: coreError(error).code }); throw error; }
};
const nativeComposeSave = composeApi.save;
composeApi.save = async (...args) => { const project = await nativeComposeSave(...args); record('compose registered', { id: project.id, name: project.name, revision: project.revision }); return project; };
const nativeComposePrepare = composeApi.prepare;
composeApi.prepare = async (...args) => { const prepared = await nativeComposePrepare(...args); record('compose prepared', { name: prepared.project.name, action: prepared.action, existingContainers: prepared.existingContainers }); return prepared; };
const nativeComposeStart = composeApi.start;
composeApi.start = async (...args) => { const operation = await nativeComposeStart(...args); record('compose started', { id: operation.id, action: operation.action, phase: operation.phase }); return operation; };
const composePhases = new Map<string, string>();
const nativeComposeRead = composeApi.read;
composeApi.read = async (...args) => {
  const reply = await nativeComposeRead(...args); const operation = reply.operation;
  if (composePhases.get(operation.id) !== operation.phase) {
    composePhases.set(operation.id, operation.phase);
    record('compose phase', { id: operation.id, action: operation.action, phase: operation.phase, outcome: operation.outcome, reconciliation: operation.reconciliation, observedContainers: operation.observedContainers, errorCode: operation.error?.code ?? null });
  }
  return reply;
};
const nativeComposeCancel = composeApi.cancel;
composeApi.cancel = async (...args) => { const operation = await nativeComposeCancel(...args); record('compose cancelled', { id: operation.id, phase: operation.phase, cancelRequested: operation.cancelRequested }); return operation; };

// An explicitly armed, test-only response fault. Both configure and retry still
// execute real Rust IPC; this proves UI recovery, not a native reader failure.
let failProjectConfigureReply = false;
let projectRetries = 0;
const nativeProjectConfigure = projectLogApi.configure;
projectLogApi.configure = async (...args) => {
  const injectThisReply = failProjectConfigureReply;
  if (injectThisReply) failProjectConfigureReply = false;
  const result = await nativeProjectConfigure(...args);
  if (!injectThisReply) return result;
  assert(!result.error, 'Native configure failed before the response fault was injected');
  record('injected project configure response failure', { sessionId: result.sessionId, project: result.project, nativeConfigureCompleted: true, responseFaultOnly: true });
  return { ...result, rows: [], totalRows: 0, error: { code: 'EngineTransportError', message: 'NATIVE_SMOKE_INITIAL_CONFIGURE_FAILURE' } };
};
const nativeProjectRetry = projectLogApi.retry;
projectLogApi.retry = async (...args) => { const result = await nativeProjectRetry(...args); ++projectRetries; return result; };

localStorage.setItem('docker2u.preferences.v1', JSON.stringify({ theme: 'light', language: 'ko' }));
initializePreferences();
createRoot(document.getElementById('root')!).render(<App />);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
async function waitFor(check: () => unknown, description: string, timeout = 8000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out: ${description}`);
}
function panel() {
  const value = Array.from(document.querySelectorAll<HTMLElement>('.logs-panel')).find(element => !element.closest('[hidden]'));
  assert(value, 'Select a fixture container with an inline log panel');
  return value;
}
function content() {
  const value = panel().querySelector<HTMLPreElement>('.log-content');
  assert(value, 'Log content is unavailable');
  return value;
}
function button(name: string, scope: ParentNode = document.querySelector('.app-shell')!) {
  const value = Array.from(scope.querySelectorAll<HTMLElement>('button, [role="treeitem"]')).find(element => !element.closest('[hidden]') && (element.getAttribute('aria-label') === name || element.textContent?.trim() === name));
  assert(value, `Control missing: ${name}`);
  return value;
}
function disabled(target: HTMLElement) { return target instanceof HTMLButtonElement ? target.disabled : target.getAttribute('aria-disabled') === 'true'; }
function click(name: string, scope?: ParentNode) {
  const target = button(name, scope);
  assert(!disabled(target), `Control disabled: ${name}`);
  target.click();
}
async function selectStandalone(previous?: NativeCheckpoint) {
  await waitFor(() => readyNativeInventory(document, previous), 'settled owned fixture inventory');
  const group = button('프로젝트 없음');
  if (group.getAttribute('aria-expanded') === 'false') click('프로젝트 없음 펼치기', group);
  const target = button(`${standaloneName} 상세`);
  if (target.getAttribute('aria-selected') !== 'true') target.click();
  await waitFor(() => button(`${standaloneName} 상세`).getAttribute('aria-selected') === 'true', 'projectless fixture selected for legacy log IPC');
  const logs = button('로그');
  if (logs.getAttribute('aria-selected') !== 'true') logs.click();
  await waitFor(() => document.querySelector('.logs-panel:not([hidden]) .log-content'), 'projectless native log panel mounted');
}
function warned() { return document.querySelector('.connection-status')?.textContent?.includes('연결 재확인 필요'); }
function blocked() {
  const actions = Array.from(document.querySelectorAll<HTMLButtonElement>('.recovery-actions button'));
  assert(actions.length === 3, 'Expected all three production recovery buttons');
  return actions.every(element => element.disabled);
}
async function ready(previous?: NativeCheckpoint, dense = false) {
  assert(report.nativeIpc, 'This entry must run inside the packaged native validation app');
  await selectStandalone(previous);
  let acceptedText = '';
  await waitFor(() => {
    const accepted = readyNativeLogs(document, previous, dense || !report.binding);
    if (!accepted) return false;
    acceptedText = accepted.text;
    return true;
  }, previous ? 'new inventory and log timestamps, settled IPC, and the complete 2 MiB response' : 'settled native IPC and the complete 2 MiB fixture logs');
  assert(document.querySelector('.app-shell')?.textContent?.includes('native-smoke-local'), 'The app is not connected to the isolated fixture');
  const header = acceptedText.split('\n', 1)[0]!;
  if (!header.startsWith('NATIVE_SMOKE_RUN ') && report.binding && !dense) return;
  assert(header.startsWith('NATIVE_SMOKE_RUN '), 'Fixture launch identity is missing; use live-off then reload logs before binding/search');
  const binding = JSON.parse(header.slice('NATIVE_SMOKE_RUN '.length)) as Binding;
  assert(binding.runId && /^[a-f0-9]{64}$/.test(binding.binarySha256) && Number.isSafeInteger(binding.startedAtMs), 'Invalid fixture launch identity');
  assert(!report.binding || JSON.stringify(report.binding) === JSON.stringify(binding), 'Native fixture changed during this page run');
  report.binding = binding;
}
function input(value: string) {
  const field = panel().querySelector<HTMLInputElement>('.log-search-input');
  assert(field, 'Log search input missing');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value);
  field.dispatchEvent(new Event('input', { bubbles: true }));
}
function count() { return panel().querySelector('.log-search-count')?.textContent; }
async function visibleMatch() {
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  const match = panel().querySelector<HTMLElement>('mark');
  assert(match, 'Current match missing');
  const viewport = content().getBoundingClientRect();
  const position = match.getBoundingClientRect();
  assert(position.top >= viewport.top - 1 && position.bottom <= viewport.bottom + 1, 'Current match lies outside the actual log viewport');
  return { viewport: { top: viewport.top, bottom: viewport.bottom }, match: { top: position.top, bottom: position.bottom } };
}

async function searchProbe() {
  await ready(undefined, true);
  const toggle = panel().querySelector<HTMLButtonElement>('.log-search-toggle');
  assert(toggle, 'Production log search toggle is missing');
  if (toggle.getAttribute('aria-expanded') === 'false') toggle.click();
  await waitFor(() => panel().querySelector('.log-search-input'), 'search input opened');
  // Independent literal count includes the per-run identity header, still exactly 2 MiB.
  let totalAs = 0;
  for (const character of content().textContent!) if (character === 'a' || character === 'A') totalAs++;
  const started = performance.now();
  input('a');
  await waitFor(() => count() === `1 / ${totalAs}건`, 'the exact dense match count', 15000);
  record('2 MiB dense count', { total: totalAs, elapsedMs: Math.round(performance.now() - started) });
  click('이전 일치', panel());
  await waitFor(() => count() === `${totalAs} / ${totalAs}건`, 'wrap to the last dense match');
  record('last dense match visible', await visibleMatch());
  for (const query of ['aa', 'not-present', 'NATIVE_SMOKE_END']) {
    input(query);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  await waitFor(() => count() === '1 / 1건' && panel().querySelector('mark')?.textContent === 'NATIVE_SMOKE_END', 'latest query to replace older searches');
  record('latest marker visible', await visibleMatch());
  if (mode === 'worker') {
    assert(report.workerEvents.some(event => event.name === 'ready'), 'Native Worker did not report ready');
    assert(report.workerEvents.some(event => event.name === 'result' && event.detail?.total === totalAs), 'Native Worker did not produce the dense count');
    assert(report.workerEvents.some(event => event.name === 'located'), 'Native Worker did not locate the last match');
  } else if (mode === 'constructor-fail') {
    assert(report.workerEvents.some(event => event.name === 'injected constructor failure'), 'Constructor fault was not exercised');
  } else {
    assert(report.workerEvents.some(event => event.name === 'ready' && event.detail?.suppressed), 'The real Worker ready signal was not suppressed');
    assert(report.workerEvents.some(event => event.name === 'terminated'), 'The startup timeout did not terminate the Worker');
  }
  record('search backend verified', { mode, source: mode === 'worker' ? 'genuine Worker replies' : 'explicit fault injection and successful fallback UI' });
}

async function clearProbe() {
  await ready();
  assert(!warned(), 'Reconnect before starting a new connection-clear probe');
  const started = performance.now();
  record('requested pending logs');
  click('로그 조회', panel());
  await waitFor(() => content().getAttribute('aria-busy') === 'true', 'log request pending', 1000);
  // Give the native client-version subprocess time to reach the armed info call.
  // The runner independently requires held-info < Clear < reply; timing alone is not proof.
  await new Promise(resolve => setTimeout(resolve, 350));
  click('로그 화면 비우기', panel());
  await waitFor(() => content().getAttribute('aria-busy') === 'false', 'Clear to remove the loading view', 1000);
  assert(performance.now() - started < 1000, 'UI sequence exceeded its 1s timing budget; do not accept this run');
  record('cleared pending logs');
  assert(disabled(button('로그 조회', panel())), 'Clear released the native IPC slot too early');
  await waitFor(warned, 'the delayed native Engine identity failure');
  assert(blocked(), 'Recovery actions remained available after a native session failure');
  assert(!panel().querySelector('.log-error'), 'An invalidated error replaced the cleared log view');
  assert(!panel().querySelector('.log-fetched-at'), 'Clear left a stale log timestamp');
  assert(disabled(button('표시된 로그 복사', panel())), 'Cleared logs are still copyable');
  record('native connection warning preserved after Clear');
}

async function socketProbe() {
  await ready();
  assert(!warned(), 'Reconnect before starting the missing-socket probe');
  record('requested missing-socket logs');
  click('로그 조회', panel());
  await waitFor(() => panel().querySelector('.log-error')?.textContent?.includes('SocketMissing'), 'the native filesystem SocketMissing error');
  assert(warned() && blocked(), 'Missing socket did not invalidate the current session');
  record('native SocketMissing verified');
}

async function recoveryProbe() {
  assert(warned(), 'Run a connection failure probe first; restore the fixture socket if removed');
  const beforeRefresh = nativeCheckpoint(document);
  assert(beforeRefresh.listCheckedAt && lastInventoryReply?.sessionId, 'Recovery requires the last good native inventory');
  const sessionId = lastInventoryReply.sessionId;
  const starts = streamEvidence.starts; const startRequests = streamEvidence.startRequests;
  const beforeRequest = inventoryRequests;
  const visibleInventory = () => Array.from(document.querySelectorAll('.container-list-item')).map(row => row.getAttribute('aria-label')).join('\n');
  const inventoryBefore = visibleInventory();
  assert(inventoryBefore, 'Recovery requires retained inventory rows');
  record('requested warning-preserving Refresh', { sessionId, starts, startRequests, listCheckedAt: beforeRefresh.listCheckedAt });
  click('새로고침');
  await waitFor(() => lastInventoryReply && lastInventoryReply.request > beforeRequest && !disabled(button('새로고침'))
    && document.querySelector('.inline-error')?.textContent?.includes('NeedsValidation'), 'native NeedsValidation reply and settled blocked Refresh');
  const rejected = lastInventoryReply;
  assert(rejected?.request === beforeRequest + 1 && rejected.sessionId === sessionId && rejected.errorCode === 'NeedsValidation', 'Refresh did not reject the current session with native NeedsValidation');
  assert(warned() && blocked(), 'Rejected Refresh cleared the session warning or enabled recovery');
  assert(nativeCheckpoint(document).listCheckedAt === beforeRefresh.listCheckedAt && visibleInventory() === inventoryBefore, 'Rejected Refresh replaced the last good inventory');
  assert(streamEvidence.starts === starts && streamEvidence.startRequests === startRequests, 'Refresh requested logs before reconnecting the invalid session');
  record('warning retained after NeedsValidation rejected Refresh without new logs', { ...rejected, starts, startRequests, listCheckedAt: beforeRefresh.listCheckedAt, inventoryPreserved: true, warningVisible: true, recoveryBlocked: true, renderedErrorCode: 'NeedsValidation' });
  const beforeReconnect = nativeCheckpoint(document);
  const oldStream = streamEvidence.streamId;
  record('requested explicit Reconnect', { sessionId, starts: streamEvidence.starts, startRequests: streamEvidence.startRequests });
  click('다시 연결');
  await ready(beforeReconnect);
  await waitFor(() => !warned(), 'a fresh valid session');
  const restored = lastInventoryReply;
  assert(restored && !restored.errorCode && restored.sessionId !== sessionId && restored.responseSessionId === restored.sessionId, 'Reconnect did not return inventory for a fresh native session');
  assert(streamEvidence.starts > starts && streamEvidence.streamId !== oldStream, 'Reconnect did not open a fresh log stream');
  assert(!disabled(button('중지', document.querySelector('.recovery-actions')!)), 'Fresh session did not restore recovery availability');
  record('explicit reconnect restored the valid session', { ...restored, starts: streamEvidence.starts, streamId: streamEvidence.streamId, fullId: streamEvidence.fullId, warningVisible: false, recoveryAvailable: true });
}

function closeLogSearch() {
  if (panel().querySelector('.log-search-toggle')?.getAttribute('aria-expanded') === 'true') click('로그 검색 닫기', panel());
}
async function projectStatsProbe() {
  await ready();
  const requestedAt = Date.now();
  const project = button('native-smoke-project 프로젝트');
  if (project.getAttribute('aria-expanded') === 'false') click('native-smoke-project 펼치기', project);
  project.click();
  await waitFor(() => project.getAttribute('aria-selected') === 'true' && project.querySelectorAll('.container-row').length === 2, 'project tree opens its two Compose services');
  assert(document.querySelectorAll('.container-row').length === 3, 'Selecting a project unexpectedly filtered the inventory');
  await waitFor(() => lastObservation?.scope.kind === 'all' && fixtureIds.every(fullId => lastObservation!.resources.some(point => point.fullId === fullId && point.available && Date.parse(point.sampledAt) >= requestedAt)), 'fresh real observation samples for all fixture containers', 15000);
  const observation = lastObservation!;
  const sample = [...observation.resources].reverse().find(point => point.fullId === fixtureIds[0] && point.available && Date.parse(point.sampledAt) >= requestedAt)!;
  assert(sample.cpuPercent === 125.5 && sample.memoryUsageBytes === 64 * 1024 * 1024 && sample.memoryLimitBytes === 2 * 1024 * 1024 * 1024, 'Native observation values do not match the fixture');
  const apiRow = button('native-smoke-1 상세');
  await waitFor(() => apiRow.querySelector('.container-cpu-value')?.textContent === '125.50%', 'observation sample displayed in the project tree');
  assert(apiRow.querySelector('.container-memory-value')?.textContent === '64.0 MiB', 'Tree memory sample missing');
  apiRow.click();
  await waitFor(() => apiRow.getAttribute('aria-selected') === 'true', 'Compose container selected');
  click('접속 정보');
  await waitFor(() => document.querySelector('.container-information .resource-summary')?.textContent?.includes('125.50%'), 'real resource sample in connectivity information');
  const information = document.querySelector<HTMLElement>('.container-information')!;
  assert(information.querySelector('.resource-summary')?.textContent?.includes('64.0 MiB / 2.0 GiB'), 'Fixture memory sample missing');
  assert(information.querySelector('.resource-summary')!.getBoundingClientRect().height > 0, 'Resource sample is not displayed');
  assert(information.querySelector('.summary-facts')?.textContent?.includes('api'), 'Compose service metadata missing');
  assert(information.querySelector('.summary-facts')!.getBoundingClientRect().height > 0, 'Compose metadata is not displayed');
  click('로그');
  await waitFor(() => !document.querySelector('.container-information'), 'container information stays in connectivity');
  record('Compose grouping and real stats visible', { projectRows: 2, observedSources: 3, cpuPercent: sample.cpuPercent,
    memoryUsageBytes: sample.memoryUsageBytes, memoryLimitBytes: sample.memoryLimitBytes, sessionId: observation.sessionId,
    observationSequence: observation.sequence, sampledAt: sample.sampledAt, fullIds: fixtureIds });
  await ready();
  const standalone = button('프로젝트 없음');
  assert(standalone.querySelectorAll('.container-row').length === 1 && button(`${standaloneName} 상세`).getAttribute('aria-selected') === 'true', 'Standalone tree selection did not open its own log panel');
  assert(document.querySelectorAll('.container-row').length === 3, 'Standalone selection unexpectedly filtered other projects');
  record('standalone tree navigation verified', { standaloneRows: 1, inventoryRows: 3, fullId: fixtureIds[2] });
}
async function liveDisplayProbe() {
  const searchClosed = () => panel().querySelector('.log-search-toggle')?.getAttribute('aria-expanded') === 'false' && panel().querySelector<HTMLElement>('.log-search')?.hidden === true;
  const hasLossNotice = (message: string) => Array.from(panel().querySelectorAll('.truncation-notice[role="status"]')).some(notice => notice.textContent?.includes(message));
  await ready(); closeLogSearch();
  await waitFor(() => searchClosed(), 'search closed before live display');
  const resume = Array.from(panel().querySelectorAll<HTMLButtonElement>('button')).find(element => element.textContent?.trim() === '재개');
  resume?.click();
  await waitFor(() => panel().querySelector('.log-pause-toggle')?.getAttribute('aria-pressed') === 'false', 'display resumed before live probe');
  await waitFor(() => streamEvidence.stdoutTick > 0 && streamEvidence.stderrTick > 0 && content().textContent?.includes('NATIVE_SMOKE_LIVE_STDOUT') && content().textContent?.includes('NATIVE_SMOKE_LIVE_STDERR'), 'live-on fixture stdout and stderr rendered', 10000);
  const streamId = streamEvidence.streamId;
  click('일시정지', panel());
  await waitFor(() => panel().querySelector('.log-pause-toggle')?.getAttribute('aria-pressed') === 'true', 'display pause');
  const frozenText = content().textContent; const pauseTick = Math.max(streamEvidence.stdoutTick, streamEvidence.stderrTick);
  record('paused live display', { streamId, fullId: streamEvidence.fullId, beforeTick: pauseTick }); const beforeReads = streamEvidence.nonEmptyReads;
  await waitFor(() => streamEvidence.stdoutTick >= pauseTick + 3 && streamEvidence.stderrTick >= pauseTick + 3 && streamEvidence.nonEmptyReads > beforeReads, 'native bytes while display is paused');
  // IPC counters advance before LiveLogController and React receive the frame.
  // Resume only after the rendered paused view has observed buffer loss.
  await waitFor(() => hasLossNotice('표시를 멈춘 사이 일부 로그'), 'pending loss notice rendered while paused');
  assert(content().textContent === frozenText, 'Paused display changed while real IPC bytes arrived');
  assert(streamEvidence.streamId === streamId, 'Pausing replaced the stream');
  record('paused display while real stdout and stderr arrived', { streamId, fullId: streamEvidence.fullId, beforeTick: pauseTick, afterTick: Math.min(streamEvidence.stdoutTick, streamEvidence.stderrTick), newFrames: streamEvidence.nonEmptyReads - beforeReads });
  click('재개', panel());
  await waitFor(() => panel().querySelector('.log-pause-toggle')?.getAttribute('aria-pressed') === 'false' && content().textContent !== frozenText && content().textContent?.includes('NATIVE_SMOKE_LIVE_STDOUT') && hasLossNotice('오래된 로그를 건너뛰고'), 'resumed display catches up with the ring loss notice');
  record('resume caught up with ring loss notice');
  click('로그 검색 열기', panel()); await waitFor(() => panel().querySelector('.log-search-toggle')?.getAttribute('aria-expanded') === 'true' && panel().querySelector<HTMLElement>('.log-search')?.hidden === false, 'search opened'); input('NATIVE_SMOKE_LIVE');
  await waitFor(() => panel().querySelector('mark')?.textContent === 'NATIVE_SMOKE_LIVE', 'live search result rendered');
  const searchText = content().textContent; const searchTick = Math.max(streamEvidence.stdoutTick, streamEvidence.stderrTick);
  record('search display frozen', { streamId, fullId: streamEvidence.fullId, beforeTick: searchTick });
  await waitFor(() => streamEvidence.stdoutTick >= searchTick + 3 && streamEvidence.stderrTick >= searchTick + 3, 'real bytes while search is frozen');
  await waitFor(() => hasLossNotice('표시를 멈춘 사이 일부 로그'), 'pending loss notice rendered during search');
  assert(content().textContent === searchText, 'Search results moved with incoming logs');
  click('로그 검색 닫기', panel());
  await waitFor(() => searchClosed() && panel().querySelector('.log-pause-toggle')?.getAttribute('aria-pressed') === 'false' && content().textContent !== searchText, 'closing search resumes the display');
  assert(streamEvidence.streamId === streamId && streamEvidence.maximumActiveReads === 1, 'Live probe replaced the stream or overlapped read IPC');
  record('search froze and resumed without restarting the stream', { streamId, fullId: streamEvidence.fullId, afterTick: Math.min(streamEvidence.stdoutTick, streamEvidence.stderrTick), maximumActiveReads: streamEvidence.maximumActiveReads });
}
async function pinnedRefreshProbe() {
  await ready(); closeLogSearch();
  const streamId = streamEvidence.streamId; const starts = streamEvidence.starts; const before = nativeCheckpoint(document);
  record('requested inventory refresh with live stream', { streamId, fullId: streamEvidence.fullId, starts });
  click('새로고침');
  await waitFor(() => readyNativeInventory(document, before), 'fresh inventory for the same stream');
  assert(streamEvidence.streamId === streamId && streamEvidence.starts === starts, 'Inventory refresh replaced a live stream');
  record('inventory refreshed with the same live stream', { streamId, fullId: streamEvidence.fullId, starts });
}
async function paneResizeProbe() {
  await ready(); closeLogSearch();
  const resume = Array.from(panel().querySelectorAll<HTMLButtonElement>('button')).find(element => element.textContent?.trim() === '재개');
  resume?.click();
  await waitFor(() => streamEvidence.stdoutTick > 0 && streamEvidence.stderrTick > 0, 'live-on stdout and stderr before resizing');
  click('일시정지', panel());
  await waitFor(() => panel().querySelector('.log-pause-toggle')?.getAttribute('aria-pressed') === 'true', 'display paused before resizing');
  click('로그 검색 열기', panel());
  await waitFor(() => panel().querySelector('.log-search-input'), 'search opened before resizing');
  input('NATIVE_SMOKE_LIVE');
  await waitFor(() => panel().querySelector('mark'), 'frozen live search result');
  const separator = document.querySelector<HTMLButtonElement>('.pane-resizer[role="separator"]');
  const initial = nativePaneSize(document);
  assert(separator && initial && initial.max > initial.min, 'Resizable pane contract is unavailable');
  const log = content(); const frozenText = log.textContent;
  const receipt = panel().querySelector('.log-fetched-at time');
  const receivedAt = receipt?.getAttribute('datetime');
  log.scrollTop = Math.min(80, log.scrollHeight - log.clientHeight); log.dispatchEvent(new Event('scroll'));
  const scrollTop = log.scrollTop;
  const identity = { streamId: streamEvidence.streamId, fullId: streamEvidence.fullId };
  const starts = streamEvidence.starts;
  const beforeTick = Math.max(streamEvidence.stdoutTick, streamEvidence.stderrTick);
  const readCount = streamEvidence.reads;
  const geometry = () => ({ detailWidth: document.querySelector('#detail-pane')!.getBoundingClientRect().width, listWidth: document.querySelector('#inventory-pane')!.getBoundingClientRect().width });
  record('captured live pane before keyboard resize', { ...identity, ...initial, ...geometry(), beforeTick, readCount });
  assert(initial.max - initial.width >= 20 || initial.width - initial.min >= 20, 'Pane bounds leave no complete keyboard resize step');
  const key = initial.max - initial.width >= 20 ? 'ArrowRight' : 'ArrowLeft';
  const expected = Math.max(initial.min, Math.min(initial.max, initial.width + (key === 'ArrowRight' ? 20 : -20)));
  assert(expected !== initial.width, 'No pane space available for keyboard resizing');
  separator.focus(); separator.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  await waitFor(() => nativePaneSize(document)?.width === expected, 'keyboard changes announced navigation width');
  await waitFor(() => streamEvidence.stdoutTick >= beforeTick + 3 && streamEvidence.stderrTick >= beforeTick + 3 && streamEvidence.reads > readCount + 2, 'same native follow continues during pane resizing');
  const preserved = () => content() === log && log.textContent === frozenText && Math.abs(log.scrollTop - scrollTop) <= 1
    && panel().querySelector('.log-fetched-at time') === receipt && receipt?.getAttribute('datetime') === receivedAt
    && panel().querySelector<HTMLInputElement>('.log-search-input')?.value === 'NATIVE_SMOKE_LIVE'
    && button('재개', panel()).getAttribute('aria-pressed') === 'true';
  assert(preserved(), 'Resizing reset the paused search, receipt, scroll, or log DOM');
  const resized = nativePaneSize(document)!;
  assert(Math.abs(geometry().listWidth - resized.width) <= 1, 'Announced navigation width does not match the actual pane');
  record('resized live pane with keyboard while receiving', { ...identity, ...resized, ...geometry(), key, afterTick: Math.min(streamEvidence.stdoutTick, streamEvidence.stderrTick), newReads: streamEvidence.reads - readCount, preservedView: true });
  separator.dispatchEvent(new KeyboardEvent('keydown', { key: key === 'ArrowRight' ? 'ArrowLeft' : 'ArrowRight', bubbles: true }));
  await waitFor(() => nativePaneSize(document)?.width === initial.width, 'keyboard restores original navigation width');
  assert(preserved() && streamEvidence.streamId === identity.streamId && streamEvidence.starts === starts && streamEvidence.maximumActiveReads === 1, 'Restoring navigation width replaced the stream or display');
  record('restored live pane without replacing the stream', { ...identity, ...nativePaneSize(document), ...geometry(), preservedView: true, maximumActiveReads: streamEvidence.maximumActiveReads });
  closeLogSearch(); click('재개', panel());
}
async function clearCancelProbe() {
  await ready(); closeLogSearch();
  const starts = streamEvidence.starts; const stops = streamEvidence.stops;
  record('requested live Clear', { streamId: streamEvidence.streamId, fullId: streamEvidence.fullId, starts });
  click('로그 화면 비우기', panel());
  await waitFor(() => streamEvidence.stops > stops && !panel().querySelector('.log-fetched-at'), 'Clear stops native stream and removes receipt');
  const reads = streamEvidence.reads;
  await new Promise(resolve => setTimeout(resolve, 600));
  assert(streamEvidence.reads === reads && content().textContent?.includes('로그 조회를'), 'Clear kept polling or restored old logs');
  const before = nativeCheckpoint(document); click('새로고침');
  await waitFor(() => readyNativeInventory(document, before), 'inventory refresh after Clear');
  assert(streamEvidence.starts === starts && !panel().querySelector('.log-fetched-at'), 'Refresh undid explicit Clear');
  record('Clear stopped polling and remained cleared after Refresh', { streamId: streamEvidence.streamId, fullId: streamEvidence.fullId, stoppedStreams: streamEvidence.stops - stops, readsAfterClear: reads, starts });
}

async function detailTabsProbe() {
  await ready(); closeLogSearch();
  const beforeRefresh = nativeCheckpoint(document);
  click('새로고침');
  await waitFor(() => readyNativeInventory(document, beforeRefresh), 'new inventory before detail tabs');
  await ready();
  if (panel().querySelector('.log-pause-toggle')?.getAttribute('aria-pressed') !== 'true') click('일시정지', panel());
  await waitFor(() => panel().querySelector('.log-pause-toggle')?.getAttribute('aria-pressed') === 'true', 'paused logs before detail tabs');
  click('로그 검색 열기', panel());
  await waitFor(() => panel().querySelector('.log-search-input'), 'log search before detail tabs');
  input('NATIVE_SMOKE');
  await waitFor(() => panel().querySelector('mark'), 'native fixture log search match');
  const log = content(); const frozenText = log.textContent;
  log.scrollTop = Math.min(80, log.scrollHeight - log.clientHeight); log.dispatchEvent(new Event('scroll'));
  const scrollTop = log.scrollTop;
  const identity = { streamId: streamEvidence.streamId, fullId: streamEvidence.fullId };
  const starts = streamEvidence.starts; const previousDetailsReads = detailsReads;
  record('captured log view before detail tabs', { ...identity, starts });
  click('상태 진단');
  await waitFor(() => detailsReads === previousDetailsReads + 1 && document.querySelector('.container-insights')?.getAttribute('aria-busy') === 'false', 'real native diagnostic response');
  const diagnostic = document.querySelector<HTMLElement>('.container-insights');
  assert(diagnostic && diagnostic.getBoundingClientRect().height > 0, 'Diagnostic tab is not visible');
  assert(diagnostic.textContent?.includes('종료 코드 137만으로') && diagnostic.textContent?.includes('상태 검사 결과가 비정상'), 'Factual exit/OOM/health diagnostics missing');
  const output = diagnostic.querySelector<HTMLDetailsElement>('.insights-output-disclosure');
  assert(output && !output.open, 'Health output is not initially collapsed');
  output.querySelector('summary')!.click();
  await waitFor(() => output.open, 'health output disclosure opens');
  assert(output.querySelector('pre')?.textContent === 'NATIVE_SMOKE_HEALTH_FAILURE <b>refused</b>' && !output.querySelector('b'), 'Health output was altered or interpreted as HTML');
  const details = lastDetails;
  assert(details && details.fullId === identity.fullId && details.diagnostics.health?.recentFailures.length === 1, 'Diagnostic UI lacks the matching IPC identity');
  record('native diagnostics and bounded health output verified', { fullId: details.fullId, exitCode: details.diagnostics.exitCode, oomKilled: details.diagnostics.oomKilled, healthConfigured: details.diagnostics.healthConfigured, healthFailures: details.diagnostics.health.recentFailures.length });
  click('접속 정보');
  await waitFor(() => document.querySelector('.container-insights')?.textContent?.includes('호스트에서 접속'), 'native connection tab');
  const connections = document.querySelector<HTMLElement>('.container-insights')!;
  assert(connections.getBoundingClientRect().height > 0 && button('주소 복사: 127.0.0.1:15432', connections) && button('주소 복사: [::1]:15432', connections) && button('주소 복사: native-api', connections), 'Native connection candidates are missing');
  assert(connections.textContent?.includes('53/UDP') && connections.textContent?.includes('호스트에 게시되지 않음'), 'Unpublished UDP observation missing');
  assert(!connections.querySelector('button[aria-label="주소 복사: 0.0.0.0:15432"], button[aria-label="주소 복사: [::]:15432"]'), 'Wildcard binding offered as a copyable address');
  record('native connection candidates verified', { ipv4Candidate: '127.0.0.1:15432', ipv6Candidate: '[::1]:15432', alias: 'native-api', unpublishedUdp: true });
  click('로그');
  await waitFor(() => !log.closest('[hidden]'), 'log tab is visible again');
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  const preservedView = content() === log && log.textContent === frozenText && Math.abs(log.scrollTop - scrollTop) <= 1
    && panel().querySelector<HTMLInputElement>('.log-search-input')?.value === 'NATIVE_SMOKE'
    && panel().querySelector('.log-pause-toggle')?.getAttribute('aria-pressed') === 'true';
  assert(preservedView && streamEvidence.streamId === identity.streamId && streamEvidence.starts === starts && detailsReads === previousDetailsReads + 1, 'Detail tabs replaced the log state, stream or shared detail snapshot');
  record('restored logs after all three tabs', { ...identity, starts: streamEvidence.starts, preservedView, detailsReads: detailsReads - previousDetailsReads, maximumActiveReads: streamEvidence.maximumActiveReads });
}

async function projectRecoveryProbe() {
  await ready();
  const previous = nativeCheckpoint(document);
  // Keep this response-recovery probe independent of the existing Busy guard
  // for an automatic inventory refresh racing its setup Reconnect.
  const setupSession = lastInventoryReply?.sessionId;
  assert(setupSession, 'Native setup session is missing');
  const hold = await observationApi.hold(setupSession);
  try {
    click('다시 연결');
    await waitFor(() => readyNativeInventory(document, previous), 'new native inventory after Reconnect', 20_000);
  } finally { await observationApi.release(setupSession, hold.holdId); }
  await selectStandalone();
  failProjectConfigureReply = true;
  const projectNode = document.querySelector<HTMLElement>('.project-tree-item .project-tree-name');
  assert(projectNode?.textContent === 'native-smoke-project', 'Owned project row is missing');
  projectNode.click();
  await waitFor(() => document.querySelector('.project-logs')?.textContent?.includes('NATIVE_SMOKE_INITIAL_CONFIGURE_FAILURE'), 'initial configure error displayed');
  assert(document.querySelectorAll('.project-log-row').length === 0, 'Initial failure reused an earlier session page');
  const retriesBefore = projectRetries;
  click('수집 재개');
  await waitFor(() => projectRetries === retriesBefore + 1 && visibleLogTimes().length > 0, 'native retry logs in visible viewport', 20_000);
  assert(!document.querySelector('.project-logs')?.textContent?.includes('NATIVE_SMOKE_INITIAL_CONFIGURE_FAILURE'), 'Collection error remained after retry');
  record('native project retry restored visible logs', { nativeRetries: projectRetries - retriesBefore, visibleLogRows: visibleLogTimes().length, errorCleared: true });
}

function Harness() {
  const [, update] = useState(0);
  const [open, setOpen] = useState(true);
  const [running, setRunning] = useState(false);
  changed = () => update(value => value + 1);
  async function run(name: string, probe: () => Promise<void>) {
    setRunning(true);
    report.status = 'running';
    record(`started ${name}`);
    try { await probe(); report.status = report.failures.length ? 'failed' : 'passed'; record(`passed ${name}`); }
    catch (error) { report.status = 'failed'; report.failures.push(error instanceof Error ? error.message : String(error)); record(`failed ${name}`); }
    finally { setRunning(false); }
  }
  return <aside aria-label="Native smoke harness" style={{ position: 'fixed', zIndex: 10000, top: 4, left: 4, width: open ? 410 : 'auto', maxHeight: '96vh', overflow: 'auto', padding: 10, background: '#fff', color: '#172b3a', border: '2px solid #2764a6', borderRadius: 8, font: '12px/1.5 system-ui' }}>
    <button onClick={() => setOpen(value => !value)}>{open ? 'Hide native smoke controls' : 'Show native smoke controls'}</button>
    {open && <><h2 style={{ fontSize: 16 }}>Native smoke · isolated real IPC</h2><p>Arm the next Engine failure, or remove/restore the fixture socket using the runner before its corresponding probe. No real Docker is used. Legacy probes select the projectless native-smoke-3. Bind its ready stream before arming faults or enabling live-on; keep live-off for dense search.</p>
      <label>Worker mode <select disabled={running} value={mode} onChange={event => { sessionStorage.setItem(marker, event.target.value); location.reload(); }}><option value="worker">Real Worker</option><option value="constructor-fail">Injected constructor failure</option><option value="never-ready">Suppress ready for timeout</option></select></label>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, margin: '8px 0' }}>
        <button disabled={running} onClick={() => void run('terminal-roundtrip', async () => { const binding = await terminalRoundtripProbe(record); assert(!report.binding || JSON.stringify(report.binding) === JSON.stringify(binding), 'Native fixture changed during this page run'); report.binding = binding; })}>Run native terminal roundtrip</button>
        <button disabled={running} onClick={() => void run('project-recovery', projectRecoveryProbe)}>Run project initial-response recovery</button>
        <button disabled={running} onClick={() => void run('observation-baseline', async () => { const binding = await captureObservationBaseline(record); assert(!report.binding || JSON.stringify(report.binding) === JSON.stringify(binding), 'Native fixture changed during this page run'); report.binding = binding; })}>Capture project observation baseline</button>
        <button disabled={running} onClick={() => void run('observation-restore', () => verifyObservationRestore(record))}>Verify minimized collection / restore</button>
        <button disabled={running} onClick={() => void run('detail-tabs', detailTabsProbe)}>Run native diagnostics / connection tabs</button>
        <button disabled={running} onClick={() => void run('project-stats', projectStatsProbe)}>Run project / stats probe</button>
        <button disabled={running} onClick={() => void run('live-display', liveDisplayProbe)}>Run live pause / search</button>
        <button disabled={running} onClick={() => void run('pane-resize', paneResizeProbe)}>Run live pane keyboard resize</button>
        <button disabled={running} onClick={() => void run('pinned-refresh', pinnedRefreshProbe)}>Run pinned stream Refresh</button>
        <button disabled={running} onClick={() => void run('clear-cancel', clearCancelProbe)}>Run Clear cancellation</button>
        <button disabled={running} onClick={() => void run('search', searchProbe)}>Run search probe</button>
        <button disabled={running} onClick={() => void run('connection-clear', clearProbe)}>Run Clear / Engine failure</button>
        <button disabled={running} onClick={() => void run('socket', socketProbe)}>Run missing-socket probe</button>
        <button disabled={running} onClick={() => void run('recovery', recoveryProbe)}>Run Refresh / Reconnect</button>
      </div><p role="status">Native smoke status: {report.status}</p><textarea aria-label="Native smoke JSON report" readOnly value={JSON.stringify(report, null, 2)} rows={14} style={{ width: '100%', font: '11px/1.4 monospace', color: '#172b3a', background: '#f5f7fa' }} /></>}
  </aside>;
}
createRoot(document.getElementById('native-smoke-panel')!).render(<Harness />);
