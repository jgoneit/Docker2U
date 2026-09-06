import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';

const backend = 'backend-주문처리-api-development';
const redis = 'redis-캐시-stopped';
const words = {
  ko: {
    settings: '설정', refresh: '새로고침', restart: '재시작', confirmRestart: '재시작 확인',
    search: '로그 검색', next: '다음 일치', previous: '이전 일치', clearSearch: '로그 검색 지우기',
    openSearch: '로그 검색 열기', closeSearch: '로그 검색 닫기',
    containerSearch: '컨테이너 검색', clearContainerSearch: '컨테이너 검색 지우기', runningFilter: '실행 중',
    showDiagnostics: '환경 진단 보기', closeDiagnostics: '환경 진단 닫기', executionDetails: '실행 상세',
    bottom: '맨 아래로', expand: '로그 확대 보기', closeLogs: '로그 확대 보기 닫기',
    showResult: '결과 펼치기', hideResult: '결과 접기', result: '최근 작업 결과',
    unknown: '결과 불명', details: '상세',
    start: '시작', stop: '중지', confirmStop: '중지 확인', cancel: '취소', selectVisible: '보이는 컨테이너 전체 선택',
  },
  en: {
    settings: 'Settings', refresh: 'Refresh', restart: 'Restart', confirmRestart: 'Confirm Restart',
    search: 'Search logs', next: 'Next match', previous: 'Previous match', clearSearch: 'Clear log search',
    openSearch: 'Open log search', closeSearch: 'Close log search',
    containerSearch: 'Search containers', clearContainerSearch: 'Clear container search', runningFilter: 'Running',
    showDiagnostics: 'Show environment diagnostics', closeDiagnostics: 'Close diagnostics', executionDetails: 'Execution details',
    bottom: 'Scroll to bottom', expand: 'Expand logs', closeLogs: 'Close expanded logs',
    showResult: 'Show result details', hideResult: 'Hide result details', result: 'Latest operation result',
    unknown: 'Result unknown', details: 'details',
    start: 'Start', stop: 'Stop', confirmStop: 'Confirm Stop', cancel: 'Cancel', selectVisible: 'Select all visible containers',
  },
};
function language(testInfo: TestInfo) { return testInfo.project.metadata.language as keyof typeof words; }

test.beforeEach(async ({ page }, testInfo) => {
  // Every test uses synthetic API replacements. An unexpected external HTTP request fails.
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://127.0.0.1:1422') throw new Error(`Unexpected request outside the local fixture: ${url.origin}`);
    await route.continue();
  });
  await page.addInitScript(preferences => {
    localStorage.setItem('docker2u.preferences.v1', JSON.stringify(preferences));
    const platform = new URL(location.href).searchParams.get('browserTestPlatform');
    if (platform === 'MacIntel' || platform === 'Win32') Object.defineProperty(navigator, 'platform', { configurable: true, get: () => platform });
  }, { theme: testInfo.project.metadata.theme, language: language(testInfo) });
});

async function openFixture(page: Page, scenario = 'normal', platform?: string) {
  await page.goto(`/src/test/visual.html?toolbar=hidden&scenario=${scenario}${platform ? `&browserTestPlatform=${platform}` : ''}`);
  await expect(page.locator('.container-row')).toHaveCount(4);
  if (scenario === 'dense-logs') await expect.poll(() => page.locator('.log-content').textContent().then(text => text?.length)).toBe(2 * 1024 * 1024);
  else if (scenario !== 'log-error') await expect(page.locator('.log-content')).toContainText('LAST_LINE_300');
}

async function visibleTextRange(content: Locator, text: string) {
  await expect.poll(() => content.evaluate((element, needle) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const offset = node.textContent?.indexOf(needle) ?? -1;
      if (offset < 0) continue;
      const range = document.createRange();
      range.setStart(node, offset);
      range.setEnd(node, offset + needle.length);
      const rectangles = [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0);
      // Intersect all scrolling ancestors with the actual viewport, not just the log box.
      let clip = { top: 0, bottom: innerHeight, left: 0, right: innerWidth };
      for (let parent: Element | null = element; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (!/(auto|scroll|hidden|clip)/.test(`${style.overflowX} ${style.overflowY}`)) continue;
        const rect = parent.getBoundingClientRect();
        clip = { top: Math.max(clip.top, rect.top), bottom: Math.min(clip.bottom, rect.bottom), left: Math.max(clip.left, rect.left), right: Math.min(clip.right, rect.right) };
      }
      return rectangles.length > 0 && rectangles.every(rect => rect.top >= clip.top - 1 && rect.bottom <= clip.bottom + 1 && rect.left >= clip.left - 1 && rect.right <= clip.right + 1);
    }
    return false;
  }, text), { message: `Text ${JSON.stringify(text)} must be inside both its scroll container and the viewport` }).toBe(true);
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth - innerWidth,
    regions: [...document.querySelectorAll('.app-shell, .workspace, .inventory-panel, .detail-panel, .logs-panel, .log-content, .logs-modal, .operation-result')]
      .filter(element => element.getBoundingClientRect().width > 0)
      .map(element => ({ name: element.className, amount: element.scrollWidth - element.clientWidth }))
      .filter(value => value.amount > 1),
  }));
  expect(overflow.document).toBeLessThanOrEqual(1);
  expect(overflow.regions).toEqual([]);
}

async function expectReadableSmallText(page: Page) {
  const undersized = await page.locator('.log-meta, .field-label, .app-footer, .health, .log-search label, .log-search-input, .log-search-count, .compact-actions button').evaluateAll(elements =>
    elements.filter(element => element.getBoundingClientRect().width > 0)
      .map(element => ({ name: element.className || element.tagName, size: parseFloat(getComputedStyle(element).fontSize) }))
      .filter(value => value.size < 12),
  );
  expect(undersized).toEqual([]);
}

async function expectLogFits(page: Page, minimumLines = 0) {
  // Measurements do not scroll or focus anything: clipping must be absent before interaction.
  const metrics = await page.evaluate(() => {
    const detail = document.querySelector<HTMLElement>('.detail-panel')!;
    const panel = detail.querySelector<HTMLElement>('.logs-panel:not([hidden])')!;
    const content = panel.querySelector<HTMLElement>('.log-content, .log-error')!;
    const footer = document.querySelector<HTMLElement>('.app-footer')!;
    const box = (element: Element) => {
      const { top, bottom, left, right, height, width } = element.getBoundingClientRect();
      return { top, bottom, left, right, height, width };
    };
    const style = getComputedStyle(content);
    return {
      detail: box(detail), panel: box(panel), content: box(content), footer: box(footer),
      outerScroll: detail.scrollTop, documentScroll: document.documentElement.scrollTop,
      outerOverflow: detail.scrollHeight - detail.clientHeight,
      textLines: (content.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)) / parseFloat(style.lineHeight),
      viewport: { width: innerWidth, height: innerHeight },
    };
  });
  const boundary = { top: Math.max(0, metrics.detail.top), bottom: Math.min(metrics.detail.bottom, metrics.footer.top, metrics.viewport.height) };
  for (const [name, rect] of [['panel', metrics.panel], ['content', metrics.content]] as const) {
    const top = name === 'content' ? Math.max(boundary.top, metrics.panel.top) : boundary.top;
    const bottom = name === 'content' ? Math.min(boundary.bottom, metrics.panel.bottom) : boundary.bottom;
    expect(rect.height, `${name} has usable height: ${JSON.stringify(metrics)}`).toBeGreaterThan(0);
    expect(rect.top, `${name} top fits without scrolling`).toBeGreaterThanOrEqual(top - 1);
    expect(rect.bottom, `${name} bottom fits its panel and stays above footer: ${JSON.stringify(metrics)}`).toBeLessThanOrEqual(bottom + 1);
    expect(rect.left).toBeGreaterThanOrEqual(metrics.detail.left - 1);
    expect(rect.right).toBeLessThanOrEqual(metrics.detail.right + 1);
  }
  expect(metrics.outerScroll).toBe(0);
  expect(metrics.documentScroll).toBe(0);
  expect(metrics.outerOverflow, 'the outer details panel must not become another scroll container').toBeLessThanOrEqual(1);
  expect(metrics.textLines, `visible text lines: ${JSON.stringify(metrics)}`).toBeGreaterThanOrEqual(minimumLines - 0.05);
  return metrics;
}

async function expectButtonPalette(button: Locator, fill: string, foreground: string) {
  const colors = await button.evaluate((element, tokens) => {
    const root = getComputedStyle(document.documentElement);
    const rgb = (name: string) => {
      const hex = root.getPropertyValue(`--${name}`).trim();
      return `rgb(${[1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16)).join(', ')})`;
    };
    const style = getComputedStyle(element);
    return { actual: [style.backgroundColor, style.color], expected: tokens.map(rgb) };
  }, [fill, foreground]);
  expect(colors.actual).toEqual(colors.expected);
}

async function expectKeyboardOutline(button: Locator) {
  await expect(button).toBeFocused();
  const outline = await button.evaluate(element => {
    const style = getComputedStyle(element);
    return { visible: element.matches(':focus-visible'), width: parseFloat(style.outlineWidth), style: style.outlineStyle };
  });
  expect(outline.visible).toBe(true);
  expect(outline.width).toBeGreaterThanOrEqual(2);
  expect(outline.style).toBe('solid');
}

test('fits the complete log viewport before interaction and while toggling search', async ({ page }, testInfo) => {
  const t = words[language(testInfo)];
  await openFixture(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', String(testInfo.project.metadata.theme));
  await expect(page.locator('html')).toHaveAttribute('lang', language(testInfo));
  const content = page.locator('.log-content');
  await expect(page.getByRole('searchbox', { name: t.search, exact: true })).toBeHidden();
  const closed = await expectLogFits(page);
  await page.getByRole('button', { name: t.openSearch, exact: true }).click();
  const viewportHeight = page.viewportSize()!.height;
  const opened = await expectLogFits(page, viewportHeight >= 800 ? 10 : 6);
  expect(opened.content.height).toBeLessThan(closed.content.height);
  expect(Math.abs(opened.panel.bottom - closed.panel.bottom)).toBeLessThanOrEqual(1);
  await testInfo.attach('log-layout', { body: JSON.stringify({ closed, opened }), contentType: 'application/json' });
  if (viewportHeight === 1000) {
    await page.setViewportSize({ width: 1280, height: 800 });
    const smaller = await expectLogFits(page, 10);
    expect(opened.content.height).toBeGreaterThan(smaller.content.height + 20);
    await page.setViewportSize({ width: 1600, height: 1000 });
    await expectLogFits(page, 10);
  }
  await page.getByRole('button', { name: t.closeSearch, exact: true }).click();
  const restored = await expectLogFits(page);
  expect(restored.content.height).toBeCloseTo(closed.content.height, 0);
  await expectNoHorizontalOverflow(page);
  await expectReadableSmallText(page);
  await page.getByRole('button', { name: t.bottom, exact: true }).click();
  await visibleTextRange(content, 'LAST_LINE_300');
  await expectLogFits(page);
  await expect(page.getByRole('button', { name: t.settings, exact: true })).toBeInViewport();
  await expect(page.getByRole('button', { name: t.refresh, exact: true })).toBeInViewport();
  await page.getByRole('button', { name: t.expand, exact: true }).click();
  const modal = page.getByRole('dialog');
  await expect(modal.getByRole('button', { name: t.closeLogs })).toBeFocused();
  await modal.getByRole('button', { name: t.bottom, exact: true }).click();
  await visibleTextRange(modal.locator('.log-content'), 'LAST_LINE_300');
  await expectNoHorizontalOverflow(page);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: t.expand, exact: true })).toBeFocused();
  await expect(modal).toHaveCount(0);
  await expect(page.locator('.main-content')).not.toHaveAttribute('inert');
  await expectLogFits(page);
});

test('search moves the current text into the visible viewport and survives expansion', async ({ page }, testInfo) => {
  const t = words[language(testInfo)];
  await openFixture(page);
  const content = page.locator('.log-content');
  const original = await content.textContent();
  const search = page.getByRole('searchbox', { name: t.search, exact: true });
  await page.getByRole('button', { name: t.openSearch, exact: true }).click();
  await expect(search).toBeFocused();
  await search.fill('Request processed');
  await expect(page.locator('.log-search-count')).toHaveText(language(testInfo) === 'ko' ? '1 / 298건' : '1 / 298 matches');
  await expect(content.locator('.log-search-match')).toHaveText('Request processed');
  await page.getByRole('button', { name: t.next, exact: true }).click();
  await expect(page.locator('.log-search-count')).toHaveText(language(testInfo) === 'ko' ? '2 / 298건' : '2 / 298 matches');
  await expect(content.locator('.log-search-match')).toHaveCount(1);
  await visibleTextRange(content.locator('.log-search-match'), 'Request processed');
  await page.getByRole('button', { name: t.closeSearch, exact: true }).click();
  await expect(search).toBeHidden();
  await expect(content.locator('.log-search-match')).toHaveCount(0);
  await expectLogFits(page);
  await page.getByRole('button', { name: t.openSearch, exact: true }).click();
  await expect(search).toHaveValue('Request processed');
  await expect(search).toBeFocused();
  await expect(page.locator('.log-search-count')).toHaveText(language(testInfo) === 'ko' ? '2 / 298건' : '2 / 298 matches');
  await page.getByRole('button', { name: t.previous, exact: true }).click();
  await expect(page.locator('.log-search-count')).toHaveText(language(testInfo) === 'ko' ? '1 / 298건' : '1 / 298 matches');
  await visibleTextRange(content.locator('.log-search-match'), 'Request processed');
  await search.fill('LAST_LINE_300');
  await visibleTextRange(content.locator('.log-search-match'), 'LAST_LINE_300');
  expect(await content.textContent()).toBe(original);
  await page.getByRole('button', { name: t.expand, exact: true }).click();
  const modal = page.getByRole('dialog');
  await expect(modal.getByRole('searchbox', { name: t.search, exact: true })).toHaveValue('LAST_LINE_300');
  await visibleTextRange(modal.locator('.log-search-match'), 'LAST_LINE_300');
  expect(await modal.locator('.log-content').textContent()).toBe(original);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: t.expand, exact: true })).toBeFocused();
  await expect(search).toHaveValue('LAST_LINE_300');
  await expectLogFits(page);
  await search.fill('there-is-no-such-fixture-line');
  await expect(content.locator('.log-search-match')).toHaveCount(0);
  await expect(page.getByRole('button', { name: t.next, exact: true })).toBeDisabled();
  await page.getByRole('button', { name: t.clearSearch, exact: true }).click();
  await expect(search).toHaveValue('');
  expect(await content.textContent()).toBe(original);
  await page.keyboard.press('Escape');
  await expect(search).toBeHidden();
  await expect(page.getByRole('button', { name: t.openSearch, exact: true })).toBeFocused();
  await expectLogFits(page);
});

test('keeps completed result controls reachable and the result after another selection', async ({ page }, testInfo) => {
  const t = words[language(testInfo)];
  await openFixture(page);
  await page.getByRole('button', { name: t.restart, exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: t.confirmRestart, exact: true }).click();
  const result = page.getByRole('region', { name: t.result, exact: true });
  await expect(result).toContainText(backend);
  await expectLogFits(page);
  const show = result.getByRole('button', { name: t.showResult, exact: true });
  await expect(show).toHaveAttribute('aria-expanded', 'false');
  await show.click();
  await expect(result.getByRole('button', { name: t.hideResult, exact: true })).toHaveAttribute('aria-expanded', 'true');
  await expectLogFits(page);
  await result.getByText(t.executionDetails, { exact: true }).click();
  await expect(result.getByText('Synthetic command completed.', { exact: true })).toBeVisible();
  await expectLogFits(page);
  await page.getByRole('button', { name: t.openSearch, exact: true }).click();
  await expectLogFits(page);
  await page.getByRole('button', { name: t.closeSearch, exact: true }).click();
  await result.getByRole('button', { name: t.hideResult, exact: true }).click();
  await page.getByRole('button', { name: `${redis} ${t.details}`, exact: true }).click();
  await expect(result).toContainText(backend);
  await expect(show).toBeInViewport();
  await expectLogFits(page);
  await expectNoHorizontalOverflow(page);
  await page.getByRole('button', { name: t.bottom, exact: true }).click();
  await visibleTextRange(page.locator('.log-content'), 'LAST_LINE_300');
});

test('keeps an unknown result expanded while other details remain usable', async ({ page }, testInfo) => {
  const t = words[language(testInfo)];
  await openFixture(page, 'unknown-result');
  await page.getByRole('button', { name: t.restart, exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: t.confirmRestart, exact: true }).click();
  const result = page.getByRole('region', { name: t.result, exact: true });
  await expect(result.getByRole('heading')).toContainText(t.unknown);
  await expect(result.getByRole('button', { name: t.showResult, exact: true })).toHaveCount(0);
  await expect(result.getByRole('button', { name: t.hideResult, exact: true })).toHaveCount(0);
  await expectLogFits(page);
  await page.getByRole('button', { name: `${redis} ${t.details}`, exact: true }).click();
  await expect(result).toContainText(backend);
  await expectNoHorizontalOverflow(page);
  await expectLogFits(page);
});

test('opens log search with the platform shortcut and selects the retained query', async ({ page }, testInfo) => {
  const t = words[language(testInfo)];
  for (const [platform, shortcut] of [['MacIntel', 'Meta+f'], ['Win32', 'Control+f']] as const) {
    await openFixture(page, 'normal', platform);
    const input = page.getByRole('searchbox', { name: t.search, exact: true });
    await expect(input).toBeHidden();
    await expectLogFits(page);
    await page.keyboard.press(shortcut);
    await expect(input).toBeFocused();
    await input.fill('LAST_LINE_300');
    await page.keyboard.press('Escape');
    await expect(input).toBeHidden();
    await expectLogFits(page);
    await page.keyboard.press(shortcut);
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('LAST_LINE_300');
    expect(await input.evaluate(element => [(element as HTMLInputElement).selectionStart, (element as HTMLInputElement).selectionEnd])).toEqual([0, 13]);
    await page.keyboard.press(shortcut);
    await expect(input).toBeVisible();
    await visibleTextRange(page.locator('.log-search-match'), 'LAST_LINE_300');
    await expectLogFits(page);
  }
});

test('clears container search without resetting its filter or selecting a container', async ({ page }, testInfo) => {
  const t = words[language(testInfo)];
  await openFixture(page);
  const input = page.getByRole('textbox', { name: t.containerSearch, exact: true });
  const filter = page.locator('.filter-group').getByRole('button', { name: t.runningFilter, exact: true });
  await filter.click();
  await input.fill('no-matching-container');
  await expect(page.locator('.container-row')).toHaveCount(0);
  await page.getByRole('button', { name: t.clearContainerSearch, exact: true }).click();
  await expect(input).toHaveValue('');
  await expect(input).toBeFocused();
  await expect(filter).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.container-row')).toHaveCount(2);
  await expect(page.locator('.container-row[aria-current="true"]')).toHaveCount(0);
  await expect(page.locator('.log-content')).toHaveCount(0);
  await expect(page.getByRole('button', { name: t.clearContainerSearch, exact: true })).toHaveCount(0);
});

test('keeps logs inside the viewport with long metadata, diagnostics, and resized windows', async ({ page }, testInfo) => {
  const t = words[language(testInfo)];
  await openFixture(page, 'long-metadata');
  await expectLogFits(page);
  await expectNoHorizontalOverflow(page);
  await page.getByRole('button', { name: t.openSearch, exact: true }).click();
  await expectLogFits(page);
  await page.getByRole('button', { name: t.showDiagnostics, exact: true }).click();
  const diagnostics = await expectLogFits(page, 1);
  await testInfo.attach('diagnostics-log-layout', { body: JSON.stringify(diagnostics), contentType: 'application/json' });
  await expectNoHorizontalOverflow(page);
  await page.getByRole('button', { name: t.closeDiagnostics, exact: true }).click();
  await expectLogFits(page);
  const originalViewport = page.viewportSize()!;
  await page.setViewportSize(originalViewport.height === 680 ? { width: 1280, height: 800 } : { width: 1024, height: 680 });
  await expectLogFits(page);
  await expectNoHorizontalOverflow(page);
  await page.setViewportSize(originalViewport);
  await expectLogFits(page);
});

test('renders semantic action colors, neutral disabled and cancel states, and keyboard focus', async ({ page }, testInfo) => {
  const t = words[language(testInfo)];
  await openFixture(page);
  const controls = page.locator('.recovery-actions');
  const start = controls.getByRole('button', { name: t.start, exact: true });
  await expect(start).toBeDisabled();
  await expectButtonPalette(start, 'disabled-bg', 'disabled-text');
  for (const action of ['stop', 'restart'] as const) {
    const button = controls.getByRole('button', { name: t[action], exact: true });
    await page.mouse.move(0, 0);
    await expectButtonPalette(button, `${action}-action`, 'on-action');
    await button.hover();
    await expectButtonPalette(button, `${action}-action-hover`, 'on-action');
    await button.click();
    const dialog = page.getByRole('dialog');
    const cancel = dialog.getByRole('button', { name: t.cancel, exact: true });
    const confirm = dialog.getByRole('button', { name: action === 'stop' ? t.confirmStop : t.confirmRestart, exact: true });
    await page.mouse.move(0, 0);
    await expectButtonPalette(cancel, 'raised', 'text');
    await expectButtonPalette(confirm, `${action}-action`, 'on-action');
    await expect(cancel).toBeFocused();
    await page.keyboard.press('Tab');
    await expectKeyboardOutline(confirm);
    await page.keyboard.press('Shift+Tab');
    await expectKeyboardOutline(cancel);
    await page.keyboard.press('Escape');
    await expect(button).toBeFocused();
  }
  await page.getByRole('button', { name: `${redis} ${t.details}`, exact: true }).click();
  await page.mouse.move(0, 0);
  await expect(start).toBeEnabled();
  await expectButtonPalette(start, 'start-action', 'on-action');
  await start.hover();
  await expectButtonPalette(start, 'start-action-hover', 'on-action');
  for (const action of ['stop', 'restart'] as const) {
    const button = controls.getByRole('button', { name: t[action], exact: true });
    await expect(button).toBeDisabled();
    await expectButtonPalette(button, 'disabled-bg', 'disabled-text');
  }
  await page.getByRole('checkbox', { name: t.selectVisible, exact: true }).check();
  const bulk = page.locator('.bulk-actions');
  for (const action of ['start', 'stop', 'restart'] as const) {
    const button = bulk.getByRole('button', { name: `${t[action]} (${action === 'start' ? 1 : 2})`, exact: true });
    await expect(button).toBeEnabled();
    await page.mouse.move(0, 0);
    await expectButtonPalette(button, `${action}-action`, 'on-action');
    await button.hover();
    await expectButtonPalette(button, `${action}-action-hover`, 'on-action');
  }
  await page.getByRole('checkbox', { name: t.selectVisible, exact: true }).uncheck();
  await page.getByRole('checkbox', { name: language(testInfo) === 'ko' ? `${backend} 작업 대상으로 선택` : `Select ${backend} for an action`, exact: true }).check();
  const disabledBulkStart = bulk.getByRole('button', { name: `${t.start} (0)`, exact: true });
  await expect(disabledBulkStart).toBeDisabled();
  await disabledBulkStart.hover();
  await expectButtonPalette(disabledBulkStart, 'disabled-bg', 'disabled-text');
  await expectLogFits(page);
});

test('lets the keyboard reach and scroll long error details in expanded logs', async ({ page }, testInfo) => {
  const t = words[language(testInfo)];
  await openFixture(page, 'log-error');
  await page.getByRole('button', { name: t.expand, exact: true }).click();
  const modal = page.getByRole('dialog');
  const close = modal.getByRole('button', { name: t.closeLogs, exact: true });
  const summary = modal.locator('.technical-details summary');
  await expect(close).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(summary).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  const message = modal.locator('.technical-details pre').first();
  await expect(message).toBeFocused();
  await page.keyboard.press('End');
  await expect.poll(() => message.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await visibleTextRange(message, 'LAST_ERROR_LINE');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  const stderr = modal.locator('.technical-details pre').last();
  await expect(stderr).toBeFocused();
  await page.keyboard.press('End');
  await visibleTextRange(stderr, 'LAST_STDERR_LINE');
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: t.expand, exact: true })).toBeFocused();
});

test('uses the real Worker for every dense-log match while retaining raw copy and UI controls', async ({ page }, testInfo) => {
  const t = words[language(testInfo)];
  await page.addInitScript(() => {
    const observed = { messages: [] as { type?: string }[], copied: '' };
    Object.assign(window, { __searchObserved: observed });
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.addEventListener('message', event => observed.messages.push(event.data));
      }
    };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { observed.copied = text; } } });
  });
  await openFixture(page, 'dense-logs');
  const calls = () => page.evaluate(() => (window as unknown as { __docker2uFixtureCalls: Record<string, number> }).__docker2uFixtureCalls);
  const before = await calls();
  await expectLogFits(page);
  await page.getByRole('button', { name: t.openSearch, exact: true }).click();
  const search = page.getByRole('searchbox', { name: t.search, exact: true });
  const count = page.locator('.log-search-count');
  const content = page.locator('.log-content');
  const countText = (current: number) => language(testInfo) === 'ko' ? `${current} / 2097152건` : `${current} / 2097152 matches`;
  await search.fill('a');
  await expect(count).toHaveText(countText(1));
  expect(page.workers().some(worker => worker.url().includes('logSearch.worker'))).toBe(true);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __searchObserved: { messages: { type?: string }[] } }).__searchObserved.messages.some(message => message.type === 'result'))).toBe(true);
  await expect(content.locator('mark')).toHaveCount(1);
  await page.getByRole('button', { name: t.previous, exact: true }).click();
  await expect(count).toHaveText(countText(2097152));
  await visibleTextRange(content.locator('mark'), 'a');
  await page.getByRole('button', { name: language(testInfo) === 'ko' ? '표시된 로그 복사' : 'Copy displayed logs', exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { __searchObserved: { copied: string } }).__searchObserved.copied === 'a'.repeat(2 * 1024 * 1024))).toBe(true);
  await page.getByRole('button', { name: t.closeSearch, exact: true }).click();
  await expect(content.locator('mark')).toHaveCount(0);
  await page.getByRole('button', { name: t.openSearch, exact: true }).click();
  await expect(count).toHaveText(countText(2097152));
  await visibleTextRange(content.locator('mark'), 'a');
  // Replace and clear a real asynchronous query; its late result cannot restore highlighting.
  await search.fill('aa');
  await page.getByRole('button', { name: t.clearSearch, exact: true }).click();
  await expect(search).toHaveValue('');
  await expect(search).toBeFocused();
  await expect(count).toHaveText(language(testInfo) === 'ko' ? '0건' : '0 matches');
  await expect(content.locator('mark')).toHaveCount(0);
  await search.press('Escape');
  await expect(page.getByRole('button', { name: t.openSearch, exact: true })).toBeFocused();
  expect((await content.textContent())?.length).toBe(2 * 1024 * 1024);
  await expectLogFits(page);
  await expectNoHorizontalOverflow(page);
  expect(await calls()).toEqual(before);
});
