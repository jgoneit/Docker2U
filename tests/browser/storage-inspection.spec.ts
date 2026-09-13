import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';

const backend = 'backend-주문처리-api-development';
const redis = 'redis-캐시-stopped';
const worker = 'worker-상태확인-required';
function words(info: TestInfo) {
  const en = info.project.metadata.language === 'en';
  return en ? {
    project: 'orders project', workerProject: 'workers project', storage: 'Storage', panel: 'Storage mounts', logs: 'Logs', projectLogs: 'Combined logs', history: 'History',
    reload: 'Refresh storage', search: 'Search log text', pause: 'Pause view', resume: 'Resume view',
    copied: 'Path copied', readOnly: 'Read only', readWrite: 'Read / write', localMemory: 'Container-local memory',
    partial: 'Some containers could not be inspected.', failed: 'Could not load storage mounts.', empty: 'Engine reported no mounts.',
    stale: 'Previous observations.', unavailable: `${worker}: mount information is unavailable.`,
    stop: 'Stop', confirmStop: 'Confirm Stop', openWorker: `Open storage for ${worker}`,
  } : {
    project: 'orders 프로젝트', workerProject: 'workers 프로젝트', storage: '저장소', panel: '저장소 연결', logs: '로그', projectLogs: '통합 로그', history: '이력',
    reload: '저장소 새로고침', search: '로그 키워드 검색', pause: '화면 일시정지', resume: '화면 재개',
    copied: '경로 복사됨', readOnly: '읽기 전용', readWrite: '읽기·쓰기', localMemory: '컨테이너 전용 메모리',
    partial: '일부 컨테이너를 조회하지 못했습니다.', failed: '저장소 연결을 조회하지 못했습니다.', empty: 'Engine에서 보고한 마운트가 없습니다.',
    stale: '이전 관측값입니다.', unavailable: `${worker}: 마운트 정보를 조회할 수 없습니다.`,
    stop: '중지', confirmStop: '중지 확인', openWorker: `${worker} 저장소로 이동`,
  };
}
type MountFixtureWindow = Window & { __docker2uMountFixture: { calls: number; setMode: (mode: string) => void; bindSource: string }; copiedStoragePath?: string };
const mountCalls = (page: Page) => page.evaluate(() => (window as MountFixtureWindow).__docker2uMountFixture.calls);
const bindSource = (page: Page) => page.evaluate(() => (window as MountFixtureWindow).__docker2uMountFixture.bindSource);
const setMode = (page: Page, mode: string) => page.evaluate(value => (window as MountFixtureWindow).__docker2uMountFixture.setMode(value), mode);
function mountOf(panel: Locator, type: string) { return panel.locator('.storage-mount').filter({ has: panel.page().getByText(type, { exact: true }) }); }
async function open(page: Page, info: TestInfo, mode = 'complete') {
  await page.goto(`/src/test/visual.html?toolbar=hidden&scenario=observation&mountMode=${mode}`);
  await expect(page.locator('.container-row')).toHaveCount(4);
  await page.getByRole('treeitem', { name: words(info).project, exact: true }).locator('.project-tree-name').click();
  await expect(page.locator('.project-log-row').first()).toBeVisible();
}
async function showStorage(page: Page, info: TestInfo) {
  await page.getByRole('tab', { name: words(info).storage, exact: true }).click();
  const panel = page.getByRole('region', { name: words(info).panel, exact: true });
  await expect(panel).toHaveAttribute('aria-busy', 'false');
  return panel;
}

test.beforeEach(async ({ page }, info) => {
  await page.route('**/*', async route => {
    if (new URL(route.request().url()).origin !== 'http://127.0.0.1:1422') throw new Error('Storage fixture must remain local.');
    await route.continue();
  });
  await page.addInitScript(preferences => localStorage.setItem('docker2u.preferences.v1', JSON.stringify(preferences)), {
    theme: info.project.metadata.theme, language: info.project.metadata.language,
  });
});

test('groups actual project mounts by volume and bind identity while keeping tmpfs local', async ({ page }, info) => {
  const w = words(info);
  await open(page, info);
  expect(await mountCalls(page)).toBe(0);
  const panel = await showStorage(page, info);
  await expect(panel.locator('.storage-mount')).toHaveCount(3);
  const volume = mountOf(panel, 'volume');
  await expect(volume).toContainText('shared-data');
  await expect(volume.locator(':scope > .storage-usages > .storage-usage')).toHaveCount(2);
  await expect(volume.locator(':scope > .storage-usages')).toContainText(backend);
  await expect(volume.locator(':scope > .storage-usages')).toContainText(redis);
  await expect(volume.locator(':scope > .storage-usages')).toContainText(w.readWrite);
  await expect(volume.locator(':scope > .storage-usages')).toContainText(w.readOnly);
  const bind = mountOf(panel, 'bind');
  await expect(bind).toContainText(await bindSource(page));
  await expect(bind.locator(':scope > .storage-usages')).toContainText('/app/settings.yaml');
  await expect(bind.locator('.storage-sharing summary')).toContainText('2');
  const tmpfs = mountOf(panel, 'tmpfs');
  await expect(tmpfs).toContainText(w.localMemory);
  await expect(tmpfs).toContainText('/tmp');
  await expect(tmpfs.locator('.storage-sharing')).toHaveCount(0);
  expect(await mountCalls(page)).toBe(1);
});

test('includes a stopped consumer from another project and navigates to its matching mount', async ({ page }, info) => {
  const w = words(info);
  await open(page, info);
  const workerRow = page.locator('.container-row').filter({ hasText: worker });
  await workerRow.locator('.container-tree-name').click();
  await page.locator('.recovery-actions').getByRole('button', { name: w.stop, exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: w.confirmStop, exact: true }).click();
  await expect(workerRow.locator('.state-exited')).toBeVisible();
  await page.getByRole('treeitem', { name: w.project, exact: true }).locator('.project-tree-name').click();
  const panel = await showStorage(page, info);
  const bind = mountOf(panel, 'bind');
  await bind.locator('.storage-sharing summary').click();
  await expect(bind.locator('.storage-sharing')).toContainText('workers / worker');
  await expect(bind.locator('.storage-sharing')).toContainText('/worker/settings.yaml');
  await expect(bind.locator('.storage-sharing .storage-usage').filter({ hasText: worker }).locator('.state-exited')).toBeVisible();
  const reads = await mountCalls(page);
  await bind.getByRole('button', { name: w.openWorker, exact: true }).click();
  await expect(workerRow).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.summary-status .state-exited')).toBeVisible();
  await expect(page.getByRole('tab', { name: w.storage, exact: true })).toHaveAttribute('aria-selected', 'true');
  const highlighted = page.locator('.storage-mount[data-highlighted="true"]');
  await expect(highlighted).toHaveCount(1);
  await expect(highlighted).toContainText('/worker/settings.yaml');
  await expect(highlighted).toContainText(await bindSource(page));
  await expect(highlighted).toBeInViewport();
  expect(await mountCalls(page)).toBe(reads);
});

test('wraps long paths in the viewport and copies the exact source through shared feedback', async ({ page }, info) => {
  const w = words(info);
  await open(page, info);
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { (window as MountFixtureWindow).copiedStoragePath = value; } } }));
  const panel = await showStorage(page, info);
  const source = await bindSource(page), bind = mountOf(panel, 'bind');
  const copy = bind.getByRole('button', { name: info.project.metadata.language === 'en' ? `Copy ${source}` : `${source} 복사`, exact: true });
  await copy.scrollIntoViewIfNeeded();
  await expect(copy).toBeInViewport();
  const overflow = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth - innerWidth,
    regions: [...document.querySelectorAll('.storage-panel, .storage-mount, .storage-path, .storage-usage')]
      .filter(node => node.getBoundingClientRect().width > 0).map(node => ({ name: node.className, excess: node.scrollWidth - node.clientWidth })).filter(row => row.excess > 1),
  }));
  expect(overflow.document).toBeLessThanOrEqual(1); expect(overflow.regions).toEqual([]);
  await copy.click();
  await expect(page.locator('.app-footer .clipboard-feedback')).toHaveText(w.copied);
  expect(await page.evaluate(() => (window as MountFixtureWindow).copiedStoragePath)).toBe(source);
});

test('preserves filtered paused logs and shares a storage query across tab and container round trips', async ({ page }, info) => {
  const w = words(info);
  await open(page, info);
  const search = page.getByRole('searchbox', { name: w.search, exact: true });
  await search.fill('request=');
  await expect(page.locator('.project-log-row').first()).toContainText('request=');
  await page.getByRole('button', { name: w.pause, exact: true }).click();
  const frozen = await page.locator('.project-log-row').allTextContents();
  const subscriptions = await page.evaluate(() => (window as unknown as { __docker2uObservationCalls: Record<string, number> }).__docker2uObservationCalls.configureLogs);
  await showStorage(page, info);
  const reads = await mountCalls(page);
  await page.getByRole('tab', { name: w.projectLogs, exact: true }).click();
  await expect(search).toHaveValue('request=');
  await expect(page.getByRole('button', { name: w.resume, exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.locator('.project-log-row').allTextContents()).toEqual(frozen);
  await showStorage(page, info);
  await page.locator('.container-row').filter({ hasText: backend }).locator('.container-tree-name').click();
  await showStorage(page, info);
  await page.getByRole('treeitem', { name: w.project, exact: true }).locator('.project-tree-name').click();
  await expect(page.getByRole('tab', { name: w.storage, exact: true })).toHaveAttribute('aria-selected', 'true');
  expect(await mountCalls(page)).toBe(reads);
  expect(await page.evaluate(() => (window as unknown as { __docker2uObservationCalls: Record<string, number> }).__docker2uObservationCalls.configureLogs)).toBe(subscriptions);
});

test('keeps partial coverage and unavailable consumer information distinct from no mounts', async ({ page }, info) => {
  const w = words(info);
  await open(page, info, 'partial');
  const panel = await showStorage(page, info);
  await expect(panel).toContainText(w.partial);
  await expect(panel.locator('.storage-mount')).toHaveCount(3);
  await expect(panel.getByText(w.empty, { exact: true })).toHaveCount(0);
  await page.getByRole('treeitem', { name: w.workerProject, exact: true }).locator('.project-tree-name').click();
  const workerPanel = await showStorage(page, info);
  await expect(workerPanel).toContainText(w.unavailable);
  await expect(workerPanel.getByText(w.empty, { exact: true })).toHaveCount(0);
  expect(await mountCalls(page)).toBe(1);
});

test('recovers failed reads, distinguishes confirmed empty mounts, and marks retained results stale on failure', async ({ page }, info) => {
  const w = words(info);
  await open(page, info, 'failed');
  const panel = await showStorage(page, info);
  await expect(panel.getByRole('alert')).toContainText(w.failed);
  await expect(panel.getByText(w.empty, { exact: true })).toHaveCount(0);
  await setMode(page, 'empty'); await panel.getByRole('button', { name: w.reload, exact: true }).click();
  await expect(panel.getByText(w.empty, { exact: true })).toBeVisible();
  await expect(panel.getByRole('alert')).toHaveCount(0);
  await setMode(page, 'complete'); await panel.getByRole('button', { name: w.reload, exact: true }).click();
  await expect(panel.locator('.storage-mount')).toHaveCount(3);
  await setMode(page, 'failed'); await panel.getByRole('button', { name: w.reload, exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText(w.failed);
  await expect(panel).toContainText(w.stale);
  await expect(panel.locator('.storage-mount')).toHaveCount(3);
  for (const button of await panel.locator('.storage-usage-heading button').all()) await expect(button).toBeDisabled();
});

test('exposes storage through project and container keyboard tab navigation', async ({ page }, info) => {
  const w = words(info);
  await open(page, info);
  const projectTabs = page.locator('.project-tabs');
  await projectTabs.getByRole('tab', { name: w.projectLogs, exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(projectTabs.getByRole('tab', { name: w.storage, exact: true })).toBeFocused();
  await expect(projectTabs.getByRole('tab', { name: w.storage, exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('End');
  await expect(projectTabs.getByRole('tab', { name: w.history, exact: true })).toBeFocused();
  await page.keyboard.press('Home');
  await expect(projectTabs.getByRole('tab', { name: w.projectLogs, exact: true })).toBeFocused();
  await page.locator('.container-row').filter({ hasText: backend }).locator('.container-tree-name').click();
  const containerTabs = page.locator('.container-detail .detail-tabs');
  await containerTabs.getByRole('tab', { name: w.logs, exact: true }).focus();
  await page.keyboard.press('End'); await page.keyboard.press('ArrowLeft');
  const storage = containerTabs.getByRole('tab', { name: w.storage, exact: true });
  await expect(storage).toBeFocused(); await page.keyboard.press('Enter');
  await expect(storage).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('region', { name: w.panel, exact: true })).toBeVisible();
});
