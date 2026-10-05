import { Channel, invoke, isTauri } from '@tauri-apps/api/core';
import type { CoreError } from './api';
import { frontendError } from './frontendErrors';

export type TerminalShell = 'sh' | 'bash';
export type TerminalStatus = 'connecting' | 'running' | 'exited' | 'disconnected' | 'failed';
export interface TerminalDescriptor {
  sessionId: string; terminalId: string; containerId: string; containerName: string;
  shell: TerminalShell; status: TerminalStatus; exitCode: number | null; error: CoreError | null;
}
export type TerminalEvent = { kind: 'status'; terminal: TerminalDescriptor }
  | { kind: 'output'; sessionId: string; terminalId: string; sequence: number; bytes: number[] };
async function call<T>(command: string, args: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw frontendError('nativeRequired');
  return invoke<T>(command, args);
}
export const terminalApi = {
  start: (sessionId: string, generation: number, handle: string, shell: TerminalShell, cols: number, rows: number, receive: (event: TerminalEvent) => void) => {
    if (!isTauri()) return Promise.reject<TerminalDescriptor>(frontendError('nativeRequired'));
    const onEvent = new Channel<TerminalEvent>();
    onEvent.onmessage = receive;
    return call<TerminalDescriptor>('start_container_terminal', { sessionId, generation, handle, shell, cols, rows, onEvent });
  },
  write: (sessionId: string, terminalId: string, bytes: number[]) => call<void>('write_container_terminal', { sessionId, terminalId, bytes }),
  resize: (sessionId: string, terminalId: string, cols: number, rows: number) => call<void>('resize_container_terminal', { sessionId, terminalId, cols, rows }),
  ack: (sessionId: string, terminalId: string, throughSequence: number) => call<void>('ack_container_terminal', { sessionId, terminalId, throughSequence }),
  disconnect: (sessionId: string, terminalId: string) => call<void>('disconnect_container_terminal', { sessionId, terminalId }),
  close: (sessionId: string, terminalId: string) => call<void>('close_container_terminal', { sessionId, terminalId }),
};
