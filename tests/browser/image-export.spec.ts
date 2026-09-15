import { expect, test, type Page, type TestInfo } from '@playwright/test';

const redis = 'redis-캐시-stopped';
type ExportMode = 'success' | 'failed' | 'quiet' | 'timedOut' | 'lost-reply' | 'picker-cancel' | 'cleanup-warning';
type FixtureOperation = { requestId: string; containerId: string; imageId: string; imageReference: string; path: string; phase: string; outcome: string | null; bytesWritten: number; cleanupWarning: string | null };
type ExportFixture = { calls: Record<string, number>; setMode(mode: ExportMode): void; finish(): void; operations(): FixtureOperation[] };
function words(info: TestInfo) {
  return info.project.metadata.language === 'ko' ? {
    export: '이미지 내보내기', review: '이미지 내보내기 확인', pick: '저장 위치 선택', start: '내보내기 시작',
    progress: '이미지 내보내기 작업', recent: '최근 이미지 내보내기', close: '닫기', cancel: '내보내기 취소',
    search: '로그 키워드 검색', pause: '화면 일시정지', resume: '화면 재개', project: 'orders 프로젝트', storage: '저장소', mounts: '저장소 연결',
  } : {
    export: 'Export image', review: 'Review image export', pick: 'Choose destination', start: 'Start export',
    progress: 'Image export', recent: 'Recent image exports', close: 'Close', cancel: 'Cancel export',
    search: 'Search log text', pause: 'Pause view', resume: 'Resume view', project: 'orders project', storage: 'Storage', mounts: 'Storage mounts',
  };
}
test.beforeEach(async ({ page }, info) => {
  await page.addInitScript(preferences => localStorage.setItem('docker2u.preferences.v1', JSON.stringify(preferences)), {
    theme: info.project.metadata.theme, language: info.project.metadata.language,
  });
});
test.afterEach(async ({}, info) => {
  if (info.status !== info.expectedStatus) {
    for (const error of info.errors) console.error(`[image-export failure] ${info.project.name} · ${info.title}\n${error.stack ?? error.message ?? error.value}`);
  }
});
async function open(page: Page, mode: ExportMode = 'success', scenario = 'normal') {
  await page.goto(`/src/test/visual.html?toolbar=hidden&scenario=${scenario}&imageExportMode=${mode}`);
  await expect(page.locator('.container-row')).toHaveCount(4);
}
async function fixtureState(page: Page) {
  return page.evaluate(() => {
    const fixture = (window as unknown as { __docker2uImageExportFixture: ExportFixture }).__docker2uImageExportFixture;
    return { calls: { ...fixture.calls }, operations: fixture.operations() };
  });
}
async function finish(page: Page) {
  await page.evaluate(() => (window as unknown as { __docker2uImageExportFixture: ExportFixture }).__docker2uImageExportFixture.finish());
}
async function review(page: Page, info: TestInfo) {
  const w = words(info);
  await page.getByRole('button', { name: w.export, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: w.review, exact: true });
  await expect(dialog.getByRole('button', { name: w.pick, exact: true })).toBeEnabled();
  await expect(dialog.getByRole('button', { name: w.start, exact: true })).toBeDisabled();
  return dialog;
}
async function start(page: Page, info: TestInfo) {
  const w = words(info), dialog = await review(page, info);
  await dialog.getByRole('button', { name: w.pick, exact: true }).click();
  await dialog.getByRole('button', { name: w.start, exact: true }).click();
  const progress = page.getByRole('dialog', { name: w.progress, exact: true });
  await expect(progress).toBeVisible();
  return progress;
}

test('exports a stopped container’s actual image ID to the chosen tar without editable command or path inputs', async ({ page }, info) => {
  const w = words(info);
  await open(page);
  await page.locator('.container-row').filter({ hasText: redis }).click();
  const dialog = await review(page, info);
  await expect(dialog).toContainText(redis);
  await expect(dialog).toContainText('fixture.invalid/redis:7');
  await expect(dialog).toContainText(`sha256:${'a'.repeat(64)}`);
  await expect(dialog).toContainText(info.project.metadata.language === 'ko' ? '볼륨' : 'volume');
  await expect(dialog.getByRole('textbox')).toHaveCount(0);
  expect((await fixtureState(page)).calls.start ?? 0).toBe(0);
  await dialog.getByRole('button', { name: w.pick, exact: true }).click();
  await expect(dialog).toContainText(`/synthetic/exports/${redis}.tar`);
  await dialog.getByRole('button', { name: w.start, exact: true }).click();
  await finish(page);
  await expect.poll(async () => (await fixtureState(page)).operations.at(-1)?.outcome).toBe('succeeded');
  const progress = page.getByRole('dialog', { name: w.progress, exact: true });
  await expect(progress).not.toContainText(/\d+(?:\.\d+)?\s*%/);
  await expect(progress.getByRole('progressbar')).toHaveCount(0);
  const result = (await fixtureState(page)).operations.at(-1)!;
  expect(result.containerId).toBe('b'.repeat(64)); expect(result.imageId).toBe(`sha256:${'a'.repeat(64)}`);
  expect(result.imageReference).toBe('fixture.invalid/redis:7'); expect(result.bytesWritten).toBeGreaterThan(0);
  await expect(progress).toContainText('bytes');
  await expect(progress).toContainText(result.path);
  expect((await fixtureState(page)).calls.start).toBe(1);
});

test('cancelling the native destination picker does not start an export', async ({ page }, info) => {
  const w = words(info);
  await open(page, 'picker-cancel');
  const dialog = await review(page, info);
  await dialog.getByRole('button', { name: w.pick, exact: true }).click();
  await expect(dialog.getByRole('button', { name: w.start, exact: true })).toBeDisabled();
  expect((await fixtureState(page)).calls.start ?? 0).toBe(0);
  await dialog.getByRole('button', { name: w.close, exact: true }).first().click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: w.export, exact: true })).toBeFocused();
});

test('wraps modal keyboard focus and returns to the export trigger without changing the storage view', async ({ page }, info) => {
  const w = words(info);
  await open(page, 'quiet', 'observation');
  await page.locator('.container-row').first().click();
  const storage = page.getByRole('tab', { name: w.storage, exact: true });
  await storage.click();
  const panel = page.getByRole('region', { name: w.mounts, exact: true });
  await expect(panel).toHaveAttribute('aria-busy', 'false');
  const sharing = panel.locator('.storage-sharing').first();
  await sharing.locator('summary').click();
  await expect(sharing).toHaveAttribute('open', '');
  await panel.evaluate(element => element.setAttribute('data-export-view', 'preserved'));
  const reads = await page.evaluate(() => (window as unknown as { __docker2uMountFixture: { calls: number } }).__docker2uMountFixture.calls);
  const dialog = await review(page, info);
  const first = dialog.getByRole('button', { name: w.close, exact: true }).first();
  await expect(first).toBeFocused();
  await dialog.getByRole('button', { name: w.pick, exact: true }).click();
  const last = dialog.getByRole('button', { name: w.start, exact: true });
  await expect(last).toBeEnabled();
  await last.focus();
  await page.keyboard.press('Tab');
  await expect(first).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(last).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: w.export, exact: true })).toBeFocused();
  await expect(storage).toHaveAttribute('aria-selected', 'true');
  await expect(panel).toHaveAttribute('data-export-view', 'preserved');
  await expect(sharing).toHaveAttribute('open', '');
  expect(await page.evaluate(() => (window as unknown as { __docker2uMountFixture: { calls: number } }).__docker2uMountFixture.calls)).toBe(reads);
  expect((await fixtureState(page)).calls.start ?? 0).toBe(0);
});

test('closing a quiet export preserves the paused log view and cancellation remains explicit', async ({ page }, info) => {
  const w = words(info);
  await open(page, 'quiet', 'observation');
  await page.locator('.container-row').first().click();
  const search = page.getByRole('searchbox', { name: w.search, exact: true });
  await search.fill('request=');
  await expect(page.locator('.project-log-row').first()).toContainText('request=');
  await page.getByRole('button', { name: w.pause, exact: true }).click();
  const viewport = page.getByRole('log');
  const view = () => viewport.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return { position: element.scrollTop, rows: [...element.querySelectorAll('.project-log-row')].filter(row => {
      const rect = row.getBoundingClientRect();
      return rect.bottom > bounds.top && rect.top < bounds.bottom;
    }).map(row => row.textContent) };
  });
  const queryCount = () => page.evaluate(() => (window as unknown as { __docker2uObservationCalls: Record<string, number> }).__docker2uObservationCalls.queryLogs ?? 0);
  const readsBeforeScroll = await queryCount();
  await viewport.evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll')); element.setAttribute('data-export-view', 'preserved'); });
  await expect.poll(queryCount).toBeGreaterThan(readsBeforeScroll);
  await expect(viewport.locator('.project-log-window')).toHaveCSS('top', '0px');
  await expect.poll(async () => (await view()).rows.length).toBeGreaterThan(0);
  // Offscreen overscan rows may change after layout; preserve the visible frozen view.
  const before = await view();
  expect(before.position).toBe(0); expect(before.rows.length).toBeGreaterThan(0);
  const subscriptions = await page.evaluate(() => ({ ...(window as unknown as { __docker2uObservationCalls: Record<string, number> }).__docker2uObservationCalls }));
  const progress = await start(page, info);
  await expect.poll(async () => (await fixtureState(page)).operations.at(-1)?.bytesWritten ?? 0).toBeGreaterThan(0);
  await progress.getByRole('button', { name: w.close, exact: true }).last().click();
  await expect(progress).toBeHidden();
  await expect(search).toHaveValue('request='); await expect(page.getByRole('button', { name: w.resume, exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(viewport).toHaveAttribute('data-export-view', 'preserved');
  await expect.poll(view).toEqual(before);
  const after = await page.evaluate(() => ({ ...(window as unknown as { __docker2uObservationCalls: Record<string, number> }).__docker2uObservationCalls }));
  expect(after.configureLogs).toBe(subscriptions.configureLogs); expect(after.stopLogs).toBe(subscriptions.stopLogs);
  expect((await fixtureState(page)).calls.cancel ?? 0).toBe(0);
  await page.getByRole('button', { name: w.recent, exact: true }).click();
  await progress.getByRole('button', { name: w.cancel, exact: true }).click();
  await expect.poll(async () => (await fixtureState(page)).operations.at(-1)?.outcome).toBe('cancelled');
  expect((await fixtureState(page)).calls.start).toBe(1); expect((await fixtureState(page)).calls.cancel).toBe(1);
});

test('recovers a lost start response using the same request without creating another export', async ({ page }, info) => {
  const w = words(info);
  await open(page, 'lost-reply'); await start(page, info); await finish(page);
  await expect.poll(async () => (await fixtureState(page)).operations.at(-1)?.outcome).toBe('succeeded');
  await expect(page.getByRole('dialog', { name: w.progress, exact: true })).toContainText(`sha256:${'a'.repeat(64)}`);
  const state = await fixtureState(page);
  expect(state.calls.start).toBe(1); expect(state.operations).toHaveLength(1); expect(state.calls.read).toBeGreaterThan(0);
});

for (const [mode, outcome] of [['failed', 'failed'], ['timedOut', 'timedOut'], ['cleanup-warning', 'failed']] as const) {
  test(`retains the ${mode} result and keeps its controls inside the minimum viewport with long names`, async ({ page }, info) => {
    const w = words(info);
    await open(page, mode, 'long-metadata'); const progress = await start(page, info); await finish(page);
    await expect.poll(async () => (await fixtureState(page)).operations.at(-1)?.outcome).toBe(outcome);
    const result = (await fixtureState(page)).operations.at(-1)!;
    await expect(progress).toContainText(result.path);
    if (mode === 'cleanup-warning') {
      expect(result.cleanupWarning).toBeTruthy(); await expect(progress).toContainText(result.cleanupWarning!);
    }
    await expect(progress.getByRole('button', { name: w.cancel, exact: true })).toHaveCount(0);
    const bounds = await progress.boundingBox();
    expect(bounds).not.toBeNull(); expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width); expect(bounds!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
    expect(await progress.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    for (const button of await progress.getByRole('button').all()) {
      await button.scrollIntoViewIfNeeded(); await expect(button).toBeInViewport();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await progress.getByRole('button', { name: w.close, exact: true }).last().click();
    await page.getByRole('button', { name: w.recent, exact: true }).click();
    await expect(progress).toContainText(result.path); expect((await fixtureState(page)).calls.start).toBe(1);
  });
}
