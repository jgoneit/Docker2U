import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import App from '../../App';
import { coreError } from '../../api';
import { composeApi } from '../../composeApi';
import '../../styles.css';
import { initializePreferences } from '../../preferences';
import { captureObservationBaseline, verifyObservationRestore } from './observationProbes';
import { terminalRoundtripProbe } from './terminalProbes';
import { standaloneIncidentProbe, standaloneArchiveProbe } from './standaloneProbes';

type Evidence = { name: string; timeMs: number; detail?: Record<string, unknown> };
type Binding = { runId: string; binarySha256: string; startedAtMs: number };
const report = { marker: 'NATIVE_SMOKE_HARNESS', mode: 'worker', coverageProfile: 'group-observation-v2',
  nativeIpc: '__TAURI_INTERNALS__' in window, status: 'ready', binding: null as Binding | null,
  steps: [] as Evidence[], workerEvents: [] as Evidence[], failures: [] as string[] };
let changed = () => {};
function record(name: string, detail?: Record<string, unknown>) {
  report.steps.push({ name, timeMs: Date.now(), detail }); changed();
}
function bind(binding: Binding) {
  if (report.binding && JSON.stringify(report.binding) !== JSON.stringify(binding)) throw new Error('Native fixture changed during this page run');
  report.binding = binding;
}

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

// The active native product uses retained group logs. Historical CLI LogPanel
// and Worker probe evidence remains supported by the Python validator only.
localStorage.setItem('docker2u.preferences.v1', JSON.stringify({ theme: 'light', language: 'ko' }));
initializePreferences();
createRoot(document.getElementById('root')!).render(<App />);

function Harness() {
  const [, update] = useState(0);
  const [open, setOpen] = useState(true);
  const [running, setRunning] = useState(false);
  changed = () => update(value => value + 1);
  async function run(name: string, probe: () => Promise<Binding | void>) {
    setRunning(true); report.status = 'running'; record(`started ${name}`);
    try { const binding = await probe(); if (binding) bind(binding); report.status = report.failures.length ? 'failed' : 'passed'; record(`passed ${name}`); }
    catch (error) { report.status = 'failed'; report.failures.push(error instanceof Error ? error.message : String(error)); record(`failed ${name}`); }
    finally { setRunning(false); }
  }
  return <aside aria-label="Native smoke harness" style={{ position: 'fixed', zIndex: 10000, top: 4, left: 4, width: open ? 410 : 'auto', maxHeight: '96vh', overflow: 'auto', padding: 10, background: '#fff', color: '#172b3a', border: '2px solid #2764a6', borderRadius: 8, font: '12px/1.5 system-ui' }}>
    <button onClick={() => setOpen(value => !value)}>{open ? 'Hide native smoke controls' : 'Show native smoke controls'}</button>
    {open && <><h2 style={{ fontSize: 16 }}>Native smoke · isolated real IPC</h2>
      <p>Standalone flow: launch with --fixture-mode standalone → run incident → runner standalone-recreate → verify archived ID → runner standalone-remove-all → verify empty group. Controls change only owned synthetic fixture files.</p>
      <p>Keep this page/session open between stages. A failed attempt remains failed evidence; relaunch for a fresh complete run. Default mode supports the existing Compose observation and terminal probes.</p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, margin: '8px 0' }}>
        <button disabled={running} onClick={() => void run('standalone-incident', () => standaloneIncidentProbe(record))}>Run standalone incident roundtrip</button>
        <button disabled={running} onClick={() => void run('standalone-archive', () => standaloneArchiveProbe(record))}>Verify standalone archived ID</button>
        <button disabled={running} onClick={() => void run('standalone-empty', () => standaloneArchiveProbe(record, true))}>Verify empty standalone group</button>
        <button disabled={running} onClick={() => void run('terminal-roundtrip', () => terminalRoundtripProbe(record))}>Run native terminal roundtrip</button>
        <button disabled={running} onClick={() => void run('observation-baseline', () => captureObservationBaseline(record))}>Capture project observation baseline</button>
        <button disabled={running} onClick={() => void run('observation-restore', () => verifyObservationRestore(record))}>Verify minimized collection / restore</button>
      </div><p role="status">Native smoke status: {report.status}</p><textarea aria-label="Native smoke JSON report" readOnly value={JSON.stringify(report, null, 2)} rows={14} style={{ width: '100%', font: '11px/1.4 monospace', color: '#172b3a', background: '#f5f7fa' }} /></>}
  </aside>;
}
createRoot(document.getElementById('native-smoke-panel')!).render(<Harness />);
