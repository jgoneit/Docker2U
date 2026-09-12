import { expect, test, type Page, type TestInfo } from '@playwright/test';

function labels(info: TestInfo) {
  const ko = info.project.metadata.language === 'ko';
  return ko ? {
    add: '프로젝트 추가', register: '프로젝트 등록', pick: 'Compose 파일 선택', name: '프로젝트 이름', cwd: '작업 폴더', env: '환경 파일 · 선택 사항',
    review: '구성 확인', save: '등록', up: '프로젝트 실행', upReview: '프로젝트 실행 확인', run: '실행', stop: '프로젝트 중지', stopReview: '프로젝트 중지 확인', stopConfirm: '중지',
    progress: '프로젝트 작업', output: '실제 작업 출력', close: '닫기', recent: '최근 프로젝트 작업', done: '완료', unknown: '결과 확인 필요', cancel: '작업 취소 요청',
    noContainers: '아직 컨테이너가 없습니다', settings: '프로젝트 설정', forget: '등록 해제', forgetTitle: '프로젝트 등록 해제', link: '구성 연결',
  } : {
    add: 'Add project', register: 'Register project', pick: 'Choose Compose file', name: 'Project name', cwd: 'Working directory', env: 'Environment file · optional',
    review: 'Review configuration', save: 'Register', up: 'Run project', upReview: 'Review project run', run: 'Run', stop: 'Stop project', stopReview: 'Review project stop', stopConfirm: 'Stop',
    progress: 'Project operation', output: 'Operation output', close: 'Close', recent: 'Recent project operation', done: 'Completed', unknown: 'Result needs checking', cancel: 'Request cancellation',
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
async function register(page: Page, info: TestInfo) {
  const w = labels(info);
  await page.getByRole('button', { name: w.add, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: w.register, exact: true });
  await dialog.getByRole('button', { name: w.pick, exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: w.cwd, exact: true })).toHaveValue('/synthetic/compose-demo');
  await expect(dialog.getByRole('textbox', { name: w.name, exact: true })).toHaveValue('');
  await dialog.getByRole('button', { name: w.review, exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: w.name, exact: true })).toHaveValue('compose-demo');
  await expect(dialog.getByRole('textbox', { name: w.env, exact: true })).toHaveValue('/synthetic/compose-demo/.env');
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
