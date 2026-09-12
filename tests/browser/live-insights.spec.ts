import { expect, test, type Page, type TestInfo } from '@playwright/test';

const backend = 'backend-주문처리-api-development';
const worker = 'worker-상태확인-required';
const standalone = 'scheduler-일시정지-paused';
const words = {
  ko: {
    project: '프로젝트', refresh: '새로고침', none: '프로젝트 없음', settings: '설정', details: '상세',
    selectAll: '보이는 컨테이너 전체 선택', searchContainers: '컨테이너 검색',
    logs: '로그', connections: '접속 정보', diagnostics: '상태 진단', history: '이력',
    resources: '자원 사용량', pause: '일시정지', resume: '재개', resize: '탐색 영역 너비 조절',
    search: '로그 검색', openSearch: '로그 검색 열기', closeSearch: '로그 검색 닫기', next: '다음 일치',
    clear: '로그 화면 비우기', copy: '표시된 로그 복사', load: '로그 조회', latest: '최신 로그로',
  },
  en: {
    project: 'project', refresh: 'Refresh', none: 'No project', settings: 'Settings', details: 'details',
    selectAll: 'Select all visible containers', searchContainers: 'Search containers',
    logs: 'Logs', connections: 'Connections', diagnostics: 'Diagnostics', history: 'History',
    resources: 'Resource usage', pause: 'Pause', resume: 'Resume', resize: 'Resize navigation pane',
    search: 'Search logs', openSearch: 'Open log search', closeSearch: 'Close log search', next: 'Next match',
    clear: 'Clear displayed logs', copy: 'Copy displayed logs', load: 'Load logs', latest: 'Latest logs',
  },
};
function language(info: TestInfo) { return info.project.metadata.language as keyof typeof words; }
async function calls(page: Page) {
  return page.evaluate(() => structuredClone((window as unknown as {
    __docker2uFixtureCalls: Record<string, number>;
  }).__docker2uFixtureCalls));
}
async function moreReads(page: Page, previous: number) {
  await expect.poll(async () => (await calls(page)).readLogStream).toBeGreaterThan(previous + 2);
}
async function openLive(page: Page) {
  await page.goto('/src/test/visual.html?toolbar=hidden&scenario=live');
  await expect(page.locator('.container-row')).toHaveCount(4);
  await expect(page.locator('.log-content')).toContainText('LAST_LINE_300');
  await expect(page.locator('.log-content')).toContainText('LIVE 2');
}

test.beforeEach(async ({ page }, info) => {
  await page.route('**/*', async route => {
    const origin = new URL(route.request().url()).origin;
    if (origin !== 'http://127.0.0.1:1422') throw new Error(`Unexpected request outside the synthetic fixture: ${origin}`);
    await route.continue();
  });
  await page.addInitScript(preferences => {
    localStorage.setItem('docker2u.preferences.v1', JSON.stringify(preferences));
  }, { theme: info.project.metadata.theme, language: language(info) });
});

test('tree navigation and refresh preserve action selection while search removes excluded targets', async ({ page }, info) => {
  const lang = language(info), t = words[lang];
  await openLive(page);
  await expect(page.getByRole('tree', { name: lang === 'ko' ? '컨테이너 목록' : 'Container list', exact: true })).toBeVisible();
  await expect(page.locator('.project-tree-name')).toHaveText(['orders', 'workers', t.none]);
  await expect(page.locator('.container-project-count')).toHaveText(['2', '1', '1']);
  await page.getByRole('checkbox', { name: t.selectAll, exact: true }).check();
  await expect(page.locator('.container-checkbox:checked')).toHaveCount(4);
  const workers = page.getByRole('treeitem', { name: `workers ${t.project}`, exact: true });
  await workers.locator('.project-tree-name').click();
  await expect(workers).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.container-row')).toHaveCount(4);
  await expect(page.locator('.container-checkbox:checked')).toHaveCount(4);
  await expect(page.locator('.log-content')).toHaveCount(0);
  await expect(page.locator('.detail-panel')).not.toContainText(backend);
  await page.getByRole('button', { name: t.refresh, exact: true }).click();
  await expect(page.getByRole('button', { name: t.refresh, exact: true })).toBeEnabled();
  await expect(page.locator('.container-checkbox:checked')).toHaveCount(4);

  // Moving tree focus does not change the displayed target until activation.
  await workers.focus();
  await workers.press('ArrowDown');
  const workerNode = page.getByRole('treeitem', { name: `${worker} ${t.details}`, exact: true });
  await expect(workerNode).toBeFocused();
  await expect(workers).toHaveAttribute('aria-selected', 'true');
  await expect(workerNode).toHaveAttribute('aria-selected', 'false');
  await workerNode.press('Enter');
  await expect(workerNode).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.log-content')).toContainText('LIVE 2');
  await expect(page.locator('.container-checkbox:checked')).toHaveCount(4);

  const ungrouped = page.getByRole('treeitem', { name: t.none, exact: true });
  await ungrouped.focus();
  await ungrouped.press('ArrowLeft');
  await expect(ungrouped).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('treeitem', { name: `${standalone} ${t.details}`, exact: true })).toHaveCount(0);
  await expect(workerNode).toHaveAttribute('aria-selected', 'true');
  await ungrouped.press('ArrowRight');
  await expect(page.locator('.container-row')).toHaveCount(4);
  await expect(page.locator('.container-checkbox:checked')).toHaveCount(4);
  await page.getByRole('textbox', { name: t.searchContainers, exact: true }).fill('orders');
  await expect(page.locator('.project-tree-name')).toHaveText(['orders']);
  await expect(page.locator('.container-row')).toHaveCount(2);
  await expect(page.locator('.container-checkbox:checked')).toHaveCount(2);
  await expect(page.locator('.selection-hidden-notice')).toBeVisible();
  await expect(page.locator('.detail-panel')).toContainText(worker);
  const observed = await calls(page);
  expect(observed.mutateContainer).toBe(0);
  expect(observed.mutateContainers).toBe(0);
});

test('shows consistent current resources with readable controls in each theme and viewport', async ({ page }, info) => {
  const t = words[language(info)];
  await openLive(page);
  await expect(page.locator('html')).toHaveAttribute('lang', language(info));
  await expect(page.locator('html')).toHaveAttribute('data-theme', String(info.project.metadata.theme));
  const selectedRow = page.getByRole('treeitem', { name: `${backend} ${t.details}`, exact: true });
  const detailed = page.getByRole('region', { name: t.resources, exact: true });
  await expect(selectedRow.locator('.container-cpu-value')).toHaveText('125.50%');
  await expect(selectedRow.locator('.container-memory-value')).toContainText('64MiB');
  const information = page.locator('.container-information');
  await expect(information).toHaveCount(0);
  await page.getByRole('tab', { name: t.connections, exact: true }).click();
  await expect(detailed).toContainText('125.50%');
  await expect(detailed).toContainText('64MiB / 2GiB');
  await expect(information.locator('.resource-metadata time')).toHaveAttribute('datetime', /\d{4}-\d{2}-\d{2}T/);
  await detailed.scrollIntoViewIfNeeded();
  await expect(detailed).toBeInViewport();
  await page.getByRole('tab', { name: t.logs, exact: true }).click();
  await expect(information).toHaveCount(0);
  await expect(page.getByRole('treeitem', { name: `orders ${t.project}`, exact: true }).locator('.project-tree-name')).toBeInViewport();
  await page.getByRole('button', { name: t.pause, exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: t.pause, exact: true })).toBeInViewport();
  await page.locator('.log-content').scrollIntoViewIfNeeded();
  const layout = await page.evaluate(() => {
    const overflow = [...document.querySelectorAll('.app-shell, .workspace, .inventory-panel, .detail-panel, .logs-panel, .log-content, .resource-summary, .container-cpu-value, .container-memory-value')]
      .filter(element => element.getBoundingClientRect().width > 0)
      .map(element => ({ name: element.className, pixels: element.scrollWidth - element.clientWidth }))
      .filter(value => value.pixels > 1);
    const log = document.querySelector('.log-content')!.getBoundingClientRect();
    const footer = document.querySelector('.app-footer')!.getBoundingClientRect();
    return { overflow, pageOverflow: document.documentElement.scrollWidth - innerWidth, logHeight: log.height, logBottom: log.bottom, footerTop: footer.top };
  });
  expect(layout.pageOverflow).toBeLessThanOrEqual(1);
  expect(layout.overflow).toEqual([]);
  expect(layout.logHeight).toBeGreaterThanOrEqual(80);
  expect(layout.logBottom).toBeLessThanOrEqual(layout.footerTop + 1);

  const readability = await page.locator('.project-tree-name, .container-tree-name, .container-cpu-value, .container-memory-value, .resource-values strong, .log-stream-status, .compact-actions button:not(:disabled), .pane-resizer').evaluateAll(elements => {
    type Color = [number, number, number, number];
    const color = (value: string): Color => {
      const parts = value.match(/[\d.]+/g)?.map(Number);
      if (!parts || parts.length < 3) throw new Error(`Unrecognized computed color: ${value}`);
      return [parts[0]!, parts[1]!, parts[2]!, parts[3] ?? 1];
    };
    const over = (front: Color, back: Color): Color => [
      front[0] * front[3] + back[0] * (1 - front[3]),
      front[1] * front[3] + back[1] * (1 - front[3]),
      front[2] * front[3] + back[2] * (1 - front[3]), 1,
    ];
    const luminance = (value: Color) => value.slice(0, 3).map(channel => {
      const scaled = channel / 255;
      return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
    }).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index]!, 0);
    return elements.filter(element => element.getBoundingClientRect().width > 0).map(element => {
      const backgrounds: Color[] = [];
      for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
        const background = color(getComputedStyle(ancestor).backgroundColor);
        backgrounds.push(background);
        if (background[3] === 1) break;
      }
      const background = backgrounds.reverse().reduce((base, layer) => over(layer, base), [255, 255, 255, 1] as Color);
      const style = getComputedStyle(element);
      const foreground = over(color(style.color), background);
      const a = luminance(foreground), b = luminance(background);
      return { name: element.className || element.tagName, fontSize: parseFloat(style.fontSize), contrast: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) };
    });
  });
  for (const sample of readability) {
    expect(sample.fontSize, JSON.stringify(sample)).toBeGreaterThanOrEqual(12);
    expect(sample.contrast, JSON.stringify(sample)).toBeGreaterThanOrEqual(4.5);
  }
  await info.attach('live-insights-layout', { body: JSON.stringify({ layout, readability }), contentType: 'application/json' });
  await info.attach('live-insights-screen', { body: await page.screenshot(), contentType: 'image/png' });
});

test('container metadata lives in Connections while header height and target survive tabs and preferences', async ({ page }, info) => {
  const lang = language(info), t = words[lang];
  await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { (window as unknown as { copiedContainerId: string }).copiedContainerId = text; } } }));
  await openLive(page);
  const header = page.locator('.container-summary');
  const height = await header.evaluate(node => node.getBoundingClientRect().height);
  await expect(header.getByRole('heading', { name: backend, exact: true })).toBeVisible();
  await expect(header.locator('details')).toHaveCount(0);
  await expect(header).not.toContainText('a'.repeat(64));
  const metadata = page.locator('.container-information');
  await expect(metadata).toHaveCount(0);
  await page.locator('.container-checkbox').first().check();
  for (const name of [t.diagnostics, t.history, t.connections]) {
    await page.getByRole('tab', { name, exact: true }).click();
    expect(await header.evaluate(node => node.getBoundingClientRect().height)).toBe(height);
    if (name !== t.connections) await expect(metadata).toHaveCount(0);
  }
  await expect(metadata.getByRole('heading', { name: lang === 'ko' ? '컨테이너 정보' : 'Container information', exact: true })).toBeVisible();
  await expect(metadata.locator('.summary-facts')).toContainText('a'.repeat(64));
  await expect(metadata.locator('.summary-facts')).toContainText('orders');
  await expect(metadata.locator('.summary-facts')).toContainText('api');
  const metadataBox = await metadata.boundingBox(), networksBox = await page.locator('.container-insights').boundingBox();
  expect(metadataBox!.y + metadataBox!.height).toBeLessThanOrEqual(networksBox!.y);
  const copy = metadata.getByRole('button', { name: lang === 'ko' ? '전체 ID 복사' : 'Copy full ID', exact: true });
  await copy.click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { copiedContainerId: string }).copiedContainerId)).toBe('a'.repeat(64));
  await expect(page.locator('.app-footer .clipboard-feedback')).toHaveText(lang === 'ko' ? '전체 ID 복사됨' : 'Full ID copied');
  await expect(page.locator('.app-footer .copy-feedback-glow')).toHaveCount(1);
  const before = await calls(page);
  await page.getByRole('button', { name: t.settings, exact: true }).click();
  const nextLanguage = lang === 'ko' ? 'en' : 'ko', nextWords = words[nextLanguage];
  const nextTheme = info.project.metadata.theme === 'light' ? 'dark' : 'light';
  await page.locator(`input[name="theme-preference"][value="${nextTheme}"]`).check();
  await page.locator('#language-preference').selectOption(nextLanguage);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('tab', { name: nextWords.connections, exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('treeitem', { name: `${backend} ${nextWords.details}`, exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.container-checkbox').first()).toBeChecked();
  await expect(metadata.getByRole('heading', { name: nextLanguage === 'ko' ? '컨테이너 정보' : 'Container information', exact: true })).toBeVisible();
  expect(await header.evaluate(node => node.getBoundingClientRect().height)).toBe(height);
  expect(await metadata.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  const after = await calls(page);
  for (const name of ['getContainerDetails', 'getEnvironment', 'listContainers', 'mutateContainer', 'mutateContainers']) expect(after[name]).toBe(before[name]);
  await page.getByRole('tab', { name: nextWords.logs, exact: true }).click();
  await expect(metadata).toHaveCount(0);
  expect(await header.evaluate(node => node.getBoundingClientRect().height)).toBe(height);
});

test('pause and search freeze the view while live reads continue and resume catches up', async ({ page }, info) => {
  const lang = language(info), t = words[lang];
  await openLive(page);
  const content = page.locator('.log-content');
  await page.getByRole('button', { name: t.pause, exact: true }).click();
  await expect(page.getByRole('button', { name: t.resume, exact: true })).toHaveAttribute('aria-pressed', 'true');
  const frozen = await content.textContent();
  await moreReads(page, (await calls(page)).readLogStream!);
  expect(await content.textContent()).toBe(frozen);
  await page.getByRole('button', { name: t.openSearch, exact: true }).click();
  await page.getByRole('searchbox', { name: t.search, exact: true }).fill('Request processed');
  await expect(page.locator('.log-search-count')).toHaveText(lang === 'ko' ? '1 / 298건' : '1 / 298 matches');
  await page.getByRole('button', { name: t.next, exact: true }).click();
  await moreReads(page, (await calls(page)).readLogStream!);
  await expect(page.locator('.log-search-count')).toHaveText(lang === 'ko' ? '2 / 298건' : '2 / 298 matches');
  expect(await content.textContent()).toBe(frozen);
  await page.getByRole('button', { name: t.closeSearch, exact: true }).click();
  await moreReads(page, (await calls(page)).readLogStream!);
  expect(await content.textContent()).toBe(frozen);
  await page.getByRole('button', { name: t.resume, exact: true }).click();
  await expect.poll(() => content.textContent()).not.toBe(frozen);

  await page.getByRole('button', { name: t.openSearch, exact: true }).click();
  await page.getByRole('searchbox', { name: t.search, exact: true }).fill('LAST_LINE_300');
  await expect(content.locator('mark')).toHaveText('LAST_LINE_300');
  const searching = await content.textContent();
  await moreReads(page, (await calls(page)).readLogStream!);
  expect(await content.textContent()).toBe(searching);
  await page.getByRole('button', { name: t.closeSearch, exact: true }).click();
  await expect.poll(() => content.textContent()).not.toBe(searching);
  const observed = await calls(page);
  expect(observed.startLogStream).toBe(1);
  expect(observed.stopLogStream).toBe(0);
});

test('preserves frozen search across preferences and Clear stops reads until explicit reload', async ({ page }, info) => {
  const initialLanguage = language(info), t = words[initialLanguage];
  await openLive(page);
  await page.getByRole('button', { name: t.pause, exact: true }).click();
  await page.getByRole('button', { name: t.openSearch, exact: true }).click();
  await page.getByRole('searchbox', { name: t.search, exact: true }).fill('LAST_LINE_300');
  await expect(page.locator('.log-search-match')).toHaveText('LAST_LINE_300');
  const frozen = await page.locator('.log-content').textContent();
  const before = await calls(page);
  await page.getByRole('button', { name: t.settings, exact: true }).click();
  const nextLanguage = initialLanguage === 'ko' ? 'en' : 'ko';
  const nextTheme = info.project.metadata.theme === 'light' ? 'dark' : 'light';
  await page.locator(`input[name="theme-preference"][value="${nextTheme}"]`).check();
  await page.locator('#language-preference').selectOption(nextLanguage);
  await page.keyboard.press('Escape');
  await expect(page.locator('html')).toHaveAttribute('lang', nextLanguage);
  await expect(page.locator('html')).toHaveAttribute('data-theme', nextTheme);
  const next = words[nextLanguage];
  await expect(page.getByRole('searchbox', { name: next.search, exact: true })).toHaveValue('LAST_LINE_300');
  await expect(page.getByRole('button', { name: next.resume, exact: true })).toHaveAttribute('aria-pressed', 'true');
  await moreReads(page, before.readLogStream!);
  expect(await page.locator('.log-content').textContent()).toBe(frozen);
  expect((await calls(page)).startLogStream).toBe(before.startLogStream);

  await page.getByRole('button', { name: next.clear, exact: true }).click();
  await expect.poll(async () => (await calls(page)).stopLogStream).toBeGreaterThan(before.stopLogStream!);
  await expect(page.locator('.log-content')).not.toContainText('LAST_LINE_300');
  await expect(page.getByRole('button', { name: next.copy, exact: true })).toBeDisabled();
  const cleared = await calls(page);
  // Several complete drain intervals must pass without a silent re-subscription.
  await page.waitForTimeout(800);
  const later = await calls(page);
  expect(later.readLogStream).toBe(cleared.readLogStream);
  expect(later.startLogStream).toBe(cleared.startLogStream);
  await page.getByRole('button', { name: next.load, exact: true }).click();
  await expect.poll(async () => (await calls(page)).startLogStream).toBe(cleared.startLogStream! + 1);
  await moreReads(page, cleared.readLogStream!);
  await expect(page.getByRole('button', { name: next.resume, exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.log-content')).toHaveText(nextLanguage === 'ko' ? '최근 로그가 없습니다.' : 'No recent logs.');
  await expect(page.getByRole('button', { name: next.copy, exact: true })).toBeDisabled();
  await page.getByRole('button', { name: next.resume, exact: true }).click();
  await expect(page.locator('.log-content')).toContainText('LIVE 2');
  expect((await calls(page)).startLogStream).toBe(cleared.startLogStream! + 1);
});

test('resizes the navigation width with pointer and keyboard while retaining the live view', async ({ page }, info) => {
  const lang = language(info), t = words[lang];
  await openLive(page);
  const separator = page.getByRole('separator', { name: t.resize, exact: true });
  await expect(separator).toHaveAttribute('aria-orientation', 'vertical');
  await expect(separator).toHaveAttribute('aria-controls', 'inventory-pane detail-pane');
  const size = async () => ({
    width: Number(await separator.getAttribute('aria-valuenow')),
    min: Number(await separator.getAttribute('aria-valuemin')),
    max: Number(await separator.getAttribute('aria-valuemax')),
  });
  const geometry = () => page.evaluate(() => ({
    detail: document.querySelector('#detail-pane')!.getBoundingClientRect().width,
    inventory: document.querySelector('#inventory-pane')!.getBoundingClientRect().width,
    inventoryRight: document.querySelector('#inventory-pane')!.getBoundingClientRect().right,
    detailLeft: document.querySelector('#detail-pane')!.getBoundingClientRect().left,
    inventoryTop: document.querySelector('#inventory-pane')!.getBoundingClientRect().top,
    detailTop: document.querySelector('#detail-pane')!.getBoundingClientRect().top,
  }));
  const initial = await size(), initialGeometry = await geometry();
  expect(initial.min).toBeGreaterThan(0);
  expect(initial.max).toBeGreaterThan(initial.min);
  expect(initial.width).toBeGreaterThanOrEqual(initial.min);
  expect(initial.width).toBeLessThanOrEqual(initial.max);
  expect(initialGeometry.inventory).toBeCloseTo(initial.width, 0);
  expect(initialGeometry.detailLeft).toBeGreaterThanOrEqual(initialGeometry.inventoryRight);
  expect(initialGeometry.detailTop).toBeCloseTo(initialGeometry.inventoryTop, 0);
  const content = page.locator('.logs-panel:not([hidden]) .log-content');
  const contentNode = (await content.elementHandle())!;
  const receiptNode = (await page.locator('.log-fetched-at time').elementHandle())!;
  const before = await calls(page);

  const rect = (await separator.boundingBox())!;
  const grow = initial.max - initial.width >= 20;
  const distance = Math.min(40, grow ? initial.max - initial.width : initial.width - initial.min);
  expect(distance).toBeGreaterThan(0);
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.mouse.down();
  await page.mouse.move(rect.x + rect.width / 2 + (grow ? distance : -distance), rect.y + rect.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await size()).width).not.toBe(initial.width);
  const dragged = await size(), draggedGeometry = await geometry();
  expect(dragged.width).toBeGreaterThanOrEqual(dragged.min);
  expect(dragged.width).toBeLessThanOrEqual(dragged.max);
  expect(draggedGeometry.inventory).toBeCloseTo(dragged.width, 0);
  expect(draggedGeometry.detail - initialGeometry.detail).toBeCloseTo(initial.width - dragged.width, 0);
  await separator.focus();
  await page.keyboard.press('Home');
  await expect.poll(async () => (await size()).width).toBe(initial.min);
  await page.keyboard.press('End');
  await expect.poll(async () => (await size()).width).toBe(initial.max);
  await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => (await size()).width).toBe(Math.max(initial.min, initial.max - 20));
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await size()).width).toBe(initial.max);
  await expect(separator).toBeFocused();
  await separator.dblclick();
  await expect.poll(async () => (await size()).width).toBe(initial.width);
  await moreReads(page, before.readLogStream!);
  expect(await content.evaluate((element, original) => element === original, contentNode)).toBe(true);
  expect(await page.locator('.log-fetched-at time').evaluate((element, original) => element === original, receiptNode)).toBe(true);

  await page.getByRole('button', { name: t.pause, exact: true }).click();
  await page.getByRole('button', { name: t.openSearch, exact: true }).click();
  await page.getByRole('searchbox', { name: t.search, exact: true }).fill('LAST_LINE_300');
  await expect(content.locator('mark')).toHaveText('LAST_LINE_300');
  const frozen = await content.textContent();
  const receivedAt = await page.locator('.log-fetched-at time').getAttribute('datetime');
  const scrollTop = await content.evaluate(element => { element.scrollTop = 80; element.dispatchEvent(new Event('scroll')); return element.scrollTop; });
  await separator.focus();
  await page.keyboard.press('End');
  await moreReads(page, (await calls(page)).readLogStream!);
  expect(await content.textContent()).toBe(frozen);
  expect(await content.evaluate(element => element.scrollTop)).toBeCloseTo(scrollTop, 0);

  await page.getByRole('button', { name: t.settings, exact: true }).click();
  const nextLanguage = lang === 'ko' ? 'en' : 'ko', next = words[nextLanguage];
  await page.locator(`input[name="theme-preference"][value="${info.project.metadata.theme === 'light' ? 'dark' : 'light'}"]`).check();
  await page.locator('#language-preference').selectOption(nextLanguage);
  await page.keyboard.press('Escape');
  const renamedSeparator = page.getByRole('separator', { name: next.resize, exact: true });
  await expect(renamedSeparator).toBeVisible();
  const viewport = page.viewportSize()!;
  await page.setViewportSize(viewport.height === 680 ? { width: 1280, height: 800 } : { width: 1024, height: 680 });
  await expect(page.getByRole('searchbox', { name: next.search, exact: true })).toHaveValue('LAST_LINE_300');
  await expect(page.getByRole('button', { name: next.resume, exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('treeitem', { name: `${backend} ${next.details}`, exact: true })).toHaveAttribute('aria-selected', 'true');
  expect(await content.textContent()).toBe(frozen);
  expect(await content.evaluate(element => element.scrollTop)).toBeCloseTo(scrollTop, 0);
  await expect(page.locator('.log-fetched-at time')).toHaveAttribute('datetime', receivedAt!);
  expect(await content.evaluate((element, original) => element === original, contentNode)).toBe(true);
  const current = Number(await renamedSeparator.getAttribute('aria-valuenow'));
  expect(current).toBeGreaterThanOrEqual(Number(await renamedSeparator.getAttribute('aria-valuemin')));
  expect(current).toBeLessThanOrEqual(Number(await renamedSeparator.getAttribute('aria-valuemax')));
  expect((await geometry()).inventory).toBeCloseTo(current, 0);
  const after = await calls(page);
  for (const name of Object.keys(before).filter(name => !['getContainerStats', 'readLogStream'].includes(name))) expect(after[name], name).toBe(before[name]);
  await info.attach('split-pane-layout', { body: JSON.stringify({ initial, initialGeometry, dragged, draggedGeometry, current, before, after }), contentType: 'application/json' });
  await info.attach('split-pane-screen', { body: await page.screenshot(), contentType: 'image/png' });
});

test('standalone navigation restores frozen search and the visible scroll position', async ({ page }, info) => {
  const t = words[language(info)];
  await openLive(page);
  const target = page.getByRole('treeitem', { name: `${standalone} ${t.details}`, exact: true });
  await target.click();
  const content = page.locator('.log-content');
  await expect(content).toContainText('LAST_LINE_300');
  await page.getByRole('button', { name: t.pause, exact: true }).click();
  await page.getByRole('button', { name: t.openSearch, exact: true }).click();
  await page.getByRole('searchbox', { name: t.search, exact: true }).fill('Request processed');
  await expect(content.locator('mark')).toHaveText('Request processed');
  await content.evaluate(node => { node.scrollTop = 1500; });
  await expect.poll(() => content.evaluate(node => node.scrollTop)).toBe(1500);
  const frozen = await content.textContent();
  await page.getByRole('treeitem', { name: `${worker} ${t.details}`, exact: true }).click();
  await expect(content).toContainText('LAST_LINE_300');
  await target.click();
  await expect(page.getByRole('searchbox', { name: t.search, exact: true })).toHaveValue('Request processed');
  await expect(page.getByRole('button', { name: t.resume, exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(await content.textContent()).toBe(frozen);
  await expect.poll(() => content.evaluate(node => node.scrollTop)).toBe(1500);
  await moreReads(page, (await calls(page)).readLogStream!);
  expect(await content.textContent()).toBe(frozen);
  expect(await content.evaluate(node => node.scrollTop)).toBe(1500);
});
