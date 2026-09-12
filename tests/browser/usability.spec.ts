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
    bottom: '최신 로그로', snapshotBottom: '맨 아래로', expand: '로그 확대 보기', closeLogs: '로그 확대 보기 닫기',
    showResult: '결과 펼치기', hideResult: '결과 접기', result: '최근 작업 결과',
    recentResult: '최근 작업 결과 상세 보기', closeResult: '최근 작업 결과 상세 닫기', dismissResult: '작업 알림 닫기',
    logsTab: '로그', diagnosticsTab: '상태 진단', connectionsTab: '접속 정보',
    unknown: '결과 불명', details: '상세',
    start: '시작', stop: '중지', confirmStop: '중지 확인', cancel: '취소', selectVisible: '보이는 컨테이너 전체 선택',
  },
  en: {
    settings: 'Settings', refresh: 'Refresh', restart: 'Restart', confirmRestart: 'Confirm Restart',
    search: 'Search logs', next: 'Next match', previous: 'Previous match', clearSearch: 'Clear log search',
    openSearch: 'Open log search', closeSearch: 'Close log search',
    containerSearch: 'Search containers', clearContainerSearch: 'Clear container search', runningFilter: 'Running',
    showDiagnostics: 'Show environment diagnostics', closeDiagnostics: 'Close diagnostics', executionDetails: 'Execution details',
    bottom: 'Latest logs', snapshotBottom: 'Scroll to bottom', expand: 'Expand logs', closeLogs: 'Close expanded logs',
    showResult: 'Show result details', hideResult: 'Hide result details', result: 'Latest operation result',
    recentResult: 'Show latest operation details', closeResult: 'Close recent operation details', dismissResult: 'Dismiss operation notification',
    logsTab: 'Logs', diagnosticsTab: 'Diagnostics', connectionsTab: 'Connections',
    unknown: 'Result unknown', details: 'details',
    start: 'Start', stop: 'Stop', confirmStop: 'Confirm Stop', cancel: 'Cancel', selectVisible: 'Select all visible containers',
  },
};
function language(testInfo: TestInfo) { return testInfo.project.metadata.language as keyof typeof words; }
// Periodic resource samples are independent of inventory age and log search.
// Keep every other API counter in these assertions to detect unintended reloads.
function nonSamplingCalls(calls: Record<string, number>) {
  return Object.fromEntries(Object.entries(calls).filter(([name]) => name !== 'getContainerStats'));
}

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

async function scrollToLatest(content: Locator, action: Locator) {
  await content.evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll', { bubbles: true })); });
  await action.click();
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
    regions: [...document.querySelectorAll('.app-shell, .workspace, .inventory-panel, .detail-panel, .logs-panel, .log-content, .logs-modal, .operation-result, .container-insights, .detail-toolbar, .insights-port-binding, .app-footer')]
      .filter(element => element.getBoundingClientRect().width > 0)
      .map(element => ({ name: element.className, amount: element.scrollWidth - element.clientWidth }))
      .filter(value => value.amount > 1),
  }));
  expect(overflow.document).toBeLessThanOrEqual(1);
  expect(overflow.regions).toEqual([]);
}

async function expectReadableSmallText(page: Page) {
  const undersized = await page.locator('.log-meta, .field-label, .app-footer, .health, .refresh-age, .confirm-blocked, .log-search label, .log-search-input, .log-search-count, .compact-actions button').evaluateAll(elements =>
    elements.filter(element => element.getBoundingClientRect().width > 0)
      .map(element => ({ name: element.className || element.tagName, size: parseFloat(getComputedStyle(element).fontSize) }))
      .filter(value => value.size < 12),
  );
  expect(undersized).toEqual([]);
}

async function fixtureCalls(page: Page) {
  return page.evaluate(() => structuredClone((window as unknown as { __docker2uFixtureCalls: Record<string, number> }).__docker2uFixtureCalls));
}

async function expectStatusbarFits(page: Page) {
  const layout = await page.locator('.app-footer').evaluate(element => {
    const bar = element.getBoundingClientRect();
    const controls = [...element.querySelectorAll('button')].map(button => button.getBoundingClientRect())
      .filter(rect => rect.width > 0).map(({ top, bottom, left, right }) => ({ top, bottom, left, right }));
    return { top: bar.top, bottom: bar.bottom, height: bar.height, left: bar.left, right: bar.right,
      viewportHeight: innerHeight, viewportWidth: innerWidth, overflow: element.scrollWidth - element.clientWidth, controls };
  });
  expect(layout.height).toBe(44);
  expect(layout.bottom).toBeLessThanOrEqual(layout.viewportHeight + 1);
  expect(layout.left).toBeGreaterThanOrEqual(0);
  expect(layout.right).toBeLessThanOrEqual(layout.viewportWidth + 1);
  expect(layout.overflow).toBeLessThanOrEqual(1);
  for (const control of layout.controls) {
    expect(control.top).toBeGreaterThanOrEqual(layout.top);
    expect(control.bottom).toBeLessThanOrEqual(layout.bottom);
    expect(control.left).toBeGreaterThanOrEqual(layout.left);
    expect(control.right).toBeLessThanOrEqual(layout.right);
  }
  return layout;
}

test('shows inventory age without selection and advances it without inventory or log reloads', async ({ page }, testInfo) => {
  const lang = language(testInfo);
  await page.clock.install({ time: new Date('2026-09-06T00:14:34Z') });
  await openFixture(page);
  const age = page.locator('.refresh-age');
  await expect(age).toContainText(lang === 'ko' ? '2분 전' : '2 minutes ago');
  await expect(age).toHaveAttribute('datetime', '2026-09-06T00:12:34.000Z');
  await expect(age).toHaveAttribute('title', /2026/);
  await expect(age).toBeInViewport();
  await expectLogFits(page);
  const readCalls = () => page.evaluate(() => structuredClone((window as unknown as { __docker2uFixtureCalls: Record<string, number> }).__docker2uFixtureCalls));
  const before = await readCalls();
  await page.clock.fastForward(120_000);
  await expect(age).toContainText(lang === 'ko' ? '4분 전' : '4 minutes ago');
  await page.getByRole('textbox', { name: words[lang].containerSearch, exact: true }).fill('no matching fixture');
  await expect(page.locator('.log-content')).toContainText('LAST_LINE_300');
  await expect(page.locator('.selection-hidden-notice')).toBeVisible();
  await expect(age).toBeVisible();
  expect(nonSamplingCalls(await readCalls())).toEqual(nonSamplingCalls(before));
  await expectNoHorizontalOverflow(page);
  await page.goto('/src/test/visual.html?toolbar=hidden&scenario=empty-inventory');
  await expect(page.locator('.container-row')).toHaveCount(0);
  await expect(age).toHaveAttribute('datetime', '2026-09-06T00:12:34.000Z');
  await expect(age).toBeInViewport();
});

test('explains and disables blocked single and bulk confirmations while retaining cancel focus', async ({ page }, testInfo) => {
  const lang = language(testInfo);
  const t = words[lang];
  for (const mode of ['single', 'bulk']) {
    await page.goto('/src/test/visual.html?toolbar=hidden&scenario=held-connection-error');
    await expect(page.locator('.container-row')).toHaveCount(4);
    await expect(page.locator('.log-content')).toHaveAttribute('aria-busy', 'true');
    await page.getByRole('button', { name: lang === 'ko' ? '로그 화면 비우기' : 'Clear displayed logs', exact: true }).click();
    if (mode === 'bulk') {
      await page.getByRole('checkbox', { name: t.selectVisible }).check();
      await page.locator('.bulk-actions').getByRole('button', { name: new RegExp(`^${t.stop}`) }).click();
    } else await page.locator('.recovery-panel').getByRole('button', { name: t.stop, exact: true }).click();
    const modal = page.getByRole('dialog');
    const confirm = modal.getByRole('button', { name: t.confirmStop, exact: true });
    await confirm.focus();
    await page.evaluate(() => (window as unknown as { __docker2uRejectLogs: () => void }).__docker2uRejectLogs());
    await expect(confirm).toBeDisabled();
    await expect(modal.getByRole('alert')).toContainText(lang === 'ko' ? '연결' : /[Rr]econnect/);
    await expect(modal.getByRole('button', { name: t.cancel, exact: true })).toBeFocused();
    await expect(modal.getByRole('button', { name: t.cancel, exact: true })).toBeInViewport();
    await expectNoHorizontalOverflow(page);
    if (mode === 'single') await page.keyboard.press('Escape');
    else await modal.getByRole('button', { name: t.cancel, exact: true }).click();
    await expect(modal).toHaveCount(0);
    await expect(page.getByRole('button', { name: lang === 'ko' ? '다시 연결' : 'Reconnect', exact: true })).toBeFocused();
    const calls = await page.evaluate(() => (window as unknown as { __docker2uFixtureCalls: Record<string, number> }).__docker2uFixtureCalls);
    expect(calls.mutateContainer).toBe(0);
    expect(calls.mutateContainers).toBe(0);
    expect(calls.getRecentLogs).toBe(0);
    expect(calls.startLogStream).toBe(1);
    expect(calls.readLogStream).toBe(0); // The held subscription failed before returning a stream.
    await expectLogFits(page);
  }
});

async function expectLogFits(page: Page, minimumLines = 0) {
  // A short pane can scroll its surrounding controls while retaining a usable log viewport.
  // Scroll the log into view without moving keyboard focus or altering the log's own scroll.
  await page.locator('.detail-panel .logs-panel:not([hidden]) .log-content').scrollIntoViewIfNeeded();
  const metrics = await page.evaluate(() => {
    const detail = document.querySelector<HTMLElement>('.detail-panel')!;
    const panel = detail.querySelector<HTMLElement>('.logs-panel:not([hidden])')!;
    const content = panel.querySelector<HTMLElement>('.log-content')!;
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
  expect(metrics.panel.height).toBeGreaterThan(0);
  expect(metrics.content.height, `log viewport retains its minimum height: ${JSON.stringify(metrics)}`).toBeGreaterThanOrEqual(80);
  expect(metrics.content.top, 'log viewport is reachable inside the detail pane').toBeGreaterThanOrEqual(Math.max(boundary.top, metrics.panel.top) - 1);
  expect(metrics.content.bottom, 'log viewport fits above the footer after pane scrolling').toBeLessThanOrEqual(Math.min(boundary.bottom, metrics.panel.bottom) + 1);
  for (const rect of [metrics.panel, metrics.content]) {
    expect(rect.left).toBeGreaterThanOrEqual(metrics.detail.left - 1);
    expect(rect.right).toBeLessThanOrEqual(metrics.detail.right + 1);
  }
  expect(metrics.documentScroll).toBe(0);
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
  const opened = await expectLogFits(page, 1);
  expect(opened.content.height).toBeLessThanOrEqual(closed.content.height);
  await testInfo.attach('log-layout', { body: JSON.stringify({ closed, opened }), contentType: 'application/json' });
  if (viewportHeight === 1000) {
    const separator = page.getByRole('separator');
    await expect(separator).toHaveAttribute('aria-orientation', 'vertical');
    const originalWidth = Number(await separator.getAttribute('aria-valuenow'));
    await page.setViewportSize({ width: 1280, height: 800 });
    await expectLogFits(page, 1);
    const smallerWidth = Number(await separator.getAttribute('aria-valuenow'));
    expect(smallerWidth).toBeLessThanOrEqual(originalWidth);
    expect(smallerWidth).toBeGreaterThanOrEqual(Number(await separator.getAttribute('aria-valuemin')));
    expect(smallerWidth).toBeLessThanOrEqual(Number(await separator.getAttribute('aria-valuemax')));
    await page.setViewportSize({ width: 1600, height: 1000 });
    await expectLogFits(page, 1);
  }
  await page.getByRole('button', { name: t.closeSearch, exact: true }).click();
  const restored = await expectLogFits(page);
  expect(restored.content.height).toBeCloseTo(closed.content.height, 0);
  await expectNoHorizontalOverflow(page);
  await expectReadableSmallText(page);
  await scrollToLatest(content, page.getByRole('button', { name: t.bottom, exact: true }));
  await visibleTextRange(content, 'LAST_LINE_300');
  await expectLogFits(page);
  await expect(page.getByRole('button', { name: t.settings, exact: true })).toBeInViewport();
  await expect(page.getByRole('button', { name: t.refresh, exact: true })).toBeInViewport();
  await page.getByRole('button', { name: t.expand, exact: true }).click();
  const modal = page.getByRole('dialog');
  await expect(modal.getByRole('button', { name: t.closeLogs })).toBeFocused();
  await scrollToLatest(modal.locator('.log-content'), modal.getByRole('button', { name: t.bottom, exact: true }));
  await visibleTextRange(modal.locator('.log-content'), 'LAST_LINE_300');
  await expectNoHorizontalOverflow(page);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: t.expand, exact: true })).toBeFocused();
  await expect(modal).toHaveCount(0);
  await expect(page.locator('.main-content')).not.toHaveAttribute('inert');
  await expectLogFits(page);
});

test('keeps status text after copy and clear glows fade without shifting logs, focus or reads', async ({ page }, testInfo) => {
  const lang = language(testInfo);
  const t = words[lang];
  await page.clock.install({ time: new Date('2026-09-06T00:14:34Z') });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => {} } });
  });
  await openFixture(page, 'live');
  // Load naturally, then freeze before actions: assertion runtime must not
  // consume the two-second deadline. Only explicit clock advances follow.
  await page.clock.pauseAt(new Date('2026-09-06T00:15:34Z'));
  await page.getByRole('button', { name: t.expand, exact: true }).click();
  const modal = page.getByRole('dialog');
  const content = modal.locator('.log-content');
  const originalNode = await content.elementHandle();
  const feedback = modal.locator('.log-copy-feedback');
  const footerFeedback = page.locator('.app-footer .clipboard-feedback');
  const copied = lang === 'ko' ? '표시된 로그 복사됨' : 'Displayed logs copied';
  const clearedMessage = lang === 'ko' ? '로그 화면을 비웠습니다.' : 'Displayed logs cleared.';
  async function expectFeedback(message: string, tone: 'success' | 'cleared', highlighted: boolean) {
    for (const surface of [feedback, footerFeedback]) {
      await expect(surface).toHaveText(message);
      await expect(surface).toHaveClass(new RegExp(`copy-feedback-${tone}`));
      await expect(surface.locator('.copy-feedback-glow')).toHaveCount(highlighted ? 1 : 0);
      if (highlighted) await expect(surface).toHaveClass(/copy-feedback-highlighted/);
      else await expect(surface).not.toHaveClass(/copy-feedback-highlighted/);
    }
  }
  const copy = modal.getByRole('button', { name: lang === 'ko' ? '표시된 로그 복사' : 'Copy displayed logs', exact: true });
  const close = modal.getByRole('button', { name: t.closeLogs, exact: true });
  const calls = () => page.evaluate(() => structuredClone((window as unknown as { __docker2uFixtureCalls: Record<string, number> }).__docker2uFixtureCalls));
  const metrics = () => content.evaluate(element => ({ width: element.clientWidth, height: element.clientHeight, scrollTop: element.scrollTop, text: element.textContent }));
  await modal.locator('.log-pause-toggle').click();
  await expect(modal.locator('.log-pause-toggle')).toHaveAttribute('aria-pressed', 'true');
  await content.evaluate(element => { element.scrollTop = 145; element.dispatchEvent(new Event('scroll', { bubbles: true })); });
  const before = await metrics();
  expect(before.scrollTop).toBeGreaterThan(0);
  const receivedAt = await modal.locator('.log-fetched-at time').getAttribute('datetime');
  const beforeCalls = await calls();

  await copy.click();
  await expectFeedback(copied, 'success', true);
  const firstGlow = await feedback.locator('.copy-feedback-glow').elementHandle();
  const blueGlow = await feedback.locator('.copy-feedback-glow').evaluate(element => getComputedStyle(element).backgroundImage);
  expect(blueGlow).toContain('linear-gradient');
  await expect(feedback.locator('.copy-feedback-glow')).toHaveCSS('animation-duration', '2s');
  expect(await metrics()).toEqual(before);
  await expect(copy).toBeFocused();
  // A repeated action restarts the glow; its predecessor's deadline must not
  // remove the new emphasis. The last status message remains after either one.
  await page.clock.fastForward(1_000);
  await copy.click();
  await expectFeedback(copied, 'success', true);
  expect(await feedback.locator('.copy-feedback-glow').evaluate((element, original) => element === original, firstGlow)).toBe(false);
  await page.clock.fastForward(1_500);
  await expectFeedback(copied, 'success', true);
  await page.clock.fastForward(1_000);
  await expectFeedback(copied, 'success', false);
  expect(await metrics()).toEqual(before);
  await expect(copy).toBeFocused();
  await expect(modal.locator('.log-fetched-at time')).toHaveAttribute('datetime', receivedAt!);
  const afterCopyCalls = await calls();
  expect(afterCopyCalls.startLogStream).toBe(beforeCalls.startLogStream);
  expect(afterCopyCalls.stopLogStream).toBe(beforeCalls.stopLogStream);
  expect(afterCopyCalls.readLogStream).toBeGreaterThan(beforeCalls.readLogStream!);

  await modal.getByRole('button', { name: lang === 'ko' ? '로그 화면 비우기' : 'Clear displayed logs', exact: true }).click();
  await expectFeedback(clearedMessage, 'cleared', true);
  const redGlow = await feedback.locator('.copy-feedback-glow').evaluate(element => getComputedStyle(element).backgroundImage);
  expect(redGlow).toContain('linear-gradient');
  expect(redGlow).not.toBe(blueGlow);
  await expect(content).not.toContainText('LAST_LINE_300');
  await expect(copy).toBeDisabled();
  await expect(close).toBeFocused();
  const cleared = await metrics();
  const clearedCalls = await calls();
  expect(clearedCalls.stopLogStream).toBe(beforeCalls.stopLogStream! + 1);
  await page.clock.fastForward(2_500);
  await expectFeedback(clearedMessage, 'cleared', false);
  expect(await metrics()).toEqual(cleared);
  await expect(close).toBeFocused();
  expect(nonSamplingCalls(await calls())).toEqual(nonSamplingCalls(clearedCalls));
  expect(await content.evaluate((element, original) => element === original, originalNode)).toBe(true);
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

test('opens completed results from the statusbar and retains their target after another selection', async ({ page }, testInfo) => {
  const t = words[language(testInfo)];
  await openFixture(page);
  await page.getByRole('button', { name: t.restart, exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: t.confirmRestart, exact: true }).click();
  const result = page.getByRole('region', { name: t.result, exact: true });
  const recent = page.locator('.app-footer').getByRole('button', { name: t.recentResult, exact: true });
  await expect(recent).toBeInViewport();
  await expect(result).toHaveCount(0);
  await expectStatusbarFits(page);
  await recent.click();
  await expect(result).toContainText(backend);
  await expect(recent).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('button', { name: t.closeResult, exact: true })).toBeFocused();
  await expect(result.getByRole('button', { name: t.showResult, exact: true })).toHaveCount(0);
  await expectLogFits(page);
  await result.getByText(t.executionDetails, { exact: true }).click();
  await expect(result.getByText('Synthetic command completed.', { exact: true })).toBeVisible();
  await expectLogFits(page);
  await page.getByRole('button', { name: t.openSearch, exact: true }).click();
  await expectLogFits(page);
  await page.getByRole('button', { name: t.closeSearch, exact: true }).click();
  await page.getByRole('button', { name: t.closeResult, exact: true }).click();
  await expect(result).toHaveCount(0);
  await expect(recent).toBeFocused();
  await page.getByRole('treeitem', { name: `${redis} ${t.details}`, exact: true }).click();
  await recent.click();
  await expect(result).toContainText(backend);
  await expect(recent).toBeInViewport();
  await expectStatusbarFits(page);
  await expectLogFits(page);
  await expectNoHorizontalOverflow(page);
  await scrollToLatest(page.locator('.log-content'), page.getByRole('button', { name: t.snapshotBottom, exact: true }));
  await visibleTextRange(page.locator('.log-content'), 'LAST_LINE_300');
});

test('allows unknown notices and result details to close independently while retaining their original outcome', async ({ page }, testInfo) => {
  const t = words[language(testInfo)];
  await openFixture(page, 'unknown-result');
  await page.getByRole('button', { name: t.restart, exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: t.confirmRestart, exact: true }).click();
  const result = page.getByRole('region', { name: t.result, exact: true });
  const recent = page.locator('.app-footer').getByRole('button', { name: t.recentResult, exact: true });
  const notice = page.locator('.app-footer .operation-feedback-message');
  await expect(notice).toContainText(t.unknown);
  await expect(result).toHaveCount(0);
  await recent.click();
  await expect(result.getByRole('heading')).toContainText(t.unknown);
  await expect(result.getByRole('button', { name: t.showResult, exact: true })).toHaveCount(0);
  await expect(result.getByRole('button', { name: t.hideResult, exact: true })).toHaveCount(0);
  await expectLogFits(page);
  await page.getByRole('treeitem', { name: `${redis} ${t.details}`, exact: true }).click();
  await expect(result).toContainText(backend);
  await page.getByRole('button', { name: t.closeResult, exact: true }).click();
  await expect(result).toHaveCount(0);
  await expect(notice).toContainText(t.unknown);
  await page.locator('.app-footer').getByRole('button', { name: t.dismissResult, exact: true }).click();
  await expect(notice).toBeEmpty();
  await expect(recent).toBeFocused();
  await expectStatusbarFits(page);
  await recent.click();
  await expect(result.getByRole('heading')).toContainText(t.unknown);
  await expect(result).toContainText(backend);
  await expectNoHorizontalOverflow(page);
  await expectLogFits(page);
});

test('uses manual keyboard tabs while preserving a paused live log search and its scroll position', async ({ page }, testInfo) => {
  const lang = language(testInfo), t = words[lang];
  await openFixture(page, 'live', 'MacIntel');
  await expect(page.locator('.log-content')).toContainText('LIVE 2');
  await page.locator('.log-pause-toggle').click();
  await page.getByRole('button', { name: t.openSearch, exact: true }).click();
  const search = page.getByRole('searchbox', { name: t.search, exact: true });
  await search.fill('Request processed');
  await page.getByRole('button', { name: t.next, exact: true }).click();
  const content = page.locator('.log-content');
  await content.evaluate(element => { element.scrollTop = 145; element.dispatchEvent(new Event('scroll', { bubbles: true })); });
  const original = await content.elementHandle();
  const before = await content.evaluate(element => ({ text: element.textContent, scrollTop: element.scrollTop }));
  const callsBefore = await fixtureCalls(page);
  expect(callsBefore.getContainerDetails).toBe(0);
  const logsTab = page.getByRole('tab', { name: t.logsTab, exact: true });
  const diagnosticsTab = page.getByRole('tab', { name: t.diagnosticsTab, exact: true });
  const connectionsTab = page.getByRole('tab', { name: t.connectionsTab, exact: true });
  await logsTab.focus();
  await page.keyboard.press('ArrowRight');
  await expect(diagnosticsTab).toBeFocused();
  await expect(diagnosticsTab).toHaveAttribute('aria-selected', 'false');
  expect((await fixtureCalls(page)).getContainerDetails).toBe(0);
  await page.keyboard.press('Enter');
  const diagnostics = page.getByRole('tabpanel', { name: t.diagnosticsTab, exact: true });
  await expect(diagnostics.locator('.insights-summary')).toContainText(lang === 'ko' ? '관측된 상태' : 'Observed state');
  await expect(content).toBeHidden();
  await expect.poll(async () => (await fixtureCalls(page)).getContainerDetails).toBe(1);
  const toolbar = await page.locator('.detail-toolbar').evaluate(element => {
    const tabs = element.querySelector('[role="tablist"]')!.getBoundingClientRect();
    const actions = element.querySelector('.recovery-actions')!.getBoundingClientRect();
    return { tabTop: tabs.top, tabBottom: tabs.bottom, actionTop: actions.top, actionBottom: actions.bottom };
  });
  expect(Math.max(toolbar.tabTop, toolbar.actionTop)).toBeLessThan(Math.min(toolbar.tabBottom, toolbar.actionBottom));
  await expectStatusbarFits(page);
  await diagnosticsTab.focus();
  await page.keyboard.press('End');
  const historyTab = page.getByRole('tab', { name: lang === 'ko' ? '이력' : 'History', exact: true });
  await expect(historyTab).toBeFocused();
  await expect(historyTab).toHaveAttribute('aria-selected', 'false');
  await page.keyboard.press('ArrowLeft');
  await expect(connectionsTab).toBeFocused();
  await expect(connectionsTab).toHaveAttribute('aria-selected', 'false');
  await page.keyboard.press('Space');
  await expect(connectionsTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel', { name: t.connectionsTab, exact: true }).locator('.insights-port-list > li')).toHaveCount(2);
  await page.keyboard.press('Meta+f');
  await expect(search).toBeHidden();
  await expect(connectionsTab).toBeFocused();
  await expect.poll(async () => (await fixtureCalls(page)).readLogStream).toBeGreaterThan(callsBefore.readLogStream! + 2);
  await page.keyboard.press('Home');
  await expect(logsTab).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(logsTab).toHaveAttribute('aria-selected', 'true');
  await expect(search).toHaveValue('Request processed');
  await expect(page.locator('.log-search-count')).toHaveText(lang === 'ko' ? '2 / 298건' : '2 / 298 matches');
  await expect(page.locator('.log-pause-toggle')).toHaveAttribute('aria-pressed', 'true');
  expect(await content.evaluate((element, node) => element === node, original)).toBe(true);
  await expect.poll(() => content.evaluate(element => ({ text: element.textContent, scrollTop: element.scrollTop }))).toEqual(before);
  const after = await fixtureCalls(page);
  expect(after.getContainerDetails).toBe(1);
  for (const name of ['getEnvironment', 'listContainers', 'startLogStream', 'stopLogStream', 'mutateContainer', 'mutateContainers']) expect(after[name]).toBe(callsBefore[name]);
  await expectNoHorizontalOverflow(page);
  await expectLogFits(page);
  await testInfo.attach('detail-tabs-preserved-logs', { body: await page.screenshot(), contentType: 'image/png' });
});

test('keeps long IPv6 bindings and the final published port copy reachable in the detail pane', async ({ page }, testInfo) => {
  const lang = language(testInfo), t = words[lang];
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { (window as unknown as { __copiedInsight: string }).__copiedInsight = text; } } });
  });
  await openFixture(page, 'long-metadata');
  const callsBefore = await fixtureCalls(page);
  const selected = page.locator('.container-list-item[data-selected="true"]');
  await selected.locator('.container-connection-link').click();
  await expect(page.getByRole('tab', { name: t.connectionsTab, exact: true })).toHaveAttribute('aria-selected', 'true');
  const panel = page.getByRole('tabpanel', { name: t.connectionsTab, exact: true });
  await expect(panel.locator('.insights-port-list > li')).toHaveCount(24);
  const address = '[2001:db8:1234:5678:9abc:def0:1234:5678]:18081';
  const copyName = (value: string) => lang === 'ko' ? `주소 복사: ${value}` : `Copy address: ${value}`;
  const ipv6 = panel.getByRole('button', { name: copyName(address), exact: true });
  await ipv6.scrollIntoViewIfNeeded();
  await expect(ipv6).toBeInViewport();
  await ipv6.click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __copiedInsight: string }).__copiedInsight)).toBe(address);
  await expectNoHorizontalOverflow(page);
  const last = panel.locator('.insights-port-list > li').last();
  await expect(last.locator('strong')).toHaveText('8103/TCP');
  const lastCopy = last.getByRole('button', { name: copyName('127.0.0.1:18103'), exact: true });
  await lastCopy.scrollIntoViewIfNeeded();
  await expect(lastCopy).toBeInViewport();
  await lastCopy.click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __copiedInsight: string }).__copiedInsight)).toBe('127.0.0.1:18103');
  await expect(page.locator('.app-footer .clipboard-feedback')).toHaveText(lang === 'ko' ? '접속 주소 복사됨' : 'Connection address copied');
  await expect(panel.locator('.insights-hint').filter({ hasText: lang === 'ko' ? 'Mac의 포트 포워딩과 실제 연결은 확인하지 않았습니다.' : 'Mac port forwarding and actual connectivity have not been verified.' })).toHaveCount(1);
  const portChoice = panel.getByRole('combobox', { name: lang === 'ko' ? '내부 주소 복사에 사용할 포트' : 'Port for container-network addresses' });
  await portChoice.selectOption('8080/tcp');
  const aliasCopy = panel.getByRole('button', { name: copyName('api:8080'), exact: true });
  await aliasCopy.scrollIntoViewIfNeeded();
  await expect(aliasCopy).toBeInViewport();
  await aliasCopy.click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __copiedInsight: string }).__copiedInsight)).toBe('api:8080');
  await expect(page.locator('.container-checkbox:checked')).toHaveCount(0);
  const after = await fixtureCalls(page);
  expect(after.getContainerDetails).toBe(1);
  for (const name of ['getEnvironment', 'listContainers', 'mutateContainer', 'mutateContainers']) expect(after[name]).toBe(callsBefore[name]);
  await expectStatusbarFits(page);
  await expectNoHorizontalOverflow(page);
  await testInfo.attach('connection-long-bindings', { body: await page.screenshot(), contentType: 'image/png' });
});

test('hides successful operation text after five seconds without moving the statusbar or replacing copy feedback', async ({ page }, testInfo) => {
  const lang = language(testInfo), t = words[lang];
  await page.clock.install({ time: new Date('2026-09-08T00:00:00Z') });
  await page.addInitScript(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => {} } }); });
  await openFixture(page);
  await page.clock.pauseAt(new Date('2026-09-08T00:01:00Z'));
  await page.getByRole('button', { name: t.restart, exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: t.confirmRestart, exact: true }).click();
  const notice = page.locator('.app-footer .operation-feedback-message');
  await expect(notice).toContainText(lang === 'ko' ? '성공' : 'Succeeded');
  const before = await expectStatusbarFits(page);
  await expect(page.getByRole('region', { name: t.result, exact: true })).toHaveCount(0);
  await page.getByRole('tab', { name: t.connectionsTab, exact: true }).click();
  await page.getByRole('button', { name: lang === 'ko' ? '주소 복사: 127.0.0.1:18080' : 'Copy address: 127.0.0.1:18080', exact: true }).click();
  const copied = lang === 'ko' ? '접속 주소 복사됨' : 'Connection address copied';
  await expect(page.locator('.app-footer .clipboard-feedback')).toHaveText(copied);
  await expect(notice).toContainText(lang === 'ko' ? '성공' : 'Succeeded');
  const recent = page.locator('.app-footer').getByRole('button', { name: t.recentResult, exact: true });
  await recent.focus();
  await page.clock.fastForward(4_999);
  await expect(notice).toContainText(lang === 'ko' ? '성공' : 'Succeeded');
  await page.clock.fastForward(1);
  await expect(notice).toBeEmpty();
  await expect(recent).toBeFocused();
  await expect(recent).toBeInViewport();
  await expect(page.locator('.app-footer .clipboard-feedback')).toHaveText(copied);
  const after = await expectStatusbarFits(page);
  expect({ top: after.top, bottom: after.bottom, height: after.height }).toEqual({ top: before.top, bottom: before.bottom, height: before.height });
  await recent.press('Enter');
  await expect(page.getByRole('region', { name: t.result, exact: true })).toContainText(backend);
  await expectNoHorizontalOverflow(page);
  await testInfo.attach('operation-statusbar-after-expiry', { body: await page.screenshot(), contentType: 'image/png' });
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

test('clears container search while retaining its filter and selected detail', async ({ page }, testInfo) => {
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
  await expect(page.getByRole('treeitem', { name: `${backend} ${t.details}`, exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.log-content')).toContainText('LAST_LINE_300');
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
  await page.getByRole('treeitem', { name: `${redis} ${t.details}`, exact: true }).click();
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
  const content = modal.locator('.log-content');
  await expect(close).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(content).toBeFocused();
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
  await expect(content).toBeFocused();
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
  expect(nonSamplingCalls(await calls())).toEqual(nonSamplingCalls(before));
});
