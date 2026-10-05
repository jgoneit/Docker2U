import { beforeEach, expect, it, vi } from 'vitest';
import { terminalApi, type TerminalEvent } from './terminalApi';
const native = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: vi.fn(), channels: [] as Array<{ onmessage?: (event: TerminalEvent) => void }> }));
vi.mock('@tauri-apps/api/core', () => ({ ...native, Channel: class { onmessage?: (event: TerminalEvent) => void; constructor() { native.channels.push(this); } } }));
beforeEach(() => { native.invoke.mockReset().mockResolvedValue(undefined); native.isTauri.mockReturnValue(true); native.channels.length = 0; });
it('binds start to session/generation/handle and transports output through a Channel', async () => {
  const receive = vi.fn();
  await terminalApi.start('session', 7, 'opaque', 'bash', 80, 24, receive);
  expect(native.invoke).toHaveBeenCalledExactlyOnceWith('start_container_terminal', { sessionId: 'session', generation: 7, handle: 'opaque', shell: 'bash', cols: 80, rows: 24, onEvent: native.channels[0] });
  const event: TerminalEvent = { kind: 'output', sessionId: 'session', terminalId: 'terminal', sequence: 1, bytes: [0xea, 0xb0, 0x80] };
  native.channels[0]!.onmessage!(event); expect(receive).toHaveBeenCalledExactlyOnceWith(event);
});
it('uses only the native-issued terminal identity after start', async () => {
  await terminalApi.write('s', 't', [3]); await terminalApi.resize('s', 't', 120, 40); await terminalApi.ack('s', 't', 4); await terminalApi.disconnect('s', 't'); await terminalApi.close('s', 't');
  expect(native.invoke.mock.calls).toEqual([
    ['write_container_terminal', { sessionId: 's', terminalId: 't', bytes: [3] }],
    ['resize_container_terminal', { sessionId: 's', terminalId: 't', cols: 120, rows: 40 }],
    ['ack_container_terminal', { sessionId: 's', terminalId: 't', throughSequence: 4 }],
    ['disconnect_container_terminal', { sessionId: 's', terminalId: 't' }], ['close_container_terminal', { sessionId: 's', terminalId: 't' }],
  ]);
});
it('rejects browser calls and does not automatically retry uncertain input', async () => {
  native.isTauri.mockReturnValue(false);
  await expect(terminalApi.start('s', 1, 'h', 'sh', 80, 24, () => {})).rejects.toMatchObject({ code: 'NATIVE_REQUIRED' });
  expect(native.invoke).not.toHaveBeenCalled(); expect(native.channels).toHaveLength(0);
  native.isTauri.mockReturnValue(true); const error = { code: 'TerminalInputUnknown', message: 'Unknown write outcome' }; native.invoke.mockRejectedValue(error);
  await expect(terminalApi.write('s', 't', [3])).rejects.toBe(error); expect(native.invoke).toHaveBeenCalledOnce();
});
