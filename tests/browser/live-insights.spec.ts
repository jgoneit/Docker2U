import { expect, test, type Page, type TestInfo } from '@playwright/test';

const backend = 'backend-주문처리-api-development';
const worker = 'worker-상태확인-required';
const standalone = 'scheduler-일시정지-paused';
const words = {
  ko: {
    project: '프로젝트', none: '프로젝트 없음', settings: '설정', details: '상세',
    selectAll: '보이는 컨테이너 전체 선택', searchContainers: '컨테이너 검색',
    resources: '자원 사용량', pause: '일시정지', resume: '재개', resize: '로그 패널 높이 조절',
    search: '로그 검색', openSearch: '로그 검색 열기', closeSearch: '로그 검색 닫기', next: '다음 일치',
    clear: '로그 화면 비우기', copy: '표시된 로그 복사', load: '로그 조회', latest: '최신 로그로',
  },
  en: {
    project: 'Project', none: 'No project', settings: 'Settings', details: 'details',
    selectAll: 'Select all visible containers', searchContainers: 'Search containers',
    resources: 'Resource usage', pause: 'Pause', resume: 'Resume', resize: 'Resize log pane',
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

test('project filtering clears action selection and removes a hidden container detail', async ({ page }, info) => {
  const t = words[language(info)];
  await openLive(page);
  await expect(page.locator('.container-project-header h3')).toHaveText(['orders', 'workers', t.none]);
  await expect(page.locator('.container-project-count')).toHaveText(['2', '1', '1']);
  await page.getByRole('checkbox', { name: t.selectAll, exact: true }).check();
  await expect(page.locator('.container-checkbox:checked')).toHaveCount(4);
  const filter = page.getByRole('combobox', { name: t.project, exact: true });
  await filter.selectOption({ label: 'workers' });
  await expect(page.locator('.container-row')).toHaveCount(1);
  await expect(page.locator('.container-checkbox:checked')).toHaveCount(0);
  await expect(page.locator('.log-content')).toHaveCount(0);
  await expect(page.locator('.detail-panel')).not.toContainText(backend);
  await page.getByRole('button', { name: `${worker} ${t.details}`, exact: true }).click();
  await expect(page.locator('.log-content')).toContainText('LIVE 2');
  await page.getByRole('checkbox', { name: t.selectAll, exact: true }).check();
  await filter.selectOption('none');
  await expect(page.locator('.container-project-header h3')).toHaveText([t.none]);
  await expect(page.locator('.container-row')).toHaveCount(1);
  await expect(page.locator('.container-row')).toContainText(standalone);
  await expect(page.locator('.container-checkbox:checked')).toHaveCount(0);
  await expect(page.locator('.log-content')).toHaveCount(0);
  await filter.selectOption('all');
  await page.getByRole('textbox', { name: t.searchContainers, exact: true }).fill('orders');
  await expect(page.locator('.container-project-header h3')).toHaveText(['orders']);
  await expect(page.locator('.container-row')).toHaveCount(2);
  const observed = await calls(page);
  expect(observed.mutateContainer).toBe(0);
  expect(observed.mutateContainers).toBe(0);
});

test('shows consistent current resources with readable controls in each theme and viewport', async ({ page }, info) => {
  const t = words[language(info)];
  await openLive(page);
  await expect(page.locator('html')).toHaveAttribute('lang', language(info));
  await expect(page.locator('html')).toHaveAttribute('data-theme', String(info.project.metadata.theme));
  const selectedRow = page.locator('tr.container-list-item').filter({ has: page.getByRole('button', { name: `${backend} ${t.details}`, exact: true }) });
  const detailed = page.getByRole('region', { name: t.resources, exact: true });
  await expect(selectedRow.locator('.container-cpu-value')).toHaveText('125.50%');
  await expect(selectedRow.locator('.container-memory-value')).toContainText('64MiB');
  const information = page.locator('.summary-information');
  await expect(information).not.toHaveAttribute('open', '');
  await information.locator('summary').click();
  await expect(detailed).toContainText('125.50%');
  await expect(detailed).toContainText('64MiB / 2GiB');
  await expect(information.locator('.resource-metadata time')).toHaveAttribute('datetime', /\d{4}-\d{2}-\d{2}T/);
  await detailed.scrollIntoViewIfNeeded();
  await expect(detailed).toBeInViewport();
  await information.locator('summary').click();
  await expect(page.getByRole('combobox', { name: t.project, exact: true })).toBeInViewport();
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

  const readability = await page.locator('.project-filter, .project-filter select, .container-project-header h3, .container-cpu-value, .container-memory-value, .resource-values strong, .log-stream-status, .compact-actions button:not(:disabled), .pane-resizer').evaluateAll(elements => {
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
  await page.locator('#theme-preference').selectOption(nextTheme);
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

test('resizes the lower log pane with pointer and keyboard while retaining the live view', async ({ page }, info) => {
  const lang = language(info), t = words[lang];
  await openLive(page);
  const separator = page.getByRole('separator', { name: t.resize, exact: true });
  await expect(separator).toHaveAttribute('aria-orientation', 'horizontal');
  await expect(separator).toHaveAttribute('aria-controls', 'inventory-pane detail-pane');
  const size = async () => ({
    height: Number(await separator.getAttribute('aria-valuenow')),
    min: Number(await separator.getAttribute('aria-valuemin')),
    max: Number(await separator.getAttribute('aria-valuemax')),
  });
  const geometry = () => page.evaluate(() => ({
    detail: document.querySelector('#detail-pane')!.getBoundingClientRect().height,
    inventory: document.querySelector('#inventory-pane')!.getBoundingClientRect().height,
  }));
  const initial = await size(), initialGeometry = await geometry();
  expect(initial.min).toBeGreaterThan(0);
  expect(initial.max).toBeGreaterThan(initial.min);
  expect(initial.height).toBeGreaterThanOrEqual(initial.min);
  expect(initial.height).toBeLessThanOrEqual(initial.max);
  expect(initialGeometry.detail).toBeCloseTo(initial.height, 0);
  const content = page.locator('.logs-panel:not([hidden]) .log-content');
  const contentNode = (await content.elementHandle())!;
  const receiptNode = (await page.locator('.log-fetched-at time').elementHandle())!;
  const before = await calls(page);

  const rect = (await separator.boundingBox())!;
  const grow = initial.max - initial.height >= 20;
  const distance = Math.min(40, grow ? initial.max - initial.height : initial.height - initial.min);
  expect(distance).toBeGreaterThan(0);
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.mouse.down();
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2 + (grow ? -distance : distance), { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await size()).height).not.toBe(initial.height);
  const dragged = await size(), draggedGeometry = await geometry();
  expect(dragged.height).toBeGreaterThanOrEqual(dragged.min);
  expect(dragged.height).toBeLessThanOrEqual(dragged.max);
  expect(draggedGeometry.detail).toBeCloseTo(dragged.height, 0);
  expect(draggedGeometry.inventory - initialGeometry.inventory).toBeCloseTo(initial.height - dragged.height, 0);
  await separator.focus();
  await page.keyboard.press('Home');
  await expect.poll(async () => (await size()).height).toBe(initial.min);
  await page.keyboard.press('End');
  await expect.poll(async () => (await size()).height).toBe(initial.max);
  await page.keyboard.press('ArrowDown');
  await expect.poll(async () => (await size()).height).toBe(Math.max(initial.min, initial.max - 20));
  await page.keyboard.press('ArrowUp');
  await expect.poll(async () => (await size()).height).toBe(initial.max);
  await expect(separator).toBeFocused();
  await separator.dblclick();
  await expect.poll(async () => (await size()).height).toBe(initial.height);
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
  await page.locator('#theme-preference').selectOption(info.project.metadata.theme === 'light' ? 'dark' : 'light');
  await page.locator('#language-preference').selectOption(nextLanguage);
  await page.keyboard.press('Escape');
  const renamedSeparator = page.getByRole('separator', { name: next.resize, exact: true });
  await expect(renamedSeparator).toBeVisible();
  const viewport = page.viewportSize()!;
  await page.setViewportSize(viewport.height === 680 ? { width: 1280, height: 800 } : { width: 1024, height: 680 });
  await expect(page.getByRole('searchbox', { name: next.search, exact: true })).toHaveValue('LAST_LINE_300');
  await expect(page.getByRole('button', { name: next.resume, exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: `${backend} ${next.details}`, exact: true })).toHaveAttribute('aria-current', 'true');
  expect(await content.textContent()).toBe(frozen);
  expect(await content.evaluate(element => element.scrollTop)).toBeCloseTo(scrollTop, 0);
  await expect(page.locator('.log-fetched-at time')).toHaveAttribute('datetime', receivedAt!);
  expect(await content.evaluate((element, original) => element === original, contentNode)).toBe(true);
  const current = Number(await renamedSeparator.getAttribute('aria-valuenow'));
  expect(current).toBeGreaterThanOrEqual(Number(await renamedSeparator.getAttribute('aria-valuemin')));
  expect(current).toBeLessThanOrEqual(Number(await renamedSeparator.getAttribute('aria-valuemax')));
  expect((await geometry()).detail).toBeCloseTo(current, 0);
  const after = await calls(page);
  for (const name of Object.keys(before).filter(name => !['getContainerStats', 'readLogStream'].includes(name))) expect(after[name], name).toBe(before[name]);
  await info.attach('split-pane-layout', { body: JSON.stringify({ initial, initialGeometry, dragged, draggedGeometry, current, before, after }), contentType: 'application/json' });
  await info.attach('split-pane-screen', { body: await page.screenshot(), contentType: 'image/png' });
});
