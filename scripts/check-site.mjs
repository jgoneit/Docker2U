import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { chromium } from '@playwright/test';

const root = resolve('site');
const output = resolve('.cache/site-screenshots');
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    if (!url.pathname.startsWith('/Docker2U/')) throw new Error('Unknown path');
    const relative = decodeURIComponent(url.pathname.slice('/Docker2U/'.length)) || 'index.html';
    const file = resolve(root, relative);
    if (!file.startsWith(root + '/')) throw new Error('Invalid path');
    response.setHeader('Content-Type', types[extname(file)] ?? 'application/octet-stream');
    response.end(await readFile(file));
  } catch { response.writeHead(404); response.end('Not found'); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
await mkdir(output, { recursive: true });
let browser;
try {
  browser = await chromium.launch();
  for (const [label, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.goto(`${origin}/Docker2U/`, { waitUntil: 'networkidle' });
    for (const language of ['ko', 'en']) {
      if (language === 'en') await page.locator('[data-language="en"]').click();
      await page.waitForFunction(lang => document.documentElement.lang === lang, language);
      assert.equal(await page.locator(`[data-language="${language}"]`).getAttribute('aria-current'), 'true');
      assert.ok((await page.locator('#hero-title').innerText()).trim());
      assert.match(await page.locator('#preview-caption').innerText(), language === 'ko' ? /예시/ : /illustrat|example/i);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, `${label}/${language} horizontal overflow`);
      const download = page.locator('a[href$="Docker2U_0.1.0-alpha.2_aarch64.dmg"]').first();
      assert.ok(await download.isVisible());
      await page.screenshot({ path: `${output}/${label}-${language}.png` });
      for (const section of ['features', 'start']) {
        await page.locator(`#${section}`).scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${output}/${label}-${language}-${section}.png` });
      }
      const summary = page.locator('summary').first();
      await summary.click();
      assert.ok(await summary.evaluate(element => element.parentElement.open));
      await page.locator('.download-section').scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${output}/${label}-${language}-footer.png` });
      await page.evaluate(() => scrollTo(0, 0));
    }
    assert.deepEqual(errors, [], `${label} browser errors`);
    await page.close();
  }
  console.log('Site checks passed: Korean/English, desktop/mobile, project base path, download links, FAQ, overflow and browser errors.');
} finally {
  await browser?.close();
  await new Promise(done => server.close(done));
}
