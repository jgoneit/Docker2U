import { expect, test, type Page, type TestInfo } from '@playwright/test';

function words(info: TestInfo) {
  return info.project.metadata.language === 'en' ? {
    project: 'orders project', history: 'History', logs: 'Combined logs', window: 'Incident time window',
    refresh: 'Refresh incident records', close: 'Close incident details', back: 'Back to incident',
    frozen: 'These records stay fixed.', diagnostics: 'Current diagnostics', connectivity: 'Current connectivity', storage: 'Current storage',
    diagnosticsTab: 'Diagnostics', connectivityTab: 'Connections', storageTab: 'Storage',
    minutes: (count: number) => `±${count} min`,
    search: 'Search log text', pause: 'Pause view', resume: 'Resume view',
  } : {
    project: 'orders 프로젝트', history: '이력', logs: '통합 로그', window: '사건 조회 구간',
    refresh: '사건 기록 새로고침', close: '사건 상세 닫기', back: '사건으로 돌아가기',
    frozen: '조회한 기록을 유지합니다.', diagnostics: '현재 진단', connectivity: '현재 접속', storage: '현재 저장소',
    diagnosticsTab: '상태 진단', connectivityTab: '접속 정보', storageTab: '저장소',
    minutes: (count: number) => `전후 ${count}분`,
    search: '로그 키워드 검색', pause: '화면 일시정지', resume: '화면 재개',
  };
}
const calls = (page: Page) => page.evaluate(() => ({ ...(window as unknown as { __docker2uObservationCalls: Record<string, number> }).__docker2uObservationCalls }));
const visibleProjectLogs = (page: Page) => page.locator('.project-log-viewport').evaluate(viewport => {
  const bounds = viewport.getBoundingClientRect();
  return [...viewport.querySelectorAll('.project-log-row')].filter(row => {
    const rect = row.getBoundingClientRect();
    return rect.bottom > bounds.top && rect.top < bounds.bottom;
  }).map(row => row.textContent);
});
async function openIncident(page: Page, info: TestInfo) {
  await page.getByRole('tab', { name: words(info).history, exact: true }).click();
  const trigger = page.locator('.history-event-trigger').first();
  await trigger.focus(); await trigger.press('Enter');
  const detail = page.locator('.incident-detail');
  await expect(detail).toBeVisible();
  await expect(detail.locator('.incident-log-row').first()).toBeAttached();
  return detail;
}

test.beforeEach(async ({ page }, info) => {
  await page.route('**/*', async route => {
    if (new URL(route.request().url()).origin !== 'http://127.0.0.1:1422') throw new Error('Incident fixture must remain local.');
    await route.continue();
  });
  await page.addInitScript(preferences => localStorage.setItem('docker2u.preferences.v1', JSON.stringify(preferences)), {
    theme: info.project.metadata.theme, language: info.project.metadata.language,
  });
  await page.goto('/src/test/visual.html?toolbar=hidden&scenario=observation');
  await expect(page.locator('.container-row')).toHaveCount(4);
  await page.getByRole('treeitem', { name: words(info).project, exact: true }).locator('.project-tree-name').click();
  await expect(page.locator('.project-log-row').first()).toBeAttached();
});

test('opens incident records inline and changes the time window without switching log collection', async ({ page }, info) => {
  const w = words(info), before = await calls(page);
  const detail = await openIncident(page, info);
  const trigger = page.locator('.history-event-trigger[aria-expanded="true"]');
  await expect(trigger).toHaveCount(1);
  const region = page.locator('.history-event-detail');
  await expect(region).toHaveAttribute('aria-labelledby', (await trigger.getAttribute('id'))!);
  expect(await trigger.evaluate(node => node.nextElementSibling?.classList.contains('history-event-detail'))).toBe(true);
  await expect(detail.getByRole('group', { name: w.window }).getByRole('button', { name: w.minutes(2), exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(detail.locator('.resource-chart')).toHaveCount(2);
  await expect(detail.locator('.incident-time-marker')).toHaveCount(2);
  await expect(detail).toContainText(w.frozen);
  for (const value of [1, 5, 2]) {
    const button = detail.getByRole('group', { name: w.window }).getByRole('button', { name: w.minutes(value), exact: true });
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    await expect(detail.locator('.incident-log-row').first()).toBeAttached();
  }
  expect((await calls(page)).configureLogs).toBe(before.configureLogs);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  expect(await detail.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
  await detail.getByRole('button', { name: w.close, exact: true }).click();
  await expect(detail).toHaveCount(0);
  await expect(trigger).toHaveCount(0);
  await expect(page.locator('.history-event-trigger:focus')).toHaveCount(1);
});

test('keeps incident logs and resources frozen while observation continues and refreshes on demand', async ({ page }, info) => {
  const w = words(info), detail = await openIncident(page, info);
  await expect(detail.getByRole('button', { name: w.refresh, exact: true })).toBeEnabled();
  const before = await calls(page);
  const logRows = await detail.locator('.incident-log-row').allTextContents();
  const resourceLines = await detail.locator('.resource-chart svg').evaluateAll(nodes => nodes.map(node => node.innerHTML));
  const capturedAt = await detail.locator('.incident-hint > span time').getAttribute('datetime');
  await expect.poll(async () => (await calls(page)).read ?? 0).toBeGreaterThan(before.read ?? 0);
  expect(await detail.locator('.incident-log-row').allTextContents()).toEqual(logRows);
  expect(await detail.locator('.resource-chart svg').evaluateAll(nodes => nodes.map(node => node.innerHTML))).toEqual(resourceLines);
  await expect(detail.locator('.incident-hint > span time')).toHaveAttribute('datetime', capturedAt!);
  expect((await calls(page)).queryLogs).toBe(before.queryLogs);
  await detail.getByRole('button', { name: w.refresh, exact: true }).click();
  await expect.poll(async () => (await calls(page)).queryLogs).toBe((before.queryLogs ?? 0) + 1);
  await expect(detail.getByRole('button', { name: w.refresh, exact: true })).toBeEnabled();
  await expect(detail.locator('.incident-hint > span time')).not.toHaveAttribute('datetime', capturedAt!);
  expect((await calls(page)).configureLogs).toBe(before.configureLogs);
});

test('returns from exact-container current tabs to the same incident and preserves the project log view', async ({ page }, info) => {
  const w = words(info);
  const search = page.getByRole('searchbox', { name: w.search, exact: true });
  await search.fill('request=');
  await expect(page.locator('.project-log-row').first()).toContainText('request=');
  await page.getByRole('button', { name: w.pause, exact: true }).click();
  const originalRows = await visibleProjectLogs(page);
  const originalHeight = await page.locator('.project-log-spacer').evaluate(node => node.getBoundingClientRect().height);
  const detail = await openIncident(page, info);
  await detail.getByRole('group', { name: w.window }).getByRole('button', { name: w.minutes(5), exact: true }).click();
  const eventSequence = await page.locator('.history-event-trigger[aria-expanded="true"]').getAttribute('data-event-sequence');
  const before = await calls(page);
  for (const [action, tab] of [[w.diagnostics, w.diagnosticsTab], [w.connectivity, w.connectivityTab], [w.storage, w.storageTab]]) {
    await detail.getByRole('button', { name: action, exact: true }).click();
    await expect(page.getByRole('tab', { name: tab, exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.container-row[aria-selected="true"]')).toContainText('backend-주문처리-api-development');
    await page.getByRole('button', { name: w.back, exact: true }).click();
    await expect(detail).toBeVisible();
    await expect(detail.getByRole('group', { name: w.window }).getByRole('button', { name: w.minutes(5), exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.history-event-trigger[aria-expanded="true"]')).toHaveAttribute('data-event-sequence', eventSequence!);
  }
  expect((await calls(page)).configureLogs).toBe(before.configureLogs);
  await page.getByRole('tab', { name: w.logs, exact: true }).click();
  await expect(search).toHaveValue('request=');
  await expect(page.getByRole('button', { name: w.resume, exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.locator('.project-log-spacer').evaluate(node => node.getBoundingClientRect().height)).toBe(originalHeight);
  // The retained-incident return bar reduces the log viewport height. Preserve
  // the reading anchor and visible contents rather than the old visible count.
  await expect.poll(async () => (await visibleProjectLogs(page))[0]).toBe(originalRows[0]);
  const restoredRows = await visibleProjectLogs(page);
  expect(restoredRows).toEqual(originalRows.slice(0, restoredRows.length));
});
