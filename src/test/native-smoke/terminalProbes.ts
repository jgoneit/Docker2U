import { terminalApi, type TerminalDescriptor } from '../../terminalApi';
import { captureObservationBaseline } from './observationProbes';

type RecordStep = (name: string, detail?: Record<string, unknown>) => void;
type Capture = { starts: number; descriptor: TerminalDescriptor | null; outputEvents: number; outputBytes: number; ackedSequence: number; ansiObserved: boolean };
const fullId = '1'.padStart(64, '0');
let active: Capture | null = null;
const nativeStart = terminalApi.start;
terminalApi.start = async (session, generation, handle, shell, cols, rows, receive) => {
  const capture = active;
  if (capture) ++capture.starts;
  const result = await nativeStart(session, generation, handle, shell, cols, rows, event => {
    if (capture && active === capture) {
      if (event.kind === 'status') capture.descriptor = event.terminal;
      else {
        ++capture.outputEvents; capture.outputBytes += event.bytes.length;
        capture.ansiObserved ||= event.bytes.includes(27);
      }
    }
    receive(event);
  });
  if (capture && active === capture && !capture.descriptor) capture.descriptor = result;
  return result;
};
const nativeAck = terminalApi.ack;
terminalApi.ack = async (...args) => {
  await nativeAck(...args);
  if (active?.descriptor?.terminalId === args[1] && active.descriptor.sessionId === args[0]) active.ackedSequence = Math.max(active.ackedSequence, args[2]);
};

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
async function waitFor(check: () => unknown, description: string, timeout = 15_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (active?.descriptor?.error) throw new Error(`Native terminal failed: ${active.descriptor.error.code}`);
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error(`Timed out: ${description}`);
}
async function selectContainer(number: 1 | 2) {
  const project = [...document.querySelectorAll<HTMLElement>('.project-tree-item')].find(node => node.querySelector('.project-tree-name')?.textContent === 'native-smoke-project');
  assert(project, 'Owned native project is missing');
  if (project.getAttribute('aria-expanded') === 'false') project.querySelector<HTMLButtonElement>('.project-disclosure')!.click();
  await waitFor(() => document.querySelector(`.container-row[title="native-smoke-${number}"]`), 'fixture container row');
  document.querySelector<HTMLElement>(`.container-row[title="native-smoke-${number}"]`)!.click();
  await waitFor(() => document.querySelector(`.container-row[title="native-smoke-${number}"]`)?.getAttribute('aria-selected') === 'true', 'fixture container selection');
}
async function tab(name: 'terminal' | 'logs') {
  await waitFor(() => document.querySelector(`[data-detail-tab="${name}"]`), `${name} detail tab`);
  document.querySelector<HTMLButtonElement>(`[data-detail-tab="${name}"]`)!.click();
  await waitFor(() => document.querySelector(`[data-detail-tab="${name}"]`)?.getAttribute('aria-selected') === 'true', `${name} selected`);
}
function emulator() { return document.querySelector<HTMLElement>(`.terminal-emulator[data-container-id="${fullId}"]`); }
function screenText() { return emulator()?.querySelector('.xterm-accessibility-tree')?.textContent ?? ''; }
function visible() {
  const node = emulator(); if (!node || node.closest('[hidden]')) return false;
  const rect = node.getBoundingClientRect();
  return rect.width > 100 && rect.height > 100 && rect.right > 0 && rect.left < innerWidth && rect.bottom > 0 && rect.top < innerHeight;
}

/** Drives the product UI and observes real Rust IPC. This is not a physical IME test. */
export async function terminalRoundtripProbe(record: RecordStep) {
  const binding = await captureObservationBaseline(record);
  await selectContainer(1); await tab('terminal');
  const previous = document.querySelector<HTMLButtonElement>('.container-terminal .terminal-close');
  if (previous) {
    assert(!previous.disabled, 'Wait for the retained terminal before rerunning this probe');
    previous.click();
    await waitFor(() => document.querySelector('.terminal-connect'), 'previous terminal explicitly closed');
  }
  const capture: Capture = { starts: 0, descriptor: null, outputEvents: 0, outputBytes: 0, ackedSequence: 0, ansiObserved: false };
  active = capture;
  try {
    await waitFor(() => { const button = document.querySelector<HTMLButtonElement>('.terminal-connect'); return button && !button.disabled; }, 'explicit native Connect enabled');
    document.querySelector<HTMLButtonElement>('.terminal-connect')!.click();
    await waitFor(() => capture.descriptor?.status === 'running' && screenText().includes('NATIVE_TERMINAL_READY') && capture.ackedSequence > 0, 'native exec greeting rendered and acknowledged');
    assert(capture.descriptor?.containerId === fullId && capture.starts === 1, 'Native terminal is not bound to the selected full ID');
    const { sessionId, terminalId } = capture.descriptor;
    const identity = { sessionId, terminalId, fullId };
    emulator()!.scrollIntoView({ block: 'center' });
    await waitFor(visible, 'actual xterm surface in the viewport');
    record('native terminal connected', { ...identity, startRequests: capture.starts, outputEvents: capture.outputEvents, outputBytes: capture.outputBytes, ackedSequence: capture.ackedSequence, running: true, screenVisible: true, ansiObserved: capture.ansiObserved });
    const write = (text: string) => terminalApi.write(sessionId, terminalId, [...new TextEncoder().encode(text)]);
    await write('echo NATIVE_TERMINAL_ECHO 한글🙂\r');
    await waitFor(() => screenText().includes('NATIVE_TERMINAL_ECHO 한글🙂'), 'Unicode echo in rendered xterm accessibility output');
    await write('echo interrupted\x03');
    await waitFor(() => screenText().includes('^C'), 'Ctrl-C terminal output');
    await terminalApi.resize(sessionId, terminalId, 113, 37);
    await write('stty size\r');
    await waitFor(() => screenText().includes('37 113'), 'native resize confirmed by synthetic stty');
    record('native terminal commands rendered', { ...identity, unicodeVisible: true, interruptVisible: true, sizeVisible: true, resizeCols: 113, resizeRows: 37, outputEvents: capture.outputEvents, outputBytes: capture.outputBytes, ackedSequence: capture.ackedSequence });
    const same = emulator();
    await selectContainer(2); await tab('logs');
    assert(same && !same.isConnected, 'Leaving the terminal did not detach its surface');
    const before = capture.outputEvents;
    await write('echo NATIVE_TERMINAL_RETAINED\r');
    await waitFor(() => capture.outputEvents > before, 'hidden native terminal receives output');
    await selectContainer(1); await tab('terminal');
    await waitFor(() => screenText().includes('NATIVE_TERMINAL_RETAINED') && visible(), 'retained terminal output after navigation');
    assert(emulator() === same && capture.descriptor?.terminalId === terminalId && capture.descriptor.status === 'running' && capture.starts === 1, 'Navigation replaced the native terminal');
    record('native terminal retained across navigation', { ...identity, startRequests: capture.starts, sameEmulator: true, switchedContainerId: '2'.padStart(64, '0'), hiddenOutputEvents: capture.outputEvents - before, retainedOutputVisible: true });
    await write('exit 7\r');
    await waitFor(() => capture.descriptor?.status === 'exited' && capture.descriptor.exitCode === 7 && document.querySelector('.terminal-status[data-status="exited"]'), 'native exit status shown in product UI');
    record('native terminal exited', { ...identity, status: 'exited', exitCode: 7, startRequests: capture.starts, outputEvents: capture.outputEvents, outputBytes: capture.outputBytes, ackedSequence: capture.ackedSequence });
    return binding;
  } finally { active = null; }
}
