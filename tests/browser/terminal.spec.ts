import { expect, test, type Page, type TestInfo } from '@playwright/test';

const backend = 'backend-주문처리-api-development';
const worker = 'worker-상태확인-required';
const words = (info: TestInfo) => info.project.metadata.language === 'en' ? {
  terminal: 'Terminal', logs: 'Logs', settings: 'Settings', history: 'History',
  current: 'Current terminal', back: 'Back to incident', project: 'orders project', minutes: '±5 min',
} : {
  terminal: '터미널', logs: '로그', settings: '설정', history: '이력',
  current: '현재 터미널', back: '사건으로 돌아가기', project: 'orders 프로젝트', minutes: '전후 5분',
};
const calls = (page: Page) => page.evaluate(() => structuredClone(
  (window as unknown as { __docker2uTerminalCalls: Record<string, number> }).__docker2uTerminalCalls,
));
const screen = (page: Page) => page.locator('.terminal-screen:visible');
const output = (page: Page) => screen(page).locator('.xterm-accessibility-tree');
async function command(page: Page, text: string) {
  const input = screen(page).locator('.xterm-helper-textarea');
  await input.focus();
  // Exercise the application's Unicode paste action instead of synthesizing
  // US-keyboard keypresses for Korean. Native IME composition is a separate check.
  if (/[^\x00-\x7f]/.test(text)) {
    const before = (await calls(page)).write ?? 0;
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.evaluate(value => navigator.clipboard.writeText(value), text);
    await page.locator('.container-terminal').getByRole('button', { name: /붙여넣기|Paste/, exact: true }).click();
    await expect.poll(async () => (await calls(page)).write ?? 0).toBeGreaterThan(before);
  } else await input.pressSequentially(text);
  await input.press('Enter');
}
async function select(page: Page, name: string) {
  await page.locator('.container-row').filter({ has: page.locator('.container-tree-name', { hasText: name }) }).click();
}

test.beforeEach(async ({ page }, info) => {
  await page.route('**/*', async route => {
    if (new URL(route.request().url()).origin !== 'http://127.0.0.1:1422') throw new Error('Terminal fixture must remain local.');
    await route.continue();
  });
  await page.addInitScript(preferences => localStorage.setItem('docker2u.preferences.v1', JSON.stringify(preferences)), {
    theme: info.project.metadata.theme, language: info.project.metadata.language,
  });
  await page.goto('/src/test/visual.html?toolbar=hidden&scenario=observation');
  await expect(page.locator('.container-row')).toHaveCount(4);
});

test('starts only on explicit connect and renders interactive Unicode with visible controls', async ({ page }, info) => {
  const w = words(info);
  await page.getByRole('tab', { name: w.terminal, exact: true }).click();
  expect((await calls(page)).start ?? 0).toBe(0);
  await expect(page.locator('.container-terminal')).toContainText('a'.repeat(64));
  const shell = page.getByRole('combobox', { name: info.project.metadata.language === 'en' ? 'Shell' : '셸', exact: true });
  const connect = page.locator('.terminal-connect');
  await expect(shell).toHaveValue('sh');
  await expect(shell).toHaveCSS('appearance', 'none');
  await expect(shell.locator('..').locator('svg')).toBeVisible();
  await shell.focus();
  await shell.press('Tab');
  await expect(connect).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(shell).toBeFocused();
  await shell.selectOption('bash');
  expect((await calls(page)).start ?? 0).toBe(0);
  await shell.selectOption('sh');
  for (const control of [shell, connect]) {
    await expect(control).toBeInViewport();
    const bounds = (await control.boundingBox())!;
    expect(bounds.height).toBeCloseTo(34, 0);
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  await info.attach('terminal-before-connect', { body: await page.screenshot(), contentType: 'image/png' });
  expect((await calls(page)).start ?? 0).toBe(0);
  await connect.click();
  await expect(screen(page).locator('.xterm')).toBeVisible();
  await command(page, 'echo D2U_TERMINAL_한글');
  await expect(output(page)).toContainText('D2U_TERMINAL_한글');
  await screen(page).locator('.xterm-helper-textarea').press('Control+c');
  await command(page, 'stty size');
  await expect.poll(async () => (await calls(page)).write ?? 0).toBeGreaterThan(0);
  const layout = await page.locator('.container-terminal').evaluate(node => {
    const bounds = node.getBoundingClientRect();
    return { overflow: document.documentElement.scrollWidth - innerWidth,
      controls: [...node.querySelectorAll('.terminal-toolbar button,.terminal-toolbar select')].filter(control => control.getBoundingClientRect().width > 0)
        .map(control => { const r = control.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; }),
      screenHeight: node.querySelector('.terminal-screen')?.getBoundingClientRect().height ?? 0,
      width: innerWidth, height: innerHeight, left: bounds.left, right: bounds.right };
  });
  expect(layout.overflow).toBeLessThanOrEqual(1);
  expect(layout.screenHeight).toBeGreaterThanOrEqual(80);
  for (const control of layout.controls) {
    expect(control.left).toBeGreaterThanOrEqual(0); expect(control.right).toBeLessThanOrEqual(layout.width + 1);
    expect(control.top).toBeGreaterThanOrEqual(0); expect(control.bottom).toBeLessThanOrEqual(layout.height + 1);
  }
  const retained = page.locator('.terminal-retained');
  await retained.locator('summary').scrollIntoViewIfNeeded();
  await retained.locator('summary').click();
  await retained.locator('button').last().scrollIntoViewIfNeeded();
  await expect(retained.locator('button').last()).toBeInViewport();
});

test('retains separate container terminals through navigation, theme and language changes', async ({ page }, info) => {
  const w = words(info);
  await page.getByRole('tab', { name: w.terminal, exact: true }).click();
  await page.locator('.terminal-connect').click();
  await command(page, 'echo D2U_TERMINAL_A');
  await expect(output(page)).toContainText('D2U_TERMINAL_A');
  await select(page, worker);
  await page.getByRole('tab', { name: w.terminal, exact: true }).click();
  await page.locator('.terminal-connect').click();
  await command(page, 'echo D2U_TERMINAL_C');
  await expect(output(page)).toContainText('D2U_TERMINAL_C');
  expect((await calls(page)).start).toBe(2);
  await select(page, backend);
  await expect(output(page)).toContainText('D2U_TERMINAL_A');
  await expect(output(page)).not.toContainText('D2U_TERMINAL_C');
  await page.getByRole('tab', { name: w.logs, exact: true }).click();
  await page.getByRole('tab', { name: w.terminal, exact: true }).click();
  await expect(output(page)).toContainText('D2U_TERMINAL_A');
  await page.getByRole('button', { name: w.settings, exact: true }).click();
  const theme = info.project.metadata.theme === 'light' ? 'dark' : 'light';
  await page.locator(`input[name="theme-preference"][value="${theme}"]`).check();
  await page.locator('#language-preference').selectOption(info.project.metadata.language === 'ko' ? 'en' : 'ko');
  await page.getByRole('dialog').press('Escape');
  await expect(output(page)).toContainText('D2U_TERMINAL_A');
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  expect((await calls(page)).start).toBe(2);
  await command(page, 'echo D2U_STILL_CONNECTED');
  await expect(output(page)).toContainText('D2U_STILL_CONNECTED');
});

test('visits terminal from an incident without executing and restores the event window and focus', async ({ page }, info) => {
  const w = words(info);
  await page.getByRole('treeitem', { name: w.project, exact: true }).locator('.project-tree-name').click();
  await page.getByRole('tab', { name: w.history, exact: true }).click();
  await page.locator('.history-event-trigger').first().click();
  await expect(page.locator('.incident-detail')).toBeVisible();
  await page.locator('.incident-detail').getByRole('button', { name: w.minutes, exact: true }).click();
  const sequence = await page.locator('.history-event-trigger[aria-expanded="true"]').getAttribute('data-event-sequence');
  await page.locator('.incident-detail').getByRole('button', { name: w.current, exact: true }).click();
  await expect(page.getByRole('tab', { name: w.terminal, exact: true })).toHaveAttribute('aria-selected', 'true');
  expect((await calls(page)).start ?? 0).toBe(0);
  await page.locator('.terminal-connect').click();
  await command(page, 'echo D2U_FROM_INCIDENT');
  await expect(output(page)).toContainText('D2U_FROM_INCIDENT');
  await page.getByRole('button', { name: w.back, exact: true }).click();
  await expect(page.locator('.incident-detail')).toBeVisible();
  await expect(page.locator('.incident-detail').getByRole('button', { name: w.minutes, exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator(`.history-event-trigger[data-event-sequence="${sequence}"]`)).toBeFocused();
  expect((await calls(page)).start).toBe(1);
});

test('blocks stopped containers and requires an explicit new shell after a missing shell or exit', async ({ page }, info) => {
  const w = words(info);
  await select(page, 'redis-캐시-stopped');
  await page.getByRole('tab', { name: w.terminal, exact: true }).click();
  await expect(page.locator('.terminal-connect')).toBeDisabled();
  expect((await calls(page)).start ?? 0).toBe(0);
  await select(page, worker);
  await page.getByRole('tab', { name: w.terminal, exact: true }).click();
  await page.locator('.terminal-toolbar select').selectOption('bash');
  await page.locator('.terminal-connect').click();
  await expect(page.locator('.terminal-status')).toHaveAttribute('data-status', 'failed');
  await expect(page.locator('.container-terminal [role="alert"]')).toBeVisible();
  expect((await calls(page)).start).toBe(1);
  await page.locator('.terminal-close').click();
  await page.locator('.terminal-toolbar select').selectOption('sh');
  await page.locator('.terminal-connect').click();
  await expect(page.locator('.terminal-status')).toHaveAttribute('data-status', 'running');
  await command(page, 'echo D2U_BEFORE_EXIT');
  await expect(output(page)).toContainText('D2U_BEFORE_EXIT');
  await command(page, 'exit');
  await expect(page.locator('.terminal-status')).toHaveAttribute('data-status', 'exited');
  await expect(output(page)).toContainText('D2U_BEFORE_EXIT');
  expect((await calls(page)).start).toBe(2);
  await page.locator('.terminal-close').click();
  await expect(page.locator('.terminal-connect')).toBeEnabled();
  await expect(screen(page)).toHaveCount(0);
});
