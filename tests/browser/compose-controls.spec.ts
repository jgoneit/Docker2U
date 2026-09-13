import { expect, test, type Page, type TestInfo } from '@playwright/test';

function labels(info: TestInfo) {
  const ko = info.project.metadata.language === 'ko';
  return ko ? {
    add: '프로젝트 추가', register: '프로젝트 등록', pick: 'Compose 파일 선택', file: 'Compose 파일', name: '프로젝트 이름', cwd: '작업 폴더', env: '환경 파일 · 선택 사항',
    review: '구성 확인', save: '등록', up: '프로젝트 실행', upReview: '프로젝트 실행 확인', run: '실행', stop: '프로젝트 중지', stopReview: '프로젝트 중지 확인', stopConfirm: '중지',
    progress: '프로젝트 작업', output: '실제 작업 출력', close: '닫기', recent: '최근 프로젝트 작업', done: '명령 실행 완료', unknown: '결과 확인 필요', cancel: '작업 취소 요청',
    noContainers: '아직 컨테이너가 없습니다', settings: '프로젝트 설정', forget: '등록 해제', forgetTitle: '프로젝트 등록 해제', link: '구성 연결',
  } : {
    add: 'Add project', register: 'Register project', pick: 'Choose Compose file', file: 'Compose file', name: 'Project name', cwd: 'Working directory', env: 'Environment file · optional',
    review: 'Review configuration', save: 'Register', up: 'Run project', upReview: 'Review project run', run: 'Run', stop: 'Stop project', stopReview: 'Review project stop', stopConfirm: 'Stop',
    progress: 'Project operation', output: 'Operation output', close: 'Close', recent: 'Recent project operation', done: 'Command completed', unknown: 'Result needs checking', cancel: 'Request cancellation',
    noContainers: 'No containers yet', settings: 'Project settings', forget: 'Remove registration', forgetTitle: 'Remove project registration', link: 'Link configuration',
  };
}
test.beforeEach(async ({ page }, info) => {
  await page.addInitScript(preferences => localStorage.setItem('docker2u.preferences.v1', JSON.stringify(preferences)), {
    theme: info.project.metadata.theme, language: info.project.metadata.language,
  });
});
async function open(page: Page, mode = 'success') {
  await page.goto(`/src/test/visual.html?toolbar=hidden&scenario=compose&composeMode=${mode}`);
  await expect(page.locator('.container-row')).toHaveCount(4);
}
async function register(page: Page, info: TestInfo, workingDirectory = '/synthetic/compose-demo') {
  const w = labels(info);
  await page.getByRole('button', { name: w.add, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: w.register, exact: true });
  await dialog.getByRole('button', { name: w.pick, exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: w.cwd, exact: true })).toHaveValue('/synthetic/compose-demo');
  await expect(dialog.getByRole('textbox', { name: w.name, exact: true })).toHaveValue('');
  if (workingDirectory !== '/synthetic/compose-demo') {
    await dialog.getByRole('textbox', { name: w.file, exact: true }).fill(`${workingDirectory}/compose.yaml`);
    await dialog.getByRole('textbox', { name: w.cwd, exact: true }).fill(workingDirectory);
  }
  await dialog.getByRole('button', { name: w.review, exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: w.name, exact: true })).toHaveValue('compose-demo');
  await expect(dialog.getByRole('textbox', { name: w.env, exact: true })).toHaveValue(`${workingDirectory}/.env`);
  await dialog.getByRole('button', { name: w.save, exact: true }).click();
  await expect(dialog).toBeHidden();
}
async function start(page: Page, info: TestInfo, stop = false) {
  const w = labels(info);
  await page.getByRole('button', { name: stop ? w.stop : w.up, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: stop ? w.stopReview : w.upReview, exact: true });
  await dialog.getByRole('button', { name: stop ? w.stopConfirm : w.run, exact: true }).click();
  await expect(page.getByRole('dialog', { name: w.progress, exact: true })).toBeVisible();
}
async function closeProgress(page: Page, info: TestInfo) {
  await page.getByRole('dialog', { name: labels(info).progress, exact: true }).getByRole('button', { name: labels(info).close, exact: true }).last().click();
}
async function calls(page: Page) {
  return page.evaluate(() => (window as unknown as { __docker2uComposeFixture: { calls: Record<string, number> } }).__docker2uComposeFixture.calls);
}

test('registers zero containers, runs in the same tree, reopens progress and stops without removal', async ({ page }, info) => {
  const w = labels(info);
  await open(page); await register(page, info);
  await expect(page.locator('.container-row')).toHaveCount(4);
  await expect(page.getByText(w.noContainers, { exact: true })).toBeVisible();
  await start(page, info);
  await expect(page.getByLabel(w.output, { exact: true })).toContainText('web Preparing');
  await closeProgress(page, info);
  await page.getByRole('button', { name: w.recent, exact: true }).click();
  const progress = page.getByRole('dialog', { name: w.progress, exact: true });
  await expect(progress.getByRole('status')).toContainText(w.done);
  await expect(progress.getByLabel(w.output, { exact: true })).toContainText('succeeded');
  await closeProgress(page, info);
  await expect(page.locator('.container-row')).toHaveCount(6);
  await expect(page.locator('.project-tree-name', { hasText: 'compose-demo' })).toHaveCount(1);
  await start(page, info, true);
  await expect(page.getByRole('dialog', { name: w.progress, exact: true }).getByRole('status')).toContainText(w.done);
  await closeProgress(page, info);
  await expect(page.locator('.container-row')).toHaveCount(6);
  expect((await calls(page)).start).toBe(2);
});

test('keeps a quiet operation alive when closed and cancels it explicitly', async ({ page }, info) => {
  const w = labels(info);
  await open(page, 'quiet'); await register(page, info); await start(page, info);
  await closeProgress(page, info);
  await expect(page.getByRole('button', { name: w.up, exact: true })).toBeDisabled();
  await page.getByRole('button', { name: w.recent, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: w.progress, exact: true });
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await dialog.getByRole('button', { name: w.cancel, exact: true }).click();
  await expect(dialog.getByRole('status').first()).toContainText(w.unknown);
  expect((await calls(page)).start).toBe(1);
  expect((await calls(page)).cancel).toBe(1);
});

test('keeps registration controls in the viewport and removes only empty registration metadata', async ({ page }, info) => {
  const w = labels(info);
  await open(page); await register(page, info);
  await page.getByRole('button', { name: `${w.settings} · compose-demo`, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: w.settings, exact: true });
  await expect(dialog).toBeVisible();
  const clipped = await dialog.evaluate(element => [...element.querySelectorAll('button')].filter(button => {
    const rect = button.getBoundingClientRect();
    return rect.width > 0 && (rect.top < 0 || rect.bottom > innerHeight + 1 || rect.left < 0 || rect.right > innerWidth + 1);
  }).map(button => button.textContent));
  expect(clipped).toEqual([]);
  await dialog.getByRole('button', { name: w.forget, exact: true }).click();
  await page.getByRole('dialog', { name: w.forgetTitle, exact: true }).getByRole('button', { name: w.forget, exact: true }).click();
  await expect(page.locator('.project-tree-name', { hasText: 'compose-demo' })).toHaveCount(0);
  await expect(page.locator('.container-row')).toHaveCount(4);
  expect((await calls(page)).start ?? 0).toBe(0);
});

test('linking an existing project preserves the row identity and frozen log search', async ({ page }, info) => {
  const w = labels(info), en = info.project.metadata.language === 'en';
  await open(page);
  const project = page.getByRole('treeitem', { name: en ? 'orders project' : 'orders 프로젝트', exact: true });
  await project.locator('.project-tree-name').click();
  const search = page.getByRole('searchbox', { name: en ? 'Search log text' : '로그 키워드 검색', exact: true });
  await search.fill('request=');
  await expect(page.locator('.project-log-row').first()).toContainText('request=');
  await page.getByRole('button', { name: en ? 'Pause view' : '화면 일시정지', exact: true }).click();
  const subscriptions = await page.evaluate(() => (window as unknown as { __docker2uObservationCalls: Record<string, number> }).__docker2uObservationCalls.configureLogs);
  await page.getByRole('button', { name: w.link, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: w.register, exact: true });
  await dialog.getByRole('button', { name: w.pick, exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: w.name, exact: true })).toHaveValue('orders');
  await dialog.getByRole('button', { name: w.review, exact: true }).click();
  await dialog.getByRole('button', { name: w.save, exact: true }).click();
  await expect(project).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.project-tree-name', { hasText: /^orders$/ })).toHaveCount(1);
  await expect(search).toHaveValue('request=');
  await expect(page.getByRole('button', { name: en ? 'Resume view' : '화면 재개', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => (window as unknown as { __docker2uObservationCalls: Record<string, number> }).__docker2uObservationCalls.configureLogs)).toBe(subscriptions);
  await expect(page.locator('.container-row')).toHaveCount(4);
});

for (const tab of ['logs', 'diagnostics'] as const) {
  test(`keeps a successful command separate from unhealthy services and navigates to ${tab} with focus`, async ({ page }, info) => {
    const w = labels(info), en = info.project.metadata.language === 'en';
    await page.goto('/src/test/visual.html?toolbar=hidden&scenario=compose&composeHealth=unhealthy');
    await expect(page.locator('.container-row')).toHaveCount(4);
    await register(page, info); await start(page, info);
    const dialog = page.getByRole('dialog', { name: w.progress, exact: true });
    await expect(dialog.getByRole('status')).toContainText(w.done);
    const web = dialog.locator('.compose-observed-containers > li').filter({ hasText: 'compose-demo-web-1' });
    await expect(web).toContainText(en ? 'Unhealthy' : '비정상');
    await expect(web).toContainText(en ? 'Running' : '실행 중');
    await expect(dialog).toContainText(en ? 'Command completion does not mean services are ready.' : '명령이 완료되어도 서비스 준비가 끝난 것은 아닙니다.');
    await expect(dialog.locator('.compose-observation-heading time')).toHaveAttribute('datetime', /\d{4}-\d{2}-\d{2}T/);
    await expect(dialog.locator('.compose-observed-containers > li').filter({ hasText: 'compose-demo-db-1' })).toContainText(en ? 'Health not configured' : 'Health 미설정');
    const inspect = tab === 'logs' ? en ? 'View logs for compose-demo-web-1' : 'compose-demo-web-1 로그 보기' : en ? 'View diagnostics for compose-demo-web-1' : 'compose-demo-web-1 진단 보기';
    await web.getByRole('button', { name: inspect, exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('.container-row').filter({ hasText: 'compose-demo-web-1' })).toHaveAttribute('aria-selected', 'true');
    const destination = page.locator(`[data-detail-tab="${tab}"]`);
    await expect(destination).toHaveAttribute('aria-selected', 'true');
    await expect(destination).toBeFocused();
    if (tab === 'logs') await expect(page.locator('.project-log-row').first()).toContainText('compose-demo-web-1');
    else {
      await expect(page.locator('.container-insights')).toHaveAttribute('aria-busy', 'false');
      await expect(page.locator('.container-insights .insights-error')).toHaveCount(0);
      await expect(page.locator('.container-insights .insights-body')).toBeVisible();
    }
    expect((await calls(page)).start).toBe(1);
    expect((await calls(page)).cancel ?? 0).toBe(0);
  });
}

test('shows an unstarted registered project without inventing storage observations', async ({ page }, info) => {
  const en = info.project.metadata.language === 'en';
  await open(page); await register(page, info);
  await page.getByRole('tab', { name: en ? 'Storage' : '저장소', exact: true }).click();
  const panel = page.getByRole('region', { name: en ? 'Storage mounts' : '저장소 연결', exact: true });
  await expect(panel).toContainText(en ? 'This project has no observed containers, so actual storage mounts are not available yet.' : '이 프로젝트의 실제 컨테이너가 없어 연결된 저장소를 확인할 수 없습니다.');
  await expect(panel.locator('.storage-mount')).toHaveCount(0);
  await expect(panel).not.toContainText(en ? 'Engine reported no mounts.' : 'Engine에서 보고한 마운트가 없습니다.');
  expect((await calls(page)).start ?? 0).toBe(0);
});

function applyLabels(info: TestInfo) {
  return info.project.metadata.language === 'ko' ? {
    apply: '변경 반영', select: '변경할 서비스 선택', review: '선택 내용 확인',
    confirm: '변경 반영 확인', run: '선택 서비스에 반영', stages: '단계별 명령 결과',
    web: 'web 선택', db: 'db 선택', webMode: 'web 이미지 준비', dbMode: 'db 이미지 준비',
    build: '이미지 빌드', absent: '현재 컨테이너 없음 · 새로 생성됩니다', unhealthy: '비정상',
    failed: '실패', skipped: '실행하지 않음',
  } : {
    apply: 'Apply changes', select: 'Select services to update', review: 'Review selection',
    confirm: 'Review changes', run: 'Apply to selected services', stages: 'Command results by stage',
    web: 'Select web', db: 'Select db', webMode: 'Image preparation for web', dbMode: 'Image preparation for db',
    build: 'Build image', absent: 'No current containers · will create new containers', unhealthy: 'Unhealthy',
    failed: 'Failed', skipped: 'Not executed',
  };
}
async function finishFixture(page: Page) {
  await page.evaluate(() => (window as unknown as { __docker2uComposeFixture: { finish(): void } }).__docker2uComposeFixture.finish());
}
async function chooseApply(page: Page, info: TestInfo, mixed: boolean) {
  const a = applyLabels(info);
  await page.getByRole('button', { name: a.apply, exact: true }).click();
  const select = page.getByRole('dialog', { name: a.select, exact: true });
  await expect(select.getByRole('checkbox', { name: a.web, exact: true })).not.toBeChecked();
  await expect(select.getByRole('button', { name: a.review, exact: true })).toBeDisabled();
  await select.getByRole('checkbox', { name: a.web, exact: true }).click();
  await page.keyboard.press('Tab');
  const webMode = select.getByRole('combobox', { name: a.webMode, exact: true });
  await expect(webMode).toBeFocused();
  await expect(webMode).toHaveCSS('appearance', 'none');
  expect((await webMode.boundingBox())!.height).toBeGreaterThanOrEqual(36);
  await expect(webMode.locator('..').locator('svg')).toBeVisible();
  await expect(select.getByRole('button', { name: a.review, exact: true })).toBeDisabled();
  await select.getByRole('combobox', { name: a.webMode, exact: true }).selectOption(mixed ? 'build' : 'none');
  if (mixed) {
    await select.getByRole('checkbox', { name: a.db, exact: true }).click();
    const db = select.getByRole('combobox', { name: a.dbMode, exact: true });
    // Disabled state matchers follow this option's surrounding label to its
    // enabled select. Inspect the native option property itself instead.
    await expect(db.getByRole('option', { name: a.build, exact: true })).toHaveJSProperty('disabled', true);
    await db.selectOption('pull');
  }
  await select.getByRole('button', { name: a.review, exact: true }).click();
  return page.getByRole('dialog', { name: a.confirm, exact: true });
}

test('keeps reviewed services and confirmation reachable with long Compose paths and keyboard focus', async ({ page }, info) => {
  const w = labels(info), a = applyLabels(info);
  await open(page);
  await register(page, info, `/synthetic/${'long-working-directory-'.repeat(8)}/compose-demo`);
  const review = await chooseApply(page, info, true);
  const services = review.locator('.compose-apply-review');
  await expect(services.locator(':scope > li')).toHaveCount(2);
  expect((await services.boundingBox())!.height).toBeGreaterThan(140);
  for (const service of await services.locator(':scope > li').all()) {
    await service.scrollIntoViewIfNeeded();
    await expect(service).toBeInViewport({ ratio: 0.95 });
  }
  const overflow = await review.evaluate(element => element.scrollWidth - element.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  const confirm = review.getByRole('button', { name: a.run, exact: true });
  await confirm.focus(); await page.keyboard.press('Tab');
  await expect(review.getByRole('button', { name: w.close, exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab'); await expect(confirm).toBeFocused();
  await expect(confirm).toBeInViewport();
  await info.attach('apply-review-long-path', { body: await page.screenshot(), contentType: 'image/png' });
  expect((await calls(page)).start ?? 0).toBe(0);
});

test('reviews explicit mixed preparation, keeps apply running when closed and separates unhealthy from command success', async ({ page }, info) => {
  const w = labels(info), a = applyLabels(info);
  await page.goto('/src/test/visual.html?toolbar=hidden&scenario=compose&composeMode=quiet&composeHealth=unhealthy');
  await register(page, info);
  const review = await chooseApply(page, info, true);
  await expect(review.getByText(a.absent, { exact: true })).toHaveCount(2);
  const bounds = await review.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(page.viewportSize()!.height + 1);
  expect((await calls(page)).start ?? 0).toBe(0);
  await review.getByRole('button', { name: a.run, exact: true }).click();
  await closeProgress(page, info);
  await expect(page.getByRole('button', { name: a.apply, exact: true })).toBeDisabled();
  await page.getByRole('button', { name: w.recent, exact: true }).click();
  await finishFixture(page);
  const progress = page.getByRole('dialog', { name: w.progress, exact: true });
  await expect(progress.locator('.compose-operation-heading [role="status"]')).toHaveText(w.done);
  const stages = progress.getByRole('region', { name: a.stages, exact: true });
  await expect(stages.locator('[data-stage-kind] .compose-succeeded')).toHaveCount(3);
  await expect(progress.locator('.compose-observed-containers > li')).toHaveCount(2);
  await expect(progress.locator('.compose-observed-containers > li').filter({ hasText: 'compose-demo-web-1' })).toContainText(a.unhealthy);
  expect((await calls(page)).start).toBe(1);
  expect((await calls(page)).recreate).toBe(1);
  expect((await calls(page)).cancel ?? 0).toBe(0);
});

test('recreates only the selected service with preparation skipped and focuses its exact new container', async ({ page }, info) => {
  const w = labels(info), a = applyLabels(info), en = info.project.metadata.language === 'en';
  await open(page); await register(page, info); await start(page, info); await finishFixture(page);
  let progress = page.getByRole('dialog', { name: w.progress, exact: true });
  await expect(progress.locator('.compose-operation-heading [role="status"]')).toHaveText(w.done);
  const oldWeb = await progress.locator('.compose-observed-containers > li').filter({ hasText: 'compose-demo-web-1' }).getAttribute('data-container-id');
  const oldDb = await progress.locator('.compose-observed-containers > li').filter({ hasText: 'compose-demo-db-1' }).getAttribute('data-container-id');
  await closeProgress(page, info);
  const review = await chooseApply(page, info, false);
  await expect(review.getByRole('button', { name: a.run, exact: true })).toBeEnabled();
  await expect(review.locator('.compose-apply-review > li')).toHaveCount(1);
  await expect(review.locator('.compose-apply-review')).toContainText('compose-demo-web-1');
  await expect(review.locator('.compose-apply-review')).not.toContainText('compose-demo-db-1');
  await review.getByRole('button', { name: a.run, exact: true }).click(); await finishFixture(page);
  progress = page.getByRole('dialog', { name: w.progress, exact: true });
  await expect(progress.locator('.compose-operation-heading [role="status"]')).toHaveText(w.done);
  await expect(progress.getByRole('region', { name: a.stages, exact: true }).locator('.compose-skipped')).toHaveCount(2);
  await expect(progress.locator('.compose-observed-containers > li')).toHaveCount(1);
  const web = progress.locator('.compose-observed-containers > li');
  await expect(web).not.toHaveAttribute('data-container-id', oldWeb!);
  const recent = progress.getByRole('navigation', { name: en ? 'Select a recent operation' : '최근 작업 선택', exact: true });
  await recent.scrollIntoViewIfNeeded();
  await expect(recent).toBeInViewport();
  for (const button of await recent.getByRole('button').all()) expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(28);
  await recent.getByRole('button').filter({ hasText: w.up }).click();
  await expect(progress.locator('.compose-observed-containers > li').filter({ hasText: 'compose-demo-db-1' })).toHaveAttribute('data-container-id', oldDb!);
  await progress.getByRole('button', { name: en ? 'View diagnostics for compose-demo-web-1' : 'compose-demo-web-1 진단 보기', exact: true }).click();
  await expect(progress).toBeHidden();
  await expect(page.locator('[data-detail-tab="diagnostics"]')).toBeFocused();
  await expect(page.locator('.container-row')).toHaveCount(6);
  expect((await calls(page)).recreate).toBe(1);
});

test('retains successful pull and failed build while leaving recreation unexecuted', async ({ page }, info) => {
  const w = labels(info), a = applyLabels(info);
  await page.goto('/src/test/visual.html?toolbar=hidden&scenario=compose&applyMode=build-failed');
  await register(page, info);
  const review = await chooseApply(page, info, true);
  await review.getByRole('button', { name: a.run, exact: true }).click(); await finishFixture(page);
  const progress = page.getByRole('dialog', { name: w.progress, exact: true });
  await expect(progress.locator('.compose-operation-heading [role="status"]')).toHaveText(a.failed);
  const stages = progress.getByRole('region', { name: a.stages, exact: true }).locator('li');
  await expect(stages.nth(0)).toContainText(w.done);
  await expect(stages.nth(1)).toContainText(a.failed);
  await expect(stages.nth(2)).toContainText(a.skipped);
  await closeProgress(page, info);
  await expect(page.locator('.container-row')).toHaveCount(4);
  expect((await calls(page)).recreate ?? 0).toBe(0);
  expect((await calls(page)).start).toBe(1);
});
