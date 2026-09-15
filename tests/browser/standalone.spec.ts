import { expect, test, type Page, type TestInfo } from '@playwright/test';

const ids = { api: '3'.repeat(64), worker: '4'.repeat(64), replacement: '5'.repeat(64) };
function words(info: TestInfo) {
  return info.project.metadata.language === 'en' ? {
    group: 'Standalone containers', logs: 'Combined logs', childLogs: 'Logs', history: 'History', search: 'Search log text',
    pause: 'Pause view', resume: 'Resume view', clear: 'Clear displayed logs',
    diagnostics: 'Current diagnostics', terminal: 'Current terminal', diagnosticsTab: 'Diagnostics', terminalTab: 'Terminal',
    back: 'Back to incident', window: 'Incident time window', refresh: 'Refresh incident records', close: 'Close incident details',
    reconnect: 'Reconnect', project: 'orders project', minutes: (value: number) => `±${value} min`,
  } : {
    group: '독립 컨테이너', logs: '통합 로그', childLogs: '로그', history: '이력', search: '로그 키워드 검색',
    pause: '화면 일시정지', resume: '화면 재개', clear: '현재 로그 비우기',
    diagnostics: '현재 진단', terminal: '현재 터미널', diagnosticsTab: '상태 진단', terminalTab: '터미널',
    back: '사건으로 돌아가기', window: '사건 조회 구간', refresh: '사건 기록 새로고침', close: '사건 상세 닫기',
    reconnect: '다시 연결', project: 'orders 프로젝트', minutes: (value: number) => `전후 ${value}분`,
  };
}
const calls = (page: Page) => page.evaluate(() => ({ ...(window as unknown as { __docker2uObservationCalls: Record<string, number> }).__docker2uObservationCalls }));
const terminalStarts = (page: Page) => page.evaluate(() => (window as unknown as { __docker2uTerminalCalls: Record<string, number> }).__docker2uTerminalCalls.start ?? 0);
const rows = (page: Page) => page.locator('.project-log-row');
const group = (page: Page, info: TestInfo) => page.getByRole('treeitem', { name: words(info).group, exact: true });
async function selectGroup(page: Page, info: TestInfo) {
  await group(page, info).locator('.project-tree-name').click();
  await expect(group(page, info)).toHaveAttribute('aria-selected', 'true');
}
async function selectContainer(page: Page, name: string) {
  await page.locator(`.container-row[title="${name}"]`).click();
}
async function incident(page: Page, info: TestInfo) {
  await page.getByRole('tab', { name: words(info).history, exact: true }).click();
  const trigger = page.locator('.history-event-trigger').first();
  await trigger.focus(); await trigger.press('Enter');
  const detail = page.locator('.incident-detail');
  await expect(detail).toBeVisible();
  await expect(detail.locator('.incident-log-row').first()).toBeAttached();
  return detail;
}
async function mutateFixture(page: Page, action: 'removeApi' | 'recreateApi' | 'removeAllStandalone' | 'emptyInventory') {
  await page.evaluate(key => (window as unknown as { __docker2uStandaloneFixture: Record<string, () => void> }).__docker2uStandaloneFixture[key]!(), action);
}

test.beforeEach(async ({ page }, info) => {
  await page.route('**/*', async route => {
    if (new URL(route.request().url()).origin !== 'http://127.0.0.1:1422') throw new Error('Standalone fixture must remain local.');
    await route.continue();
  });
  await page.addInitScript(preferences => localStorage.setItem('docker2u.preferences.v1', JSON.stringify(preferences)), {
    theme: info.project.metadata.theme, language: info.project.metadata.language,
  });
  await page.goto('/src/test/visual.html?toolbar=hidden&scenario=standalone');
  await expect(page.locator('.container-row')).toHaveCount(3);
  await selectGroup(page, info);
  await expect(rows(page).first()).toBeAttached();
});

test('selects the standalone group independently of disclosure and keeps collection through child navigation', async ({ page }, info) => {
  const w = words(info), before = await calls(page);
  await expect(rows(page).filter({ hasText: 'standalone-api' }).first()).toBeAttached();
  await expect(rows(page).filter({ hasText: 'standalone-worker' }).first()).toBeAttached();
  await expect(rows(page).filter({ hasText: 'compose-web' })).toHaveCount(0);
  await group(page, info).locator('.project-disclosure').click();
  await expect(group(page, info)).toHaveAttribute('aria-selected', 'true');
  await expect(group(page, info)).toHaveAttribute('aria-expanded', 'false');
  await group(page, info).focus(); await group(page, info).press('ArrowRight');
  await expect(group(page, info)).toHaveAttribute('aria-expanded', 'true');
  for (const name of ['standalone-api', 'standalone-worker']) {
    await selectContainer(page, name);
    await expect(rows(page).first()).toContainText(name);
    await expect.poll(async () => (await rows(page).allTextContents()).every(text => text.includes(name))).toBe(true);
    await page.getByRole('tab', { name: w.diagnosticsTab, exact: true }).click();
    await page.getByRole('tab', { name: w.childLogs, exact: true }).click();
  }
  await selectGroup(page, info);
  expect((await calls(page)).configureStandaloneLogs).toBe(before.configureStandaloneLogs);
  expect((await calls(page)).stopLogs ?? 0).toBe(before.stopLogs ?? 0);
  await page.getByRole('treeitem', { name: w.project, exact: true }).locator('.project-tree-name').click();
  await expect(rows(page).first()).toContainText('compose-web');
  await expect(rows(page).filter({ hasText: 'standalone-' })).toHaveCount(0);
  expect((await calls(page)).configureLogs).toBeGreaterThan(before.configureLogs ?? 0);
});

test('restores separate group and child search and pause state without replacing the collector', async ({ page }, info) => {
  const w = words(info), before = await calls(page);
  const search = page.getByRole('searchbox', { name: w.search, exact: true });
  await search.fill('group-reading-anchor');
  await page.getByRole('button', { name: w.pause, exact: true }).click();
  await selectContainer(page, 'standalone-api');
  await expect(search).toHaveValue('');
  await search.fill('api-reading-anchor');
  await page.getByRole('button', { name: w.pause, exact: true }).click();
  await selectContainer(page, 'standalone-worker');
  await expect(search).toHaveValue('');
  await expect(page.getByRole('button', { name: w.pause, exact: true })).toHaveAttribute('aria-pressed', 'false');
  await selectGroup(page, info);
  await expect(search).toHaveValue('group-reading-anchor');
  await expect(page.getByRole('button', { name: w.resume, exact: true })).toHaveAttribute('aria-pressed', 'true');
  await selectContainer(page, 'standalone-api');
  await expect(search).toHaveValue('api-reading-anchor');
  await expect(page.getByRole('button', { name: w.resume, exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect((await calls(page)).configureStandaloneLogs).toBe(before.configureStandaloneLogs);
});

test('reviews frozen standalone incident logs and resources then returns from diagnostics and terminal', async ({ page }, info) => {
  const w = words(info), detail = await incident(page, info);
  const sequence = await detail.getAttribute('data-incident-sequence');
  await expect(detail.locator('.incident-header code')).toHaveAttribute('title', ids.api);
  await expect(detail.locator('.incident-time-marker')).toHaveCount(2);
  await expect(detail.getByRole('button', { name: w.minutes(2), exact: true })).toHaveAttribute('aria-pressed', 'true');
  const before = await calls(page), oldRows = await detail.locator('.incident-log-row').allTextContents();
  await expect.poll(async () => (await calls(page)).read ?? 0).toBeGreaterThan(before.read ?? 0);
  expect(await detail.locator('.incident-log-row').allTextContents()).toEqual(oldRows);
  expect((await calls(page)).queryStandaloneLogs).toBe(before.queryStandaloneLogs);
  for (const value of [1, 5]) {
    await detail.getByRole('button', { name: w.minutes(value), exact: true }).click();
    await expect(detail.getByRole('button', { name: w.refresh, exact: true })).toBeEnabled();
  }
  const previousQuery = (await calls(page)).queryStandaloneLogs ?? 0;
  await detail.getByRole('button', { name: w.refresh, exact: true }).click();
  await expect.poll(async () => (await calls(page)).queryStandaloneLogs).toBe(previousQuery + 1);
  const starts = await terminalStarts(page);
  for (const [button, tab] of [[w.diagnostics, w.diagnosticsTab], [w.terminal, w.terminalTab]]) {
    await detail.getByRole('button', { name: button, exact: true }).click();
    await expect(page.getByRole('tab', { name: tab, exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.container-row[aria-selected="true"]')).toHaveAttribute('title', 'standalone-api');
    if (tab === w.terminalTab) { await expect(page.locator('.terminal-connect')).toBeEnabled(); expect(await terminalStarts(page)).toBe(starts); }
    await page.getByRole('button', { name: w.back, exact: true }).click();
    await expect(detail).toHaveAttribute('data-incident-sequence', sequence!);
    await expect(detail.getByRole('button', { name: w.minutes(5), exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator(`.history-event-trigger[data-event-sequence="${sequence}"]`)).toBeFocused();
  }
  expect((await calls(page)).configureStandaloneLogs).toBe(before.configureStandaloneLogs);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  await detail.getByRole('button', { name: w.close, exact: true }).click();
  await expect(detail).toHaveCount(0);
  await expect(page.locator(`.history-event-trigger[data-event-sequence="${sequence}"]`)).toBeFocused();
});

test('retains deleted incident identity through same-name recreation and a completely empty inventory', async ({ page }, info) => {
  const w = words(info), detail = await incident(page, info);
  const originalRows = await detail.locator('.incident-log-row').allTextContents();
  const sequence = await detail.getAttribute('data-incident-sequence');
  await mutateFixture(page, 'removeApi');
  await expect(page.locator('.container-row[title="standalone-api"]')).toHaveCount(0);
  await mutateFixture(page, 'recreateApi');
  await expect(page.locator('.container-row[title="standalone-api"]')).toBeVisible();
  await expect(detail.locator('.incident-header code')).toHaveAttribute('title', ids.api);
  for (const button of [w.diagnostics, w.terminal]) await expect(detail.getByRole('button', { name: button, exact: true })).toBeDisabled();
  expect(await detail.locator('.incident-log-row').allTextContents()).toEqual(originalRows);
  await mutateFixture(page, 'emptyInventory');
  await expect(page.locator('.container-row')).toHaveCount(0);
  await expect(group(page, info)).toBeVisible();
  await expect(detail).toHaveAttribute('data-incident-sequence', sequence!);
  await detail.getByRole('button', { name: w.refresh, exact: true }).click();
  await expect(detail.getByRole('button', { name: w.refresh, exact: true })).toBeEnabled();
  await expect(detail.locator('.incident-log-row').first()).toBeAttached();
  await expect(detail.locator('.incident-header code')).toHaveAttribute('title', ids.api);
  await expect(detail).not.toContainText(ids.replacement);
});

test('drops incident return state on reconnect and leaves retained reads out of collector configuration', async ({ page }, info) => {
  const w = words(info), detail = await incident(page, info), before = await calls(page);
  await detail.getByRole('button', { name: w.minutes(5), exact: true }).click();
  await detail.getByRole('button', { name: w.terminal, exact: true }).click();
  await expect(page.getByRole('button', { name: w.back, exact: true })).toBeVisible();
  expect((await calls(page)).configureStandaloneLogs).toBe(before.configureStandaloneLogs);
  await page.getByRole('button', { name: w.reconnect, exact: true }).click();
  await expect(page.locator('.incident-detail')).toHaveCount(0);
  await expect(page.locator('.incident-return')).toHaveCount(0);
  await selectGroup(page, info);
  await page.getByRole('tab', { name: w.history, exact: true }).click();
  await expect(page.locator('.history-event-trigger[aria-expanded="true"]')).toHaveCount(0);
});

test('keeps archived and recreated names separate in the full-ID container filter', async ({ page }, info) => {
  const before = await calls(page);
  await mutateFixture(page, 'removeApi');
  await expect(page.locator('.container-row[title="standalone-api"]')).toHaveCount(0);
  await mutateFixture(page, 'recreateApi');
  await expect(page.locator('.container-row[title="standalone-api"]')).toBeVisible();
  const filters = page.locator('.project-service-filter');
  await filters.locator('summary').click();
  const original = filters.getByRole('checkbox', { name: /333333333333/ });
  const replacement = filters.getByRole('checkbox', { name: /555555555555/ });
  await expect(original).toBeVisible(); await expect(replacement).toBeVisible();
  const originalLabel = await original.locator('..').textContent();
  expect(originalLabel).toMatch(info.project.metadata.language === 'en' ? /removed/i : /삭제/);
  await filters.getByRole('checkbox', { name: /444444444444/ }).uncheck();
  await replacement.uncheck();
  await filters.locator('summary').click();
  await expect(rows(page).first()).toBeAttached();
  await expect.poll(() => rows(page).evaluateAll(nodes => nodes.every(node => node.querySelector('span[title]')?.getAttribute('title') === '3'.repeat(64)))).toBe(true);
  expect((await calls(page)).configureStandaloneLogs).toBe(before.configureStandaloneLogs);
});

test('keeps clear boundaries and copy feedback separate for group and each child', async ({ page }, info) => {
  const w = words(info), before = await calls(page);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  const feedback = page.locator('.app-footer .clipboard-feedback');
  const copy = info.project.metadata.language === 'en' ? 'Copy displayed range' : '현재 표시 구간 복사';
  await page.getByRole('button', { name: copy, exact: true }).click();
  await expect(feedback).toContainText(info.project.metadata.language === 'en' ? 'copied' : '복사됨');
  const groupFeedback = await feedback.textContent();
  await selectContainer(page, 'standalone-api');
  await expect(feedback).toBeEmpty();
  await expect(rows(page).first()).toBeAttached();
  await page.getByRole('button', { name: w.clear, exact: true }).click();
  await expect(feedback).toContainText(info.project.metadata.language === 'en' ? 'cleared' : '비웠습니다');
  const childFeedback = await feedback.textContent();
  await expect(rows(page)).toHaveCount(0);
  await selectContainer(page, 'standalone-worker');
  await expect(feedback).toBeEmpty();
  await expect(rows(page).first()).toContainText('standalone-worker');
  await selectGroup(page, info);
  await expect(feedback).toHaveText(groupFeedback!);
  await expect(rows(page).first()).toBeAttached();
  await selectContainer(page, 'standalone-api');
  await expect(feedback).toHaveText(childFeedback!);
  await expect(rows(page)).toHaveCount(0);
  expect((await calls(page)).configureStandaloneLogs).toBe(before.configureStandaloneLogs);
});
