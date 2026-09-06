import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const dist = resolve('dist');
const markers = ['LAST_LINE_300', 'visual-fixture-local', 'fixture.invalid', 'SIMULATED ONLY', 'NATIVE_SMOKE_HARNESS', 'NATIVE_SMOKE_END', 'Docker2U Native Smoke', '__docker2uRejectLogs'];
async function inspect(directory) {
  let checked = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) checked += await inspect(path);
    else if (entry.isFile()) {
      const contents = await readFile(path, 'utf8');
      const marker = markers.find(value => contents.includes(value));
      if (marker) throw new Error(`Production output contains fixture marker ${JSON.stringify(marker)}: ${path}`);
      checked += 1;
    }
  }
  return checked;
}
const checked = await inspect(dist);
if (!checked) throw new Error('Production output is empty; build before checking fixture isolation.');
console.log(`Production fixture isolation passed (${checked} files inspected).`);
