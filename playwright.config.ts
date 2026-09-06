import { defineConfig } from '@playwright/test';

const projects = (['light', 'dark'] as const).flatMap(theme =>
  (['ko', 'en'] as const).flatMap(language =>
    [{ width: 1024, height: 680 }, { width: 1280, height: 800 }].map(viewport => ({
      name: `${theme}-${language}-${viewport.width}x${viewport.height}`,
      metadata: { theme, language },
      use: { viewport, locale: language === 'ko' ? 'ko-KR' : 'en-US', colorScheme: theme },
    })),
  ),
);

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 2,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    browserName: 'chromium',
    baseURL: 'http://127.0.0.1:1422',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [...projects, {
    name: 'light-en-1600x1000',
    metadata: { theme: 'light', language: 'en' },
    use: { viewport: { width: 1600, height: 1000 }, locale: 'en-US', colorScheme: 'light' },
  }],
  webServer: {
    command: 'pnpm exec vite --host 127.0.0.1 --port 1422 --strictPort',
    url: 'http://127.0.0.1:1422/src/test/visual.html?toolbar=hidden',
    reuseExistingServer: false,
    timeout: 30_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
