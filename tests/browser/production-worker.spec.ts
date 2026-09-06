import { readFile, readdir } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

test('loads the production Worker under the unchanged application CSP', async ({ page }) => {
  // CI builds before browser checks. Serve only the emitted Worker in an isolated
  // same-origin probe; the production app never imports this synthetic harness.
  const assets = await readdir('dist/assets');
  const filename = assets.find(name => /^logSearch\.worker-.*\.js$/.test(name));
  expect(filename, 'Run pnpm build before the browser checks').toBeDefined();
  const worker = await readFile(`dist/assets/${filename}`, 'utf8');
  const config = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8'));
  await page.route('**/__worker-probe.html', route => route.fulfill({
    contentType: 'text/html', headers: { 'Content-Security-Policy': config.app.security.csp },
    body: '<!doctype html><html><body><output>waiting</output><script type="module" src="/__worker-probe.js"></script></body></html>',
  }));
  await page.route('**/__production-worker.js', route => route.fulfill({ contentType: 'text/javascript', body: worker }));
  await page.route('**/__worker-probe.js', route => route.fulfill({ contentType: 'text/javascript', body: `
    const output = document.querySelector('output');
    const worker = new Worker('/__production-worker.js', { type: 'module' });
    worker.onerror = () => { output.textContent = 'Worker failed'; };
    worker.onmessage = ({ data }) => {
      if (data.type === 'ready') {
        worker.postMessage({ type: 'snapshot', snapshotId: 1, text: 'a'.repeat(2 * 1024 * 1024) });
        worker.postMessage({ type: 'search', snapshotId: 1, searchId: 1, query: 'a' });
      } else if (data.type === 'result') {
        output.textContent = String(data.total);
        worker.terminate();
      }
    };
  ` }));
  await page.goto('/__worker-probe.html');
  await expect(page.locator('output')).toHaveText('2097152');
});
