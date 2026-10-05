import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Container } from './api';
import { terminalApi, type TerminalDescriptor, type TerminalEvent } from './terminalApi';
import { observationApi, type ObservationHold } from './observationApi';
import { TerminalRegistry } from './terminalRegistry';

const fake = vi.hoisted(() => ({ terms: [] as Array<{
  options: Record<string, unknown>; cols: number; rows: number; writes: Uint8Array[]; callbacks: (() => void)[]; resize: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>; fit: ReturnType<typeof vi.fn>; open: ReturnType<typeof vi.fn>; focus: ReturnType<typeof vi.fn>;
  parser: { registerOscHandler: ReturnType<typeof vi.fn> }; data?: (text: string) => void; binary?: (text: string) => void;
}> }));
vi.mock('@xterm/xterm', () => ({ Terminal: class {
  options; cols = 80; rows = 24; writes: Uint8Array[] = []; callbacks: (() => void)[] = [];
  dispose = vi.fn(); fit = vi.fn(); open = vi.fn(); focus = vi.fn(); parser = { registerOscHandler: vi.fn() };
  resize = vi.fn((cols: number, rows: number) => { this.cols = cols; this.rows = rows; });
  data?: (text: string) => void; binary?: (text: string) => void;
  constructor(options: Record<string, unknown>) { this.options = options; fake.terms.push(this); }
  loadAddon(addon: { fit: () => void }) { this.fit = vi.fn(() => { this.cols = 100; this.rows = 30; }); addon.fit = this.fit; }
  onData(listener: (text: string) => void) { this.data = listener; }
  onBinary(listener: (text: string) => void) { this.binary = listener; }
  write(bytes: Uint8Array, callback: () => void) { this.writes.push(bytes); this.callbacks.push(callback); }
  paste(text: string) { this.data?.(text); } getSelection() { return 'selected output'; }
} }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));

const container = (id = 'a'): Container => ({ handle: `handle-${id}`, fullId: id.repeat(64), shortId: id.repeat(12), name: `container-${id}`, image: 'fixture', state: 'running', health: null, healthConfigured: false, ports: [], createdAt: '', composeProject: null, composeService: null });
const descriptor = (id = 'a', sessionId = 's'): TerminalDescriptor => ({ sessionId, terminalId: `terminal-${id}`, containerId: id.repeat(64), containerName: `container-${id}`, shell: 'sh', status: 'connecting', exitCode: null, error: null });
const hold = (sessionId = 's', holdId = 'held'): ObservationHold => ({ sessionId, holdId, inventory: { sessionId, generation: 17, stale: false, refreshedAt: '',
  containers: [...'abcdefghi'].map(id => ({ ...container(id), handle: `held-handle-${id}` })) } });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
let registry: TerminalRegistry;
let receive: (event: TerminalEvent) => void;
beforeEach(() => {
  fake.terms.length = 0; vi.restoreAllMocks();
  let holdNumber = 0;
  vi.spyOn(observationApi, 'hold').mockImplementation(async sessionId => hold(sessionId, `held-${++holdNumber}`));
  vi.spyOn(observationApi, 'release').mockResolvedValue();
  for (const name of ['write', 'resize', 'ack', 'disconnect', 'close'] as const) vi.spyOn(terminalApi, name).mockResolvedValue();
  vi.spyOn(terminalApi, 'start').mockImplementation(async (sessionId, _generation, handle, _shell, _cols, _rows, listener) => {
    receive = listener; return descriptor(handle.slice(-1), sessionId);
  });
  registry = new TerminalRegistry(); registry.setSession('s');
});
afterEach(() => { registry.reset(); document.body.replaceChildren(); });
async function running(id = 'a') {
  await registry.connect('s', 7, container(id), 'sh');
  receive({ kind: 'status', terminal: { ...descriptor(id), status: 'running' } });
}
async function settleInput() { await new Promise(resolve => setTimeout(resolve, 0)); }

describe('terminal session ownership and flow control', () => {
  it('starts only once for the exact ID using the held opaque handle/generation instead of the UI snapshot', async () => {
    await running();
    await registry.connect('s', 8, { ...container(), handle: 'refreshed' }, 'bash');
    expect(terminalApi.start).toHaveBeenCalledTimes(1);
    expect(terminalApi.start).toHaveBeenCalledWith('s', 17, 'held-handle-a', 'sh', 80, 24, expect.any(Function));
    expect(observationApi.hold).toHaveBeenCalledExactlyOnceWith('s');
    expect(observationApi.release).toHaveBeenCalledExactlyOnceWith('s', 'held-1');
    expect(fake.terms[0]!.options).toMatchObject({ scrollback: 2_000, screenReaderMode: true });
  });
  it('handles status/output before the start reply without regressing to connecting', async () => {
    vi.mocked(terminalApi.start).mockImplementation(async (_s, _g, _h, _sh, _c, _r, listener) => {
      listener({ kind: 'status', terminal: { ...descriptor(), status: 'running' } });
      listener({ kind: 'output', sessionId: 's', terminalId: 'terminal-a', sequence: 1, bytes: [27, 91, 51, 49, 109] });
      return descriptor();
    });
    await registry.connect('s', 1, container(), 'sh');
    expect(registry.getSnapshot()[0]!.status).toBe('running');
    expect(fake.terms[0]!.writes[0]).toEqual(new Uint8Array([27, 91, 51, 49, 109]));
  });
  it('preserves split UTF-8 bytes and ACKs only after xterm processes each chunk', async () => {
    await running();
    for (const [index, bytes] of [[0xea, 0xb0], [0x80]].entries()) receive({ kind: 'output', sessionId: 's', terminalId: 'terminal-a', sequence: index + 1, bytes });
    expect(terminalApi.ack).not.toHaveBeenCalled();
    const term = fake.terms[0]!;
    expect(term.writes.map(bytes => [...bytes])).toEqual([[0xea, 0xb0], [0x80]]);
    term.callbacks[0]!(); term.callbacks[1]!();
    expect(vi.mocked(terminalApi.ack).mock.calls).toEqual([['s', 'terminal-a', 1], ['s', 'terminal-a', 2]]);
  });
  it('ignores duplicates and output belonging to another session or terminal', async () => {
    await running();
    const output: TerminalEvent = { kind: 'output', sessionId: 's', terminalId: 'terminal-a', sequence: 1, bytes: [65] };
    receive(output); receive(output); receive({ ...output, sequence: 2, sessionId: 'old' }); receive({ ...output, sequence: 2, terminalId: 'other' });
    expect(fake.terms[0]!.writes).toHaveLength(1);
  });
  it('retains the same terminal DOM and output while its panel is detached', async () => {
    await running();
    const first = document.createElement('div'), next = document.createElement('div'); document.body.append(first, next);
    registry.attach(container().fullId, first); const host = first.firstChild;
    registry.detach(container().fullId, first);
    receive({ kind: 'output', sessionId: 's', terminalId: 'terminal-a', sequence: 1, bytes: [65] });
    fake.terms[0]!.callbacks[0]!();
    registry.attach(container().fullId, next);
    expect(next.firstChild).toBe(host); expect(fake.terms[0]!.open).toHaveBeenCalledTimes(1);
    expect(terminalApi.ack).toHaveBeenCalledWith('s', 'terminal-a', 1);
  });
  it('never resizes a hidden/zero-sized surface and fits the visible terminal', async () => {
    await running(); const parent = document.createElement('div'); document.body.append(parent);
    registry.attach(container().fullId, parent); registry.fit(container().fullId);
    expect(terminalApi.resize).not.toHaveBeenCalled();
    const host = parent.firstElementChild!;
    Object.defineProperties(host, { clientWidth: { value: 600 }, clientHeight: { value: 320 } });
    registry.fit(container().fullId); registry.fit(container().fullId);
    expect(terminalApi.resize).toHaveBeenCalledExactlyOnceWith('s', 'terminal-a', 100, 30);
  });
  it('retains exited slots at the eight-session cap until explicitly closed', async () => {
    for (const id of 'abcdefgh') { await running(id); receive({ kind: 'status', terminal: { ...descriptor(id), status: 'exited', exitCode: 0 } }); }
    await registry.connect('s', 7, container('i'), 'sh');
    expect(terminalApi.start).toHaveBeenCalledTimes(8); expect(registry.getSnapshot()).toHaveLength(8);
    await registry.close(container().fullId); await registry.connect('s', 7, container('i'), 'sh');
    expect(terminalApi.start).toHaveBeenCalledTimes(9); expect(registry.getSnapshot()).toHaveLength(8);
  });
  it('keeps oversized repeated fits clamped to the native size without duplicate resize requests', async () => {
    await running(); const parent = document.createElement('div'); document.body.append(parent);
    registry.attach(container().fullId, parent);
    Object.defineProperties(parent.firstElementChild!, { clientWidth: { value: 6_000 }, clientHeight: { value: 4_000 } });
    const term = fake.terms[0]!; term.fit.mockImplementation(() => { term.cols = 700; term.rows = 300; });
    registry.fit(container().fullId); registry.fit(container().fullId);
    expect(term.cols).toBe(500); expect(term.rows).toBe(200); expect(term.resize).toHaveBeenCalledTimes(2);
    expect(terminalApi.resize).toHaveBeenCalledExactlyOnceWith('s', 'terminal-a', 500, 200);
  });
  it('keeps a disconnected session and its output until close', async () => {
    await running(); await registry.disconnect(container().fullId);
    expect(registry.getSnapshot()[0]!.status).toBe('disconnected'); expect(fake.terms[0]!.dispose).not.toHaveBeenCalled();
    registry.write(container().fullId, new Uint8Array([3])); await settleInput(); expect(terminalApi.write).not.toHaveBeenCalled();
    await registry.close(container().fullId); expect(fake.terms[0]!.dispose).toHaveBeenCalledOnce(); expect(registry.getSnapshot()).toHaveLength(0);
  });
  it('allows explicit removal after a failed start without automatic retries', async () => {
    vi.mocked(terminalApi.start).mockRejectedValue({ code: 'ExecFailed', message: 'Shell missing' });
    await registry.connect('s', 7, container(), 'bash');
    expect(registry.getSnapshot()[0]).toMatchObject({ status: 'failed', error: { code: 'ExecFailed' } });
    await registry.close(container().fullId); expect(registry.getSnapshot()).toHaveLength(0); expect(terminalApi.start).toHaveBeenCalledOnce();
    expect(observationApi.release).toHaveBeenCalledExactlyOnceWith('s', 'held-1');
  });
  it('discards old Channel callbacks and closes a late start reply after reconnect', async () => {
    let finish!: (result: TerminalDescriptor) => void;
    vi.mocked(terminalApi.start).mockImplementation((_s, _g, _h, _sh, _c, _r, listener) => { receive = listener; return new Promise(resolve => { finish = resolve; }); });
    const pending = registry.connect('s', 7, container(), 'sh');
    await settleInput();
    registry.setSession('new'); receive({ kind: 'status', terminal: { ...descriptor(), status: 'running' } });
    expect(observationApi.release).toHaveBeenCalledExactlyOnceWith('s', 'held-1');
    finish(descriptor()); await pending;
    expect(registry.getSnapshot()).toHaveLength(0); expect(terminalApi.close).toHaveBeenCalledWith('s', 'terminal-a');
    expect(observationApi.release).toHaveBeenCalledTimes(1);
  });
  it('does not ACK writes whose callbacks arrive after reconnect', async () => {
    await running(); receive({ kind: 'output', sessionId: 's', terminalId: 'terminal-a', sequence: 1, bytes: [65] });
    registry.setSession('new'); fake.terms[0]!.callbacks[0]!(); expect(terminalApi.ack).not.toHaveBeenCalled();
  });
  it('serializes Unicode input, preserves control bytes, and chunks large paste', async () => {
    await running(); const term = fake.terms[0]!;
    term.data!('한글'); term.data!('\x03'); term.binary!('\xff'); registry.write(container().fullId, new Uint8Array(20_000)); await settleInput();
    const chunks = vi.mocked(terminalApi.write).mock.calls.map(call => call[2]);
    expect(chunks[0]).toEqual([...new TextEncoder().encode('한글')]); expect(chunks[1]).toEqual([3]); expect(chunks[2]).toEqual([255]);
    expect(chunks.slice(3).map(chunk => chunk.length)).toEqual([16_384, 3_616]);
  });
  it('stops queued input after an uncertain write and never retries it', async () => {
    await running(); vi.mocked(terminalApi.write).mockRejectedValue(new Error('Transport lost'));
    registry.write(container().fullId, new Uint8Array(20_000)); registry.write(container().fullId, new Uint8Array([3])); await settleInput();
    expect(terminalApi.write).toHaveBeenCalledOnce(); expect(registry.getSnapshot()[0]!.status).toBe('failed');
  });
  it('blocks output-triggered clipboard and link escape handlers', async () => {
    await running(); const term = fake.terms[0]!;
    expect(term.parser.registerOscHandler.mock.calls.map(call => call[0])).toEqual([52, 8]);
    for (const [, handler] of term.parser.registerOscHandler.mock.calls) expect(handler('unsafe')).toBe(true);
    expect(term.options.windowOptions).toEqual({});
  });
  it('reserves duplicate/capacity slots before holds resolve and dispatches each exec once', async () => {
    const held = Array.from({ length: 8 }, () => deferred<ObservationHold>());
    vi.mocked(observationApi.hold).mockImplementation(() => held[vi.mocked(observationApi.hold).mock.calls.length - 1]!.promise);
    const starts = [...'abcdefgh'].map(id => registry.connect('s', 1, container(id), 'sh'));
    await registry.connect('s', 2, container('a'), 'bash'); await registry.connect('s', 2, container('i'), 'sh');
    expect(registry.getSnapshot()).toHaveLength(8); expect(observationApi.hold).toHaveBeenCalledTimes(8); expect(terminalApi.start).not.toHaveBeenCalled();
    held.forEach((pending, index) => pending.resolve(hold('s', `reserved-${index}`))); await Promise.all(starts);
    expect(terminalApi.start).toHaveBeenCalledTimes(8); expect(observationApi.release).toHaveBeenCalledTimes(8);
  });
  it('waits for an in-flight inventory refresh and resolves only the original full ID in its held result', async () => {
    const pendingHold = deferred<ObservationHold>(); vi.mocked(observationApi.hold).mockReturnValue(pendingHold.promise);
    const pending = registry.connect('s', 1, { ...container(), name: 'same-name' }, 'sh');
    expect(terminalApi.start).not.toHaveBeenCalled();
    const held = hold(); held.inventory.generation = 42;
    held.inventory.containers = [{ ...container('b'), name: 'same-name', handle: 'replacement-b' }, { ...container(), name: 'renamed', handle: 'fresh-a' }];
    pendingHold.resolve(held); await pending;
    expect(terminalApi.start).toHaveBeenCalledExactlyOnceWith('s', 42, 'fresh-a', 'sh', 80, 24, expect.any(Function));
    expect(observationApi.release).toHaveBeenCalledExactlyOnceWith('s', 'held');
  });
  it.each(['missing', 'same-name replacement', 'stopped', 'stale', 'hold session', 'inventory session'] as const)('rejects a %s held target without starting and releases the original session hold', async kind => {
    const held = hold();
    if (kind === 'missing') held.inventory.containers = [];
    if (kind === 'same-name replacement') held.inventory.containers = [{ ...container('b'), name: container().name }];
    if (kind === 'stopped') held.inventory.containers = [{ ...container(), state: 'exited' }];
    if (kind === 'stale') held.inventory.stale = true;
    if (kind === 'hold session') held.sessionId = 'other';
    if (kind === 'inventory session') held.inventory.sessionId = 'other';
    vi.mocked(observationApi.hold).mockResolvedValue(held);
    await registry.connect('s', 7, container(), 'sh');
    expect(terminalApi.start).not.toHaveBeenCalled();
    expect(registry.getSnapshot()[0]).toMatchObject({ status: 'failed', pending: false, terminalId: null });
    expect(observationApi.release).toHaveBeenCalledExactlyOnceWith('s', 'held');
  });
  it('reports hold acquisition failure without an exec or an invented release token', async () => {
    vi.mocked(observationApi.hold).mockRejectedValue({ code: 'NeedsValidation', message: 'Inventory unavailable' });
    await registry.connect('s', 7, container(), 'sh');
    expect(registry.getSnapshot()[0]).toMatchObject({ status: 'failed', error: { code: 'NeedsValidation' } });
    expect(terminalApi.start).not.toHaveBeenCalled(); expect(observationApi.release).not.toHaveBeenCalled();
  });
  it.each(['close', 'reconnect'] as const)('releases a late hold after %s without dispatching an old exec', async action => {
    const pendingHold = deferred<ObservationHold>(); vi.mocked(observationApi.hold).mockReturnValueOnce(pendingHold.promise);
    const pending = registry.connect('s', 7, container(), 'sh');
    if (action === 'close') await registry.close(container().fullId); else registry.setSession('new');
    expect(registry.getSnapshot()).toHaveLength(0); expect(fake.terms[0]!.dispose).toHaveBeenCalledOnce();
    pendingHold.resolve(hold('s', 'late-held')); await pending;
    expect(terminalApi.start).not.toHaveBeenCalled(); expect(observationApi.release).toHaveBeenCalledExactlyOnceWith('s', 'late-held');
  });
  it('releases an acquired hold on close and closes a late exec result without starting again', async () => {
    const started = deferred<TerminalDescriptor>(); vi.mocked(terminalApi.start).mockReturnValue(started.promise);
    const pending = registry.connect('s', 7, container(), 'sh'); await settleInput();
    await registry.close(container().fullId);
    expect(registry.getSnapshot()).toHaveLength(0); expect(observationApi.release).toHaveBeenCalledExactlyOnceWith('s', 'held-1');
    started.resolve(descriptor()); await pending;
    expect(terminalApi.start).toHaveBeenCalledOnce(); expect(terminalApi.close).toHaveBeenCalledExactlyOnceWith('s', 'terminal-a');
    expect(observationApi.release).toHaveBeenCalledTimes(1);
  });
  it('releases after a strict start rejection without retrying exec or masking the original failure', async () => {
    vi.mocked(terminalApi.start).mockRejectedValue({ code: 'StaleHandle', message: 'Explicit refresh raced the hold' });
    vi.mocked(observationApi.release).mockRejectedValue({ code: 'ReleaseFailed', message: 'Release transport failed' });
    await registry.connect('s', 7, container(), 'sh');
    await registry.connect('s', 8, container(), 'sh');
    expect(terminalApi.start).toHaveBeenCalledOnce(); expect(observationApi.release).toHaveBeenCalledOnce();
    expect(registry.getSnapshot()[0]).toMatchObject({ status: 'failed', error: { code: 'StaleHandle' } });
  });
});
