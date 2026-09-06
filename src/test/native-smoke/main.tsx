import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import App from '../../App';
import '../../styles.css';
import { initializePreferences } from '../../preferences';
import { nativeCheckpoint, readyNativeLogs, type NativeCheckpoint } from './readiness';

const marker = 'NATIVE_SMOKE_HARNESS';
type Mode = 'worker' | 'constructor-fail' | 'never-ready';
type Evidence = { name: string; timeMs: number; detail?: Record<string, unknown> };
type Binding = { runId: string; binarySha256: string; startedAtMs: number };
const storedMode = sessionStorage.getItem(marker);
const mode: Mode = storedMode === 'constructor-fail' || storedMode === 'never-ready' ? storedMode : 'worker';
const report = { marker, mode, nativeIpc: '__TAURI_INTERNALS__' in window, status: 'ready', binding: null as Binding | null, steps: [] as Evidence[], workerEvents: [] as Evidence[], failures: [] as string[] };
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
  const value = Array.from(document.querySelectorAll<HTMLElement>('.logs-panel')).find(element => !element.hidden);
  assert(value, 'Select a fixture container with an inline log panel');
  return value;
}
function content() {
  const value = panel().querySelector<HTMLPreElement>('.log-content');
  assert(value, 'Log content is unavailable');
  return value;
}
function button(name: string, scope: ParentNode = document.querySelector('.app-shell')!) {
  const value = Array.from(scope.querySelectorAll<HTMLButtonElement>('button')).find(element => !element.closest('[hidden]') && (element.getAttribute('aria-label') === name || element.textContent?.trim() === name));
  assert(value, `Button missing: ${name}`);
  return value;
}
function click(name: string, scope?: ParentNode) {
  const target = button(name, scope);
  assert(!target.disabled, `Button disabled: ${name}`);
  target.click();
}
function warned() { return document.querySelector('.footer-connection')?.textContent?.includes('연결 재확인 필요'); }
function blocked() {
  const actions = Array.from(document.querySelectorAll<HTMLButtonElement>('.recovery-actions button'));
  assert(actions.length === 3, 'Expected all three production recovery buttons');
  return actions.every(element => element.disabled);
}
async function ready(previous?: NativeCheckpoint) {
  assert(report.nativeIpc, 'This entry must run inside the packaged native validation app');
  let acceptedText = '';
  await waitFor(() => {
    const accepted = readyNativeLogs(document, previous);
    if (!accepted) return false;
    acceptedText = accepted.text;
    return true;
  }, previous ? 'new inventory and log timestamps, settled IPC, and the complete 2 MiB response' : 'settled native IPC and the complete 2 MiB fixture logs');
  assert(document.querySelector('.app-shell')?.textContent?.includes('native-smoke-local'), 'The app is not connected to the isolated fixture');
  const header = acceptedText.split('\n', 1)[0]!;
  assert(header.startsWith('NATIVE_SMOKE_RUN '), 'Fixture launch identity is missing from the real native log response');
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
  await ready();
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
  assert(button('로그 조회', panel()).disabled, 'Clear released the native IPC slot too early');
  await waitFor(warned, 'the delayed native Engine identity failure');
  assert(blocked(), 'Recovery actions remained available after a native session failure');
  assert(!panel().querySelector('.log-error'), 'An invalidated error replaced the cleared log view');
  assert(!panel().querySelector('.log-fetched-at'), 'Clear left a stale log timestamp');
  assert(button('표시된 로그 복사', panel()).disabled, 'Cleared logs are still copyable');
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
  click('새로고침');
  await ready(beforeRefresh);
  assert(warned() && blocked(), 'A successful Refresh/read cleared the session warning');
  record('warning retained after successful Refresh and logs');
  const beforeReconnect = nativeCheckpoint(document);
  click('다시 연결');
  await ready(beforeReconnect);
  await waitFor(() => !warned(), 'a fresh valid session');
  assert(!button('중지', document.querySelector('.recovery-actions')!).disabled, 'Fresh session did not restore recovery availability');
  record('explicit reconnect restored the valid session');
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
    {open && <><h2 style={{ fontSize: 16 }}>Native smoke · isolated real IPC</h2><p>Arm the next Engine failure, or remove/restore the fixture socket using the runner before its corresponding probe. No real Docker is used.</p>
      <label>Worker mode <select disabled={running} value={mode} onChange={event => { sessionStorage.setItem(marker, event.target.value); location.reload(); }}><option value="worker">Real Worker</option><option value="constructor-fail">Injected constructor failure</option><option value="never-ready">Suppress ready for timeout</option></select></label>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, margin: '8px 0' }}>
        <button disabled={running} onClick={() => void run('search', searchProbe)}>Run search probe</button>
        <button disabled={running} onClick={() => void run('connection-clear', clearProbe)}>Run Clear / Engine failure</button>
        <button disabled={running} onClick={() => void run('socket', socketProbe)}>Run missing-socket probe</button>
        <button disabled={running} onClick={() => void run('recovery', recoveryProbe)}>Run Refresh / Reconnect</button>
      </div><p role="status">Native smoke status: {report.status}</p><textarea aria-label="Native smoke JSON report" readOnly value={JSON.stringify(report, null, 2)} rows={14} style={{ width: '100%', font: '11px/1.4 monospace', color: '#172b3a', background: '#f5f7fa' }} /></>}
  </aside>;
}
createRoot(document.getElementById('native-smoke-panel')!).render(<Harness />);
