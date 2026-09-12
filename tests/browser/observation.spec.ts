import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// Only count rows that intersect both the log scrollport and the visible detail pane.
// Virtualized DOM rows can exist thousands of pixels below a broken parent layout.
async function visibleRows(page: Page) {
  return page.locator('.project-log-viewport').evaluate(viewport => {
    let top = 0, bottom = innerHeight, left = 0, right = innerWidth;
    for (let node: Element | null = viewport; node; node = node.parentElement) {
      const bounds = node.getBoundingClientRect(), style = getComputedStyle(node);
      if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) { top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom); }
      if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) { left = Math.max(left, bounds.left); right = Math.min(right, bounds.right); }
    }
    return [...viewport.querySelectorAll<HTMLElement>('.project-log-row')].filter(row => {
      const bounds = row.getBoundingClientRect();
      return bounds.bottom > top && bounds.top < bottom && bounds.right > left && bounds.left < right;
    }).map(row => row.textContent);
  });
}
async function expectVisibleLogs(page: Page) {
  await expect.poll(async () => (await visibleRows(page)).length).toBeGreaterThan(0);
  await expect(page.locator('.project-log-viewport')).toBeInViewport();
  expect(await page.locator('.project-log-viewport').evaluate(node => node.clientHeight)).toBeGreaterThanOrEqual(80);
}

test.beforeEach(async ({ page }, info) => {
  await page.route('**/*', async route => { if (new URL(route.request().url()).origin !== 'http://127.0.0.1:1422') throw new Error('Observation fixture must remain local.'); if (process.env.DOCKER2U_BROWSER_FIXTURE_DIR) { const pathname = new URL(route.request().url()).pathname; const contentType = ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' } as Record<string, string>)[extname(pathname)] ?? 'application/octet-stream'; await route.fulfill({ body: await readFile(join(process.env.DOCKER2U_BROWSER_FIXTURE_DIR, pathname)), contentType }); } else await route.continue(); });
  await page.addInitScript(preferences => localStorage.setItem('docker2u.preferences.v1', JSON.stringify(preferences)), { theme: info.project.metadata.theme, language: info.project.metadata.language });
  await page.goto('/src/test/visual.html?toolbar=hidden&scenario=observation');
  await expect(page.locator('.container-row')).toHaveCount(4);
  await page.getByRole('treeitem', { name: info.project.metadata.language === 'en' ? 'orders project' : 'orders 프로젝트', exact: true }).locator('.project-tree-name').click();
  await expect.poll(() => page.locator('.project-log-row').count()).toBeGreaterThan(0);
});

test('combined log controls fit, filter literal text, and preserve a frozen view while collection continues', async ({ page }, info) => {
  const en = info.project.metadata.language === 'en';
  await expectVisibleLogs(page);
  expect(await page.locator('.project-log-spacer').evaluate(node => node.getBoundingClientRect().height / 26)).toBeGreaterThanOrEqual(3000);
  const bottomGap = () => page.locator('.project-log-viewport').evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight);
  await expect.poll(bottomGap).toBeLessThanOrEqual(1);
  await page.getByRole('button', { name: en ? 'Expand logs' : '로그 확대', exact: true }).click();
  await expectVisibleLogs(page);
  await expect.poll(bottomGap).toBeLessThanOrEqual(1);
  await page.keyboard.press('Escape');
  await expectVisibleLogs(page);
  await expect.poll(bottomGap).toBeLessThanOrEqual(1);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await page.locator('.project-service-filter summary').click();
  await page.getByRole('checkbox', { name: 'redis', exact: true }).uncheck();
  await page.locator('.project-service-filter summary').click();
  await page.getByRole('searchbox').fill('error[db]');
  await expect(page.locator('.project-log-row').first()).toContainText('ERROR[DB]');
  await expect(page.locator('.project-log-row').last()).toContainText('ERROR[DB]');
  await expect.poll(async () => [...new Set(await page.locator('.project-log-row > span:nth-child(2)').allTextContents())]).toEqual(['api']);
  await expectVisibleLogs(page);
  await page.getByRole('button', { name: en ? 'Pause view' : '화면 일시정지', exact: true }).click();
  // Pausing adds a status hint and can trim an offscreen overscan row.
  const frozen = await visibleRows(page);
  const frozenHeight = await page.locator('.project-log-spacer').evaluate(node => node.getBoundingClientRect().height);
  await page.waitForTimeout(1200);
  expect(await visibleRows(page)).toEqual(frozen);
  await page.getByRole('button', { name: en ? 'Expand logs' : '로그 확대', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expectVisibleLogs(page);
  await expect(page.getByRole('searchbox')).toHaveValue('error[db]');
  await expect(page.getByRole('button', { name: en ? 'Resume view' : '화면 재개', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.locator('.project-log-spacer').evaluate(node => node.getBoundingClientRect().height)).toBe(frozenHeight);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: en ? 'Expand logs' : '로그 확대', exact: true })).toBeFocused();
  await page.getByRole('button', { name: en ? 'Settings' : '설정', exact: true }).click();
  const nextLanguage = en ? 'ko' : 'en', nextTheme = info.project.metadata.theme === 'light' ? 'dark' : 'light';
  await page.locator(`input[name="theme-preference"][value="${nextTheme}"]`).check();
  await page.locator('#language-preference').selectOption(nextLanguage);
  await page.keyboard.press('Escape');
  await expect(page.locator('html')).toHaveAttribute('lang', nextLanguage);
  await expect(page.locator('html')).toHaveAttribute('data-theme', nextTheme);
  await expect(page.getByRole('searchbox')).toHaveValue('error[db]');
  await expect(page.getByRole('button', { name: en ? '화면 재개' : 'Resume view', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => [...new Set(await page.locator('.project-log-row > span:nth-child(2)').allTextContents())]).toEqual(['api']);
  await expect.poll(() => page.locator('.project-log-spacer').evaluate(node => node.getBoundingClientRect().height)).toBe(frozenHeight);
  await expectVisibleLogs(page);
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

test('history accordion places visible charts directly below the selected service and supports keyboard disclosure', async ({ page }, info) => {
  const en = info.project.metadata.language === 'en';
  await page.getByRole('tab', { name: en ? 'History' : '이력', exact: true }).click();
  const items = page.locator('.history-service-item'), first = items.nth(0), second = items.nth(1);
  await expect(items).toHaveCount(2);
  const firstButton = first.locator('.history-service'), secondButton = second.locator('.history-service');
  await firstButton.focus(); await firstButton.press('Enter');
  await expect(firstButton).toHaveAttribute('aria-expanded', 'true');
  const panel = first.getByRole('region');
  await expect(panel).toHaveAttribute('id', (await firstButton.getAttribute('aria-controls'))!);
  await expect(panel).toHaveAttribute('aria-labelledby', (await firstButton.getAttribute('id'))!);
  await expect(panel.locator('.resource-chart')).toHaveCount(2);
  expect(await firstButton.evaluate(button => button.nextElementSibling?.getAttribute('role'))).toBe('region');
  await panel.scrollIntoViewIfNeeded();
  const layout = await first.evaluate(item => {
    const row = item.querySelector('.history-service')!.getBoundingClientRect();
    const region = item.querySelector('[role="region"]')!.getBoundingClientRect();
    const next = item.nextElementSibling!.getBoundingClientRect();
    return { rowBottom: row.bottom, panelTop: region.top, panelBottom: region.bottom, nextTop: next.top, widthOverflow: item.scrollWidth - item.clientWidth };
  });
  expect(layout.panelTop).toBeGreaterThanOrEqual(layout.rowBottom);
  expect(layout.panelBottom).toBeLessThanOrEqual(layout.nextTop);
  expect(layout.widthOverflow).toBeLessThanOrEqual(1);
  for (const chart of await panel.locator('.resource-chart svg').all()) await expect(chart).toBeInViewport({ ratio: 1 });
  await firstButton.press('Space');
  await expect(firstButton).toHaveAttribute('aria-expanded', 'false');
  await expect(first.getByRole('region')).toHaveCount(0);
  await firstButton.press('Enter');
  await secondButton.focus(); await secondButton.press('Enter');
  await expect(firstButton).toHaveAttribute('aria-expanded', 'false');
  await expect(secondButton).toHaveAttribute('aria-expanded', 'true');
  await expect(first.getByRole('region')).toHaveCount(0);
  await expect(second.getByRole('region')).toBeVisible();
  await expect(page.locator('.history-service[aria-expanded="true"]')).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  await page.locator('.container-row').first().click();
  await page.getByRole('tab', { name: en ? 'History' : '이력', exact: true }).click();
  await expect(page.locator('.history-services')).toHaveCount(0);
  await expect(page.locator('.resource-chart')).toHaveCount(2);
  await expect(page.locator('.resource-chart').first()).toContainText('145%');
});

test('container logs reuse the active project subscription and expose only that source', async ({ page }, info) => {
  const en = info.project.metadata.language === 'en';
  const before = await page.evaluate(() => (window as unknown as { __docker2uObservationCalls: Record<string, number> }).__docker2uObservationCalls.configureLogs);
  await page.locator('.container-row').first().click();
  await expect.poll(() => page.locator('.project-log-row').count()).toBeGreaterThan(0);
  await expect.poll(async () => [...new Set(await page.locator('.project-log-row > span:nth-child(2)').allTextContents())]).toEqual(['api']);
  await expectVisibleLogs(page);
  expect(await page.evaluate(() => (window as unknown as { __docker2uObservationCalls: Record<string, number> }).__docker2uObservationCalls.configureLogs)).toBe(before);
  await page.getByRole('treeitem', { name: en ? 'orders project' : 'orders 프로젝트', exact: true }).locator('.project-tree-name').click();
  await expect(page.locator('.project-tabs')).toBeVisible();
  await expectVisibleLogs(page);
});

test('project and container logs retain console typography and shared copy feedback in the real viewport', async ({ page }, info) => {
  const en = info.project.metadata.language === 'en';
  const copied = en ? 'Displayed logs copied' : '표시된 로그 복사됨';
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { (window as unknown as { copiedConsole: string }).copiedConsole = text; } } }));
  expect(await page.locator('.project-log-spacer').evaluate(node => node.getBoundingClientRect().height / 26)).toBeGreaterThanOrEqual(3_000);
  for (const scope of ['project', 'container']) {
    if (scope === 'container') await page.locator('.container-row').first().click();
    await expectVisibleLogs(page);
    const viewport = page.locator('.project-log-viewport');
    await expect(viewport).toHaveCSS('font-size', '12px');
    await expect(viewport).toHaveCSS('font-family', /monospace/);
    const colors = await viewport.evaluate(node => ({ body: getComputedStyle(node).backgroundColor, inset: getComputedStyle(document.querySelector('.app-footer')!).backgroundColor }));
    expect(colors.body).toBe(colors.inset);
    expect(colors.body).not.toBe('rgba(0, 0, 0, 0)');
    expect(await page.locator('.project-log-row').first().evaluate(node => node.getBoundingClientRect().height)).toBe(26);
    const source = page.locator('.project-log-row > span:nth-child(2)').last();
    if (scope === 'container') await expect(source).toBeHidden();
    else await expect(source).toBeVisible();
    await page.getByRole('button', { name: en ? 'Copy displayed range' : '현재 표시 구간 복사', exact: true }).click();
    await expect(page.locator('.app-footer .clipboard-feedback')).toHaveText(copied);
    await expect(page.locator('.app-footer .copy-feedback-glow')).toHaveCSS('animation-duration', '2s');
    expect(await page.evaluate(() => (window as unknown as { copiedConsole: string }).copiedConsole)).toContain('\tapi\t');
    await page.getByRole('button', { name: en ? 'Expand logs' : '로그 확대', exact: true }).click();
    await expectVisibleLogs(page);
    await expect(page.locator('.project-log-copy-feedback')).toHaveText(copied);
    await expect(page.locator('.project-log-copy-feedback')).toBeInViewport();
    await expect(page.locator('.project-log-copy-feedback .copy-feedback-glow')).toHaveCount(1);
    await expect(page.locator('.project-log-copy-feedback .copy-feedback-glow')).toHaveCount(0, { timeout: 3_000 });
    await expect(page.locator('.project-log-copy-feedback')).toHaveText(copied);
    await page.keyboard.press('Escape');
  }
});


test('historical log row and fractional scroll survive pause, expansion, window and split resizing', async ({ page }, info) => {
  const en = info.project.metadata.language === 'en';
  const viewport = page.locator('.project-log-viewport');
  await expectVisibleLogs(page);
  await viewport.evaluate(node => { node.scrollTop = 1000 * 26 + 7; });
  await expect.poll(async () => (await visibleRows(page))[0]).toContain('request=1000');
  // Move inside the loaded historical window so the immutable row ID is anchored.
  await viewport.evaluate(node => { node.scrollTop += 52; });
  await expect.poll(async () => (await visibleRows(page))[0]).toContain('request=1002');
  const topRow = (await visibleRows(page))[0];
  await page.getByRole('button', { name: en ? 'Pause view' : '화면 일시정지', exact: true }).click();
  await expect.poll(async () => (await visibleRows(page))[0]).toBe(topRow);
  await page.getByRole('button', { name: en ? 'Expand logs' : '로그 확대', exact: true }).click();
  await expectVisibleLogs(page);
  await expect.poll(async () => (await visibleRows(page))[0]).toBe(topRow);
  const size = page.viewportSize()!;
  await page.setViewportSize({ ...size, height: size.height - 40 });
  await expect.poll(async () => (await visibleRows(page))[0]).toBe(topRow);
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await visibleRows(page))[0]).toBe(topRow);
  const separator = page.getByRole('separator');
  await separator.focus();
  await page.keyboard.press('End');
  await expect.poll(async () => (await visibleRows(page))[0]).toBe(topRow);
  await expect.poll(() => viewport.evaluate(node => node.scrollTop)).toBe(1002 * 26 + 7);
  await page.getByRole('button', { name: en ? 'Latest' : '최신 위치', exact: true }).click();
  await expect.poll(() => viewport.evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThanOrEqual(1);
  await expect(page.getByRole('button', { name: en ? 'Pause view' : '화면 일시정지', exact: true })).toHaveAttribute('aria-pressed', 'false');
});

test('minimum navigation width keeps toolbar and log rows reachable without growing to the virtual buffer height', async ({ page }, info) => {
  const en = info.project.metadata.language === 'en';
  const separator = page.getByRole('separator');
  await separator.focus();
  await page.keyboard.press('Home');
  await page.getByRole('button', { name: en ? 'Pause view' : '화면 일시정지', exact: true }).click();
  await page.locator('.project-log-viewport').scrollIntoViewIfNeeded();
  await expectVisibleLogs(page);
  expect(await page.locator('#detail-pane').evaluate(node => node.scrollHeight)).toBeLessThan(1000);
  await page.getByRole('button', { name: en ? 'Expand logs' : '로그 확대', exact: true }).click();
  await expectVisibleLogs(page);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: en ? 'Resume view' : '화면 재개', exact: true }).click();
  await page.getByRole('tab', { name: en ? 'History' : '이력', exact: true }).click();
  await page.locator('.history-service').first().click();
  await expect(page.locator('.resource-chart')).toHaveCount(2);
});


test('paused tail restores its logical position after an expanded viewport clamps the scroll offset', async ({ page }, info) => {
  const en = info.project.metadata.language === 'en';
  const viewport = page.locator('.project-log-viewport');
  await expectVisibleLogs(page);
  await page.getByRole('button', { name: en ? 'Pause view' : '화면 일시정지', exact: true }).click();
  const before = await viewport.evaluate(node => ({ top: node.scrollTop, height: node.clientHeight, total: node.scrollHeight }));
  await page.getByRole('button', { name: en ? 'Expand logs' : '로그 확대', exact: true }).click();
  await expectVisibleLogs(page);
  await expect.poll(() => viewport.evaluate(node => node.clientHeight)).toBeGreaterThan(before.height);
  await expect.poll(() => viewport.evaluate(node => node.scrollTop)).toBeLessThan(before.top);
  await page.keyboard.press('Escape');
  await expectVisibleLogs(page);
  await expect.poll(() => viewport.evaluate(node => node.scrollTop)).toBe(before.top);
  expect(await viewport.evaluate(node => node.scrollHeight)).toBe(before.total);
  await expect(page.getByRole('button', { name: en ? 'Resume view' : '화면 재개', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: en ? 'Expand logs' : '로그 확대', exact: true }).click();
  await expectVisibleLogs(page);
  // A real user scroll near the tail supersedes the saved logical position.
  const userTop = await viewport.evaluate(node => new Promise<number>(resolve => {
    node.addEventListener('scroll', () => requestAnimationFrame(() => resolve(node.scrollTop)), { once: true });
    node.scrollTop -= 26;
  }));
  await expect.poll(() => viewport.evaluate(node => node.scrollTop)).toBe(userTop);
  await page.keyboard.press('Escape');
  await expect.poll(() => viewport.evaluate(node => node.scrollTop)).toBe(userTop);
});


test('tree navigation restores target filters, pause and historical anchors without restarting collection', async ({ page }, info) => {
  const en = info.project.metadata.language === 'en';
  const project = page.getByRole('treeitem', { name: en ? 'orders project' : 'orders 프로젝트', exact: true });
  await page.getByRole('searchbox').fill('request=');
  const viewport = page.locator('.project-log-viewport');
  await expect.poll(async () => (await visibleRows(page)).every(row => row?.includes('request='))).toBe(true);
  await viewport.evaluate(node => { node.scrollTop = 1000 * 26 + 7; });
  // The keyword excludes ERROR rows, so capture the actual filtered anchor.
  await expect.poll(() => viewport.evaluate(node => node.scrollTop)).toBe(1000 * 26 + 7);
  await expect.poll(async () => (await visibleRows(page))[0]).toContain('request=1084');
  await page.getByRole('button', { name: en ? 'Pause view' : '화면 일시정지', exact: true }).click();
  const before = (await visibleRows(page))[0];
  const subscriptions = await page.evaluate(() => (window as unknown as { __docker2uObservationCalls: Record<string, number> }).__docker2uObservationCalls.configureLogs);
  const first = page.locator('.container-row').first();
  await first.click();
  await expect(project).toHaveAttribute('aria-selected', 'false');
  await expect(first).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('searchbox')).toHaveValue('');
  await expectVisibleLogs(page);
  await project.locator('.project-tree-name').click();
  await expect(first).toHaveAttribute('aria-selected', 'false');
  await expect(project).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('searchbox')).toHaveValue('request=');
  await expect(page.getByRole('button', { name: en ? 'Resume view' : '화면 재개', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await visibleRows(page))[0]).toBe(before);
  expect(await page.evaluate(() => (window as unknown as { __docker2uObservationCalls: Record<string, number> }).__docker2uObservationCalls.configureLogs)).toBe(subscriptions);
});
