import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { delimiter, resolve } from 'node:path';
import { spawn } from 'node:child_process';

// Official rustup supports CARGO_HOME/RUSTUP_HOME. Prefer a prepared local
// development toolchain without changing the user's shell or system install.
const root = fileURLToPath(new URL('..', import.meta.url));
const tools = resolve(root, '../.docker2u-tools');
const env = { ...process.env };
if (existsSync(resolve(tools, 'cargo/bin/cargo'))) {
  env.CARGO_HOME = resolve(tools, 'cargo');
  env.RUSTUP_HOME = resolve(tools, 'rustup');
  env.PATH = `${resolve(tools, 'cargo/bin')}${delimiter}${env.PATH ?? ''}`;
}
const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error('Usage: node scripts/with-toolchain.mjs <executable> [args]');
const child = spawn(command, args, { cwd: root, env, stdio: 'inherit', shell: false });
child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = signal ? 1 : (code ?? 1); });
