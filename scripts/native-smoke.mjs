import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = resolve(repository, '.cache/native-smoke');
const configuration = resolve(directory, 'tauri.json');
const target = resolve(repository, 'src-tauri/target');
const bundledApp = resolve(target, 'release/bundle/macos/Docker2U Native Smoke.app');
const [command = 'help', ...args] = process.argv.slice(2);

function run(executable, arguments_, options = {}) {
  return new Promise((done, fail) => {
    const child = spawn(executable, arguments_, { cwd: repository, stdio: 'inherit', ...options });
    const forward = signal => child.kill(signal);
    const interrupt = () => forward('SIGINT');
    const terminate = () => forward('SIGTERM');
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
    child.on('error', fail);
    child.on('exit', (code, signal) => {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', terminate);
      if (code === 0) done();
      else fail(new Error(`Native smoke command exited with ${code ?? signal}`));
    });
  });
}

if (command === 'build') {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Native smoke requires an Apple Silicon Mac');
  await mkdir(directory, { recursive: true });
  const production = JSON.parse(await readFile(resolve(repository, 'src-tauri/tauri.conf.json'), 'utf8'));
  const buildId = randomUUID().replaceAll('-', '');
  const app = resolve(directory, 'bundles', buildId, 'Docker2U Native Smoke.app');
  const override = {
    productName: 'Docker2U Native Smoke',
    identifier: `io.github.jgoneit.docker2u.native-smoke.${buildId}`,
    build: {
      beforeBuildCommand: 'pnpm icons && pnpm exec vite build --config vite.native-smoke.config.ts',
      frontendDist: resolve(directory, 'dist'),
    },
    app: { windows: production.app.windows.map(window => ({ ...window, title: 'Docker2U Native Smoke — isolated fixture', incognito: true })) },
  };
  await writeFile(configuration, JSON.stringify(override, null, 2) + '\n');
  await run(process.execPath, ['scripts/with-toolchain.mjs', 'pnpm', 'exec', 'tauri', 'build', '--bundles', 'app', '--config', configuration, '--ci', '--no-sign', '--', '--locked'], { env: { ...process.env, CARGO_TARGET_DIR: target } });
  // NSWorkspace caches bundle identity by path. Retain one path per identifier
  // so Computer Use cannot resolve a rebuilt app to the previous bundle ID.
  await mkdir(dirname(app), { recursive: true });
  await cp(bundledApp, app, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true, verbatimSymlinks: true });
  await writeFile(resolve(directory, 'build.json'), JSON.stringify({
    marker: 'NATIVE_SMOKE_HARNESS', app, bundledApp,
    productionCsp: production.app.security.csp,
    productionCspSha256: createHash('sha256').update(production.app.security.csp).digest('hex'),
    override,
  }, null, 2) + '\n');
  console.log(`Validation bundle: ${app}\nProduction CSP and Rust IPC are unchanged. This is a test-only bundle.`);
} else if (['launch', 'status', 'arm-engine-change', 'socket-off', 'socket-on', 'stop', 'report'].includes(command)) {
  const appArguments = [];
  if (command === 'launch' && !args.some(value => value === '--app' || value.startsWith('--app='))) {
    const build = JSON.parse(await readFile(resolve(directory, 'build.json'), 'utf8'));
    if (typeof build.app !== 'string') throw new Error('Build metadata is missing the validation app path');
    appArguments.push('--app', build.app);
  }
  await run('/usr/bin/python3', ['scripts/native-smoke-fixture.py', command, ...appArguments, ...args]);
} else {
  console.log(`Native smoke (test-only packaged App with real Rust IPC):
  pnpm native:smoke build        Build a distinct, incognito validation bundle
  pnpm native:smoke launch [--app path.app]  Run the recorded build with an isolated fake CLI/socket
  pnpm native:smoke status       Show only owned run metadata and trace summary
  pnpm native:smoke arm-engine-change  Delay the next info response for 3s, then change identity
  pnpm native:smoke socket-off   Remove only the fixture socket before a log read
  pnpm native:smoke socket-on    Restore the fixture socket before recovery checks
  pnpm native:smoke report [--ui-results path.json]  Combine CLI trace with the UI JSON report
  pnpm native:smoke stop         Stop only the owned validation run and archive evidence

The test page offers search, Clear/connection, socket-error and recovery probes.
Read the page report through Computer Use and save its JSON for the combined report.
Never use this validation bundle as the final production app.`);
}
