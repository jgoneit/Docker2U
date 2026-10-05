import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';

function labels(info: TestInfo) {
  return info.project.metadata.language === 'ko' ? {
    terminal: '터미널', shell: '셸', connections: '접속 정보', port: '내부 주소 복사에 사용할 포트',
    settings: '설정', language: '언어', close: '닫기', add: '프로젝트 추가', register: '프로젝트 등록',
    pick: 'Compose 파일 선택', review: '구성 확인', save: '등록', apply: '변경 반영',
    select: '변경할 서비스 선택', service: 'web 선택', preparation: 'web 이미지 준비',
    dbPreparation: 'db 이미지 준비', reviewSelection: '선택 내용 확인', cancel: '취소',
  } : {
    terminal: 'Terminal', shell: 'Shell', connections: 'Connections', port: 'Port for container-network addresses',
    settings: 'Settings', language: 'Language', close: 'Close', add: 'Add project', register: 'Register project',
    pick: 'Choose Compose file', review: 'Review configuration', save: 'Register', apply: 'Apply changes',
    select: 'Select services to update', service: 'Select web', preparation: 'Image preparation for web',
    dbPreparation: 'Image preparation for db', reviewSelection: 'Review selection', cancel: 'Cancel',
  };
}

test.beforeEach(async ({ page }, info) => {
  await page.route('**/*', async route => {
    if (new URL(route.request().url()).origin !== 'http://127.0.0.1:1422') throw new Error('Select fixture must remain local.');
    await route.continue();
  });
  await page.addInitScript(preferences => localStorage.setItem('docker2u.preferences.v1', JSON.stringify(preferences)), {
    theme: info.project.metadata.theme, language: info.project.metadata.language,
  });
});

// Check the visible browser control and keyboard focus here. Native macOS popup
// rendering and its key handling require the separate installed-app check.
async function inspectControl(page: Page, select: Locator, height: number) {
  const control = select.locator('..');
  await select.scrollIntoViewIfNeeded();
  await page.mouse.move(1, 1);
  await expect(select).toBeInViewport();
  expect(await select.evaluate(node => node instanceof HTMLSelectElement)).toBe(true);
  await expect(select).toHaveCSS('appearance', 'none');
  await expect(select).toHaveCSS('border-top-width', '0px');
  expect((await select.boundingBox())!.height).toBeCloseTo(height, 0);
  const arrow = control.locator('svg');
  await expect(arrow).toHaveCount(1);
  await expect(arrow).toBeVisible();
  await expect(arrow).toHaveAttribute('aria-hidden', 'true');
  await expect(arrow).toHaveCSS('pointer-events', 'none');
  const normal = await select.evaluate(node => {
    const wrapper = getComputedStyle(node.parentElement!);
    return { background: wrapper.backgroundColor, radius: wrapper.borderRadius, color: getComputedStyle(node).color,
      arrowColor: getComputedStyle(node.parentElement!.querySelector('svg')!).color };
  });
  await select.hover();
  const hover = await control.evaluate(node => getComputedStyle(node).backgroundColor);
  expect(hover).not.toBe(normal.background);
  await select.focus();
  await select.press('Tab');
  await expect(select).not.toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(select).toBeFocused();
  await expect(control).toHaveCSS('outline-style', 'solid');
  await expect(control).toHaveCSS('outline-width', '2px');
  expect(await control.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  return { normal, hover };
}

async function expectFocusRingInsideList(select: Locator) {
  await expect(select).toBeFocused();
  const geometry = await select.evaluate(node => {
    const list = node.closest<HTMLElement>('.compose-apply-services')!;
    const listBounds = list.getBoundingClientRect();
    const wrapper = node.parentElement!;
    const bounds = wrapper.getBoundingClientRect();
    const style = getComputedStyle(wrapper);
    const extent = parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset);
    // clientWidth excludes a classic scrollbar; the list's outer bounding box
    // would hide clipping when the final controls scroll into view.
    const clipLeft = listBounds.left + list.clientLeft;
    return { extent, left: bounds.left - extent, right: bounds.right + extent,
      clipLeft, clipRight: clipLeft + list.clientWidth, overflow: list.scrollWidth - list.clientWidth };
  });
  expect(geometry.extent).toBe(5);
  expect(geometry.left).toBeGreaterThanOrEqual(geometry.clipLeft - 0.5);
  expect(geometry.right).toBeLessThanOrEqual(geometry.clipRight + 0.5);
  expect(geometry.overflow).toBeLessThanOrEqual(1);
}

test('uses consistent native selects across terminal, ports, settings and Compose without changing actions', async ({ page }, info) => {
  const w = labels(info);
  await page.goto('/src/test/visual.html?toolbar=hidden&scenario=observation');
  await expect(page.locator('.container-row')).toHaveCount(4);
  await page.getByRole('tab', { name: w.terminal, exact: true }).click();
  const shell = page.getByRole('combobox', { name: w.shell, exact: true });
  const terminalStyle = await inspectControl(page, shell, 34);
  await shell.selectOption('bash');
  await expect(shell).toHaveValue('bash');
  expect(await page.evaluate(() => (window as unknown as { __docker2uTerminalCalls: Record<string, number> }).__docker2uTerminalCalls.start ?? 0)).toBe(0);

  await page.getByRole('tab', { name: w.connections, exact: true }).click();
  const port = page.getByRole('combobox', { name: w.port, exact: true });
  expect(await inspectControl(page, port, 34)).toEqual(terminalStyle);
  await port.selectOption('8081/udp');
  await expect(page.getByRole('button', { name: info.project.metadata.language === 'ko' ? '주소 복사: api:8081' : 'Copy address: api:8081', exact: true })).toBeVisible();

  const settingsTrigger = page.getByRole('button', { name: w.settings, exact: true });
  await settingsTrigger.click();
  const settings = page.getByRole('dialog', { name: w.settings, exact: true });
  const language = settings.getByRole('combobox', { name: w.language, exact: true });
  expect(await inspectControl(page, language, 40)).toEqual(terminalStyle);
  await expect(language).toHaveValue(info.project.metadata.language);
  await expect(language.locator('option[value="ko"]')).toHaveAttribute('lang', 'ko');
  await expect(language.locator('option[value="en"]')).toHaveAttribute('lang', 'en');
  await language.press('Tab');
  await expect(settings.getByRole('button', { name: w.close, exact: true }).last()).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(settings.getByRole('button', { name: w.close, exact: true }).first()).toBeFocused();
  await settings.press('Escape');
  await expect(settingsTrigger).toBeFocused();
  await expect(port).toHaveValue('8081/udp');
  await page.getByRole('tab', { name: w.terminal, exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { __docker2uTerminalCalls: Record<string, number> }).__docker2uTerminalCalls.start ?? 0)).toBe(0);

  await page.goto('/src/test/visual.html?toolbar=hidden&scenario=compose');
  await page.getByRole('button', { name: w.add, exact: true }).click();
  const registration = page.getByRole('dialog', { name: w.register, exact: true });
  await registration.getByRole('button', { name: w.pick, exact: true }).click();
  await registration.getByRole('button', { name: w.review, exact: true }).click();
  await registration.getByRole('button', { name: w.save, exact: true }).click();
  // Extend the existing synthetic response only in this browser test. Product
  // fixtures and transports remain unchanged, and no Compose command is run.
  await page.evaluate(async () => {
    const modulePath = '/src/composeApi.ts';
    const { composeApi } = await import(modulePath) as { composeApi: typeof import('../../src/composeApi').composeApi };
    const previewApply = composeApi.previewApply;
    composeApi.previewApply = async (...args) => {
      const preview = await previewApply(...args);
      return { ...preview, services: [...preview.services, ...Array.from({ length: 18 }, (_, index) => ({
        ...preview.services[0]!, name: `worker-${index + 1}-${'long-service-'.repeat(5)}`,
      }))] };
    };
  });
  await page.getByRole('button', { name: w.apply, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: w.select, exact: true });
  await expect(dialog.locator('.compose-apply-services > li')).toHaveCount(20);
  const preparation = dialog.getByRole('combobox', { name: w.preparation, exact: true });
  const review = dialog.getByRole('button', { name: w.reviewSelection, exact: true });
  await expect(preparation).toBeDisabled();
  await expect(review).toBeDisabled();
  await page.mouse.move(1, 1);
  const disabled = await preparation.locator('..').evaluate(node => getComputedStyle(node).backgroundColor);
  await preparation.hover();
  await expect(preparation.locator('..')).toHaveCSS('background-color', disabled);
  await dialog.getByRole('checkbox', { name: w.service, exact: true }).check();
  expect(await inspectControl(page, preparation, 40)).toEqual(terminalStyle);
  await expectFocusRingInsideList(preparation);
  await expect(preparation.locator('option[value=""]')).toHaveJSProperty('disabled', true);
  await expect(review).toBeDisabled();
  await preparation.selectOption('build');
  await expect(review).toBeEnabled();
  const db = dialog.getByRole('combobox', { name: w.dbPreparation, exact: true });
  await expect(db).toBeDisabled();
  await expect(db.locator('option[value="build"]')).toHaveJSProperty('disabled', true);
  const last = dialog.locator('.compose-apply-services > li').last();
  await last.getByRole('checkbox').check();
  const lastPreparation = last.getByRole('combobox');
  expect(await inspectControl(page, lastPreparation, 40)).toEqual(terminalStyle);
  await expectFocusRingInsideList(lastPreparation);
  await lastPreparation.selectOption('none');
  await expect(review).toBeEnabled();
  for (const control of [review, dialog.getByRole('button', { name: w.cancel, exact: true })]) {
    await control.focus();
    await expect(control).toBeInViewport();
  }
  expect(await dialog.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => (window as unknown as { __docker2uComposeFixture: { calls: Record<string, number> } }).__docker2uComposeFixture.calls.start ?? 0)).toBe(0);
  await info.attach('compose-select-controls', { body: await page.screenshot(), contentType: 'image/png' });
});
