import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }, info) => {
  await page.route('**/*', async route => { if (new URL(route.request().url()).origin !== 'http://127.0.0.1:1422') throw new Error('Observation fixture must remain local.'); if (process.env.DOCKER2U_BROWSER_FIXTURE_DIR) { const pathname = new URL(route.request().url()).pathname; const contentType = ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' } as Record<string, string>)[extname(pathname)] ?? 'application/octet-stream'; await route.fulfill({ body: await readFile(join(process.env.DOCKER2U_BROWSER_FIXTURE_DIR, pathname)), contentType }); } else await route.continue(); });
  await page.addInitScript(preferences => localStorage.setItem('docker2u.preferences.v1', JSON.stringify(preferences)), { theme: info.project.metadata.theme, language: info.project.metadata.language });
  await page.goto('/src/test/visual.html?toolbar=hidden&scenario=observation');
  await expect(page.locator('.container-row')).toHaveCount(4);
  await page.locator('select[aria-label]').first().selectOption({ label: 'orders' });
  await expect.poll(() => page.locator('.project-log-row').count()).toBeGreaterThan(0);
});

test('combined log controls fit, filter literal text, and preserve a frozen view while collection continues', async ({ page }, info) => {
  const en = info.project.metadata.language === 'en';
  await expect(page.locator('.project-log-viewport')).toBeInViewport();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await page.getByRole('searchbox').fill('error[db]');
  await expect(page.locator('.project-log-row').first()).toContainText('ERROR[DB]');
  await expect(page.locator('.project-log-row').last()).toContainText('ERROR[DB]');
  await page.getByRole('button', { name: en ? 'Pause view' : '화면 일시정지', exact: true }).click();
  const frozen = await page.locator('.project-log-row').allTextContents();
  await page.waitForTimeout(1200);
  expect(await page.locator('.project-log-row').allTextContents()).toEqual(frozen);
  await page.getByRole('button', { name: en ? 'Expand logs' : '로그 확대', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: en ? 'Expand logs' : '로그 확대', exact: true })).toBeFocused();
  if (process.env.DOCKER2U_BROWSER_FIXTURE_DIR) await page.screenshot({ path: info.outputPath('project-logs.png') });
});

test('Core refresh preserves checked identities and project history shows CPU above 100 with gaps', async ({ page }, info) => {
  const en = info.project.metadata.language === 'en';
  const checkbox = page.locator('.container-checkbox').first();
  await checkbox.check();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __docker2uObservationCalls: Record<string, number> }).__docker2uObservationCalls.read ?? 0)).toBeGreaterThan(3);
  await expect(checkbox).toBeChecked();
  const subscriptions = await page.evaluate(() => (window as unknown as { __docker2uObservationCalls: Record<string, number> }).__docker2uObservationCalls.configureLogs);
  await page.getByRole('tab', { name: en ? 'History' : '이력', exact: true }).click();
  await page.locator('.history-service').first().click();
  await expect(page.locator('.resource-chart')).toHaveCount(2);
  await expect(page.locator('.resource-chart').first()).toContainText('145%');
  await expect(page.locator('.resource-chart').first().locator('polyline')).not.toHaveCount(1);
  await expect(page.locator('.history-events')).toContainText(en ? 'Started' : '시작');
  expect(await page.evaluate(() => (window as unknown as { __docker2uObservationCalls: Record<string, number> }).__docker2uObservationCalls.configureLogs)).toBe(subscriptions);
});

test('container logs reuse the active project subscription and expose only that source', async ({ page }, info) => {
  const en = info.project.metadata.language === 'en';
  const before = await page.evaluate(() => (window as unknown as { __docker2uObservationCalls: Record<string, number> }).__docker2uObservationCalls.configureLogs);
  await page.locator('.container-row').first().click();
  await expect.poll(() => page.locator('.project-log-row').count()).toBeGreaterThan(0);
  await expect.poll(async () => [...new Set(await page.locator('.project-log-row > span:nth-child(2)').allTextContents())]).toEqual(['api']);
  expect(await page.evaluate(() => (window as unknown as { __docker2uObservationCalls: Record<string, number> }).__docker2uObservationCalls.configureLogs)).toBe(before);
  await page.getByRole('button', { name: en ? 'Back to project' : '프로젝트로 돌아가기', exact: true }).click();
  await expect(page.locator('.project-tabs')).toBeVisible();
});
