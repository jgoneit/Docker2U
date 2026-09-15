import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { coreError, type Container, type CoreError } from './api';
import { terminalApi, type TerminalDescriptor, type TerminalEvent, type TerminalShell, type TerminalStatus } from './terminalApi';
import { observationApi } from './observationApi';

export const TERMINAL_LIMIT = 8;
export const TERMINAL_SCROLLBACK = 2_000;
const CHUNK_BYTES = 16 * 1024;
const INPUT_LIMIT = 256 * 1024;
export interface TerminalView {
  containerId: string; containerName: string; shell: TerminalShell; status: TerminalStatus;
  terminalId: string | null; exitCode: number | null; error: CoreError | null; pending: boolean;
}
interface Entry {
  view: TerminalView; sessionId: string; term: Terminal; fit: FitAddon; host: HTMLDivElement;
  live: boolean; sequence: number; inputBytes: number; input: Promise<void>; opened: boolean;
  size: { cols: number; rows: number } | null;
  holdId: string | null;
}

/** Owns terminal instances independently of the selected detail tab/container. */
export class TerminalRegistry {
  private entries = new Map<string, Entry>();
  private listeners = new Set<() => void>();
  private snapshot: TerminalView[] = [];
  private sessionId: string | null = null;
  onError?: (error: CoreError, sessionId: string) => void;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.snapshot;
  private publish() { this.snapshot = [...this.entries.values()].map(entry => ({ ...entry.view })); this.listeners.forEach(listener => listener()); }
  private current(entry: Entry) { return entry.live && entry.sessionId === this.sessionId && this.entries.get(entry.view.containerId) === entry; }
  setSession(sessionId: string | null) {
    if (this.sessionId === sessionId) return;
    this.reset(); this.sessionId = sessionId;
  }
  reset() {
    for (const entry of this.entries.values()) this.release(entry);
    this.entries.clear(); this.sessionId = null; this.publish();
  }
  private release(entry: Entry) {
    entry.live = false; entry.term.dispose(); entry.host.remove();
    void this.releaseHold(entry);
    if (entry.view.terminalId) void terminalApi.close(entry.sessionId, entry.view.terminalId).catch(() => {});
  }
  private async releaseHold(entry: Entry) {
    const holdId = entry.holdId; entry.holdId = null;
    if (!holdId) return;
    try { await observationApi.release(entry.sessionId, holdId); }
    catch (error) {
      if (!this.current(entry)) return;
      const failure = coreError(error);
      // Cleanup must not replace a more specific exec/start failure.
      if (!entry.view.error) { entry.view.error = failure; this.publish(); }
      this.onError?.(failure, entry.sessionId);
    }
  }
  private fail(entry: Entry, error: unknown) {
    if (!this.current(entry)) return;
    entry.view.error = coreError(error); entry.view.pending = false; this.publish();
    this.onError?.(entry.view.error, entry.sessionId);
  }
  private descriptor(entry: Entry, value: TerminalDescriptor) {
    if (value.sessionId !== entry.sessionId || value.containerId !== entry.view.containerId
      || (entry.view.terminalId && entry.view.terminalId !== value.terminalId)) return;
    entry.view = { ...entry.view, terminalId: value.terminalId, status: value.status, exitCode: value.exitCode, error: value.error, pending: false };
    entry.term.options.disableStdin = value.status !== 'running';
    this.publish();
    if (value.error) this.onError?.(value.error, entry.sessionId);
  }
  private event(entry: Entry, event: TerminalEvent) {
    if (!this.current(entry)) return;
    if (event.kind === 'status') { this.descriptor(entry, event.terminal); return; }
    if (event.sessionId !== entry.sessionId || (entry.view.terminalId && event.terminalId !== entry.view.terminalId)
      || event.sequence <= entry.sequence) return;
    if (!entry.view.terminalId) entry.view.terminalId = event.terminalId;
    entry.sequence = event.sequence;
    entry.term.write(new Uint8Array(event.bytes), () => {
      if (this.current(entry)) void terminalApi.ack(entry.sessionId, event.terminalId, event.sequence).catch(error => this.fail(entry, error));
    });
  }
  async connect(sessionId: string, _generation: number, container: Container, shell: TerminalShell) {
    if (sessionId !== this.sessionId || this.entries.has(container.fullId) || this.entries.size >= TERMINAL_LIMIT) return;
    const term = new Terminal({ cols: 80, rows: 24, scrollback: TERMINAL_SCROLLBACK, cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, monospace', fontSize: 12, lineHeight: 1.2,
      convertEol: false, disableStdin: true, screenReaderMode: true,
      // Never follow output-provided OSC 8 URLs or permit terminal clipboard reads/writes.
      linkHandler: { activate: () => {} }, windowOptions: {} });
    term.parser.registerOscHandler(52, () => true);
    term.parser.registerOscHandler(8, () => true);
    const fit = new FitAddon(); term.loadAddon(fit);
    const host = document.createElement('div'); host.className = 'terminal-emulator';
    host.dataset.containerId = container.fullId;
    const entry: Entry = { sessionId, term, fit, host, live: true, sequence: 0, opened: false, size: null, holdId: null, inputBytes: 0, input: Promise.resolve(),
      view: { containerId: container.fullId, containerName: container.name, shell, status: 'connecting', terminalId: null, exitCode: null, error: null, pending: true } };
    this.entries.set(container.fullId, entry);
    term.onData(data => this.write(container.fullId, new TextEncoder().encode(data)));
    term.onBinary(data => this.write(container.fullId, Uint8Array.from(data, character => character.charCodeAt(0))));
    this.publish();
    try {
      if (!this.current(entry)) return;
      // Observation can refresh handles between UI polls. Reserve the current
      // inventory before resolving the original full ID; never follow its name.
      const hold = await observationApi.hold(sessionId);
      entry.holdId = hold.holdId;
      if (!this.current(entry)) return;
      if (hold.sessionId !== sessionId || hold.inventory.sessionId !== sessionId) throw { code: 'StaleSession', message: 'The reserved inventory belongs to another Engine session.' };
      if (hold.inventory.stale) throw { code: 'NeedsValidation', message: 'Refresh before connecting to the terminal.' };
      const target = hold.inventory.containers.find(item => item.fullId === container.fullId);
      if (!target) throw { code: 'StaleHandle', message: 'The selected container no longer exists in the reserved inventory.' };
      if (target.state !== 'running') throw { code: 'InvalidState', message: 'The selected container is not running.' };
      const result = await terminalApi.start(sessionId, hold.inventory.generation, target.handle, shell, term.cols, term.rows, event => this.event(entry, event));
      if (!this.current(entry)) { void terminalApi.close(sessionId, result.terminalId).catch(() => {}); return; }
      // A status/output Channel event can precede the start reply; never regress it.
      if (!entry.view.terminalId) this.descriptor(entry, result);
      else if (entry.view.terminalId !== result.terminalId) throw new Error('Terminal identity changed during connection.');
      entry.view.pending = false; this.publish(); this.fit(container.fullId);
    } catch (error) {
      if (!this.current(entry)) return;
      entry.view.status = 'failed'; entry.term.options.disableStdin = true; this.fail(entry, error);
    } finally { await this.releaseHold(entry); }
  }
  attach(containerId: string, parent: HTMLElement) {
    const entry = this.entries.get(containerId); if (!entry) return;
    parent.appendChild(entry.host);
    if (!entry.opened) { entry.term.open(entry.host); entry.opened = true; }
    this.theme(containerId); this.fit(containerId);
  }
  detach(containerId: string, parent: HTMLElement) {
    const entry = this.entries.get(containerId);
    if (entry?.host.parentElement === parent) entry.host.remove();
  }
  theme(containerId: string) {
    const entry = this.entries.get(containerId); if (!entry) return;
    const dark = document.documentElement.dataset.theme !== 'light';
    entry.term.options.theme = dark
      ? { background: '#171b22', foreground: '#e4e9f0', cursor: '#86c5ff', selectionBackground: '#365372',
        black: '#222833', red: '#ff7b72', green: '#7ee787', yellow: '#e3b341', blue: '#79c0ff', magenta: '#d2a8ff', cyan: '#76e3ea', white: '#cbd5e1',
        brightBlack: '#7f8fa3', brightRed: '#ffa198', brightGreen: '#a5f3b5', brightYellow: '#f2cc60', brightBlue: '#a5d6ff', brightMagenta: '#e2c5ff', brightCyan: '#b3f0f4', brightWhite: '#f8fafc' }
      : { background: '#f8fafc', foreground: '#1e293b', cursor: '#1b5dae', selectionBackground: '#b9d6f8',
        black: '#1e293b', red: '#a91f1b', green: '#197341', yellow: '#916400', blue: '#245db1', magenta: '#8c399c', cyan: '#087787', white: '#64748b',
        brightBlack: '#526175', brightRed: '#c33429', brightGreen: '#197a42', brightYellow: '#916400', brightBlue: '#2b65bb', brightMagenta: '#9843a5', brightCyan: '#087787', brightWhite: '#334155' };
  }
  fit(containerId: string) {
    const entry = this.entries.get(containerId);
    if (!entry?.opened || !entry.host.isConnected || entry.host.clientWidth < 40 || entry.host.clientHeight < 40) return;
    entry.fit.fit();
    const cols = Math.min(500, entry.term.cols), rows = Math.min(200, entry.term.rows);
    if (cols < 2 || rows < 1) return;
    if (cols !== entry.term.cols || rows !== entry.term.rows) entry.term.resize(cols, rows);
    if (entry.size?.cols === cols && entry.size.rows === rows) return;
    if (entry.view.terminalId && entry.view.status === 'running') {
      entry.size = { cols, rows };
      void terminalApi.resize(entry.sessionId, entry.view.terminalId, cols, rows).catch(error => this.fail(entry, error));
    }
  }
  focus(containerId: string) { this.entries.get(containerId)?.term.focus(); }
  selection(containerId: string) { return this.entries.get(containerId)?.term.getSelection() ?? ''; }
  paste(containerId: string, text: string) { const entry = this.entries.get(containerId); if (entry?.view.status === 'running') entry.term.paste(text); }
  write(containerId: string, bytes: Uint8Array) {
    const entry = this.entries.get(containerId);
    if (!entry?.view.terminalId || !this.current(entry) || entry.view.status !== 'running') return;
    if (entry.inputBytes + bytes.length > INPUT_LIMIT) { this.fail(entry, { code: 'TerminalInputLimit', message: 'The terminal input buffer is full. Paste a smaller selection.' }); return; }
    entry.inputBytes += bytes.length;
    entry.input = entry.input.then(async () => {
      for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
        if (!this.current(entry) || entry.view.status !== 'running') break;
        await terminalApi.write(entry.sessionId, entry.view.terminalId!, Array.from(bytes.subarray(offset, offset + CHUNK_BYTES)));
      }
    }).catch(error => {
      if (this.current(entry)) { entry.view.status = 'failed'; entry.term.options.disableStdin = true; }
      this.fail(entry, error);
    }).finally(() => { entry.inputBytes -= bytes.length; });
  }
  async disconnect(containerId: string) {
    const entry = this.entries.get(containerId); if (!entry?.view.terminalId || entry.view.pending) return;
    entry.view.pending = true; this.publish();
    try {
      await terminalApi.disconnect(entry.sessionId, entry.view.terminalId);
      if (this.current(entry)) { entry.view.status = 'disconnected'; entry.view.pending = false; entry.term.options.disableStdin = true; this.publish(); }
    } catch (error) { this.fail(entry, error); }
  }
  async close(containerId: string) {
    const entry = this.entries.get(containerId); if (!entry) return;
    if (entry.view.pending) {
      if (entry.view.status !== 'connecting') return;
      this.entries.delete(containerId); this.release(entry); this.publish(); return;
    }
    entry.view.pending = true; this.publish();
    try {
      if (entry.view.terminalId) await terminalApi.close(entry.sessionId, entry.view.terminalId);
      if (this.current(entry)) { entry.live = false; entry.term.dispose(); entry.host.remove(); this.entries.delete(containerId); this.publish(); await this.releaseHold(entry); }
    } catch (error) { this.fail(entry, error); }
  }
}
