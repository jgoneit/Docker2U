import { api, type ContainerList } from '../api';
import { terminalApi, type TerminalDescriptor, type TerminalEvent } from '../terminalApi';

/** Development-only terminal transport. Input is interpreted locally, never executed. */
export function installTerminalFixture() {
  let inventory: ContainerList | null = null;
  let nextId = 0;
  const calls = { start: 0, write: 0, resize: 0, ack: 0, disconnect: 0, close: 0 };
  Object.assign(window, { __docker2uTerminalCalls: calls });
  const originalList = api.listContainers;
  api.listContainers = async (...args) => { const result = await originalList(...args); inventory = result; return result; };
  type FixtureTerminal = { descriptor: TerminalDescriptor; receive: (event: TerminalEvent) => void; sequence: number; input: string; cols: number; rows: number; decoder: TextDecoder };
  const sessions = new Map<string, FixtureTerminal>();
  const output = (entry: FixtureTerminal, text: string) => entry.receive({ kind: 'output', sessionId: entry.descriptor.sessionId, terminalId: entry.descriptor.terminalId, sequence: ++entry.sequence, bytes: Array.from(new TextEncoder().encode(text)) });
  const status = (entry: FixtureTerminal, value: TerminalDescriptor['status']) => { entry.descriptor = { ...entry.descriptor, status: value }; entry.receive({ kind: 'status', terminal: entry.descriptor }); };
  const find = (sessionId: string, terminalId: string) => {
    const entry = sessions.get(terminalId);
    if (!entry || entry.descriptor.sessionId !== sessionId) throw { code: 'TerminalNotFound', message: 'Fixture terminal no longer exists.' };
    return entry;
  };
  Object.assign(terminalApi, {
    start: async (sessionId, generation, handle, shell, cols, rows, receive) => {
      ++calls.start;
      const container = inventory?.containers.find(item => item.handle === handle);
      if (!container || inventory?.sessionId !== sessionId || inventory.generation !== generation) throw { code: 'StaleHandle', message: 'Fixture terminal target is stale.' };
      if (container.state !== 'running') throw { code: 'InvalidState', message: 'Fixture container is not running.' };
      const descriptor: TerminalDescriptor = { sessionId, terminalId: `fixture-terminal-${++nextId}`, containerId: container.fullId, containerName: container.name, shell, status: 'connecting', exitCode: null, error: null };
      const entry: FixtureTerminal = { descriptor, receive, sequence: 0, input: '', cols, rows, decoder: new TextDecoder() };
      sessions.set(descriptor.terminalId, entry);
      if (shell === 'bash' && container.fullId.startsWith('c')) {
        entry.descriptor.error = { code: 'ExecFailed', message: 'Fixture /bin/bash does not exist in this container.' };
        status(entry, 'failed');
      } else { status(entry, 'running'); output(entry, `Container ${container.name}\r\n$ `); }
      return descriptor;
    },
    write: async (sessionId, terminalId, bytes) => {
      ++calls.write; const entry = find(sessionId, terminalId); if (entry.descriptor.status !== 'running') return;
      for (const character of entry.decoder.decode(new Uint8Array(bytes), { stream: true })) {
        if (character === '\x03') { entry.input = ''; output(entry, '^C\r\n$ '); }
        else if (character === '\r' || character === '\n') {
          const command = entry.input.trim(); entry.input = ''; output(entry, '\r\n');
          if (command === 'exit') { entry.descriptor.exitCode = 0; status(entry, 'exited'); break; }
          if (command === 'pwd') output(entry, '/app\r\n');
          else if (command === 'stty size') output(entry, `${entry.rows} ${entry.cols}\r\n`);
          else if (command.startsWith('echo ')) output(entry, `${command.slice(5)}\r\n`);
          else if (command.startsWith('printf ')) output(entry, '\x1b[32mANSI_GREEN\x1b[0m · 한글\r\n');
          else if (command) output(entry, `Fixture command: ${command}\r\n`);
          output(entry, '$ ');
        } else if (character === '\x7f') { entry.input = entry.input.slice(0, -1); output(entry, '\b \b'); }
        else { entry.input += character; output(entry, character); }
      }
    },
    resize: async (sessionId, terminalId, cols, rows) => { ++calls.resize; const entry = find(sessionId, terminalId); entry.cols = cols; entry.rows = rows; },
    ack: async () => { ++calls.ack; },
    disconnect: async (sessionId, terminalId) => { ++calls.disconnect; status(find(sessionId, terminalId), 'disconnected'); },
    close: async (sessionId, terminalId) => { ++calls.close; find(sessionId, terminalId); sessions.delete(terminalId); },
  } satisfies typeof terminalApi);
}
