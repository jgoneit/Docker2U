import { beforeEach, expect, it } from 'vitest';
import { nativeCheckpoint, readyNativeLogs } from './readiness';

const originalList = '2026-09-06T00:00:00.000Z';
const originalLogs = '2026-09-06T00:00:01.000Z';
const previous = { listCheckedAt: originalList, logsReceivedAt: originalLogs };
beforeEach(() => {
  document.body.innerHTML = `<time class="refresh-age" datetime="${originalList}"></time><section class="logs-panel"><button>로그 조회</button><span class="log-fetched-at"><time datetime="${originalLogs}"></time></span><pre class="log-content" aria-busy="false"></pre></section>`;
  document.querySelector('pre')!.textContent = 'a'.repeat(2 * 1024 * 1024);
});

it('waits without throwing while reconnect removes the previous log panel', () => {
  expect(nativeCheckpoint(document)).toEqual(previous);
  expect(readyNativeLogs(document)).not.toBeNull();
  document.querySelector('.logs-panel')!.remove();
  expect(readyNativeLogs(document, previous)).toBeNull();
});

it('requires both a new inventory and a new accepted log response', () => {
  expect(readyNativeLogs(document, previous)).toBeNull();
  document.querySelector('time.refresh-age')!.setAttribute('datetime', '2026-09-06T00:00:02.000Z');
  expect(readyNativeLogs(document, previous)).toBeNull();
  document.querySelector('.log-fetched-at time')!.setAttribute('datetime', '2026-09-06T00:00:03.000Z');
  expect(readyNativeLogs(document, previous)?.text.length).toBe(2 * 1024 * 1024);
});

it('waits for loading and the native request slot to settle with a complete body', () => {
  const pre = document.querySelector('pre')!;
  const fetch = document.querySelector('button')!;
  pre.setAttribute('aria-busy', 'true');
  expect(readyNativeLogs(document)).toBeNull();
  pre.setAttribute('aria-busy', 'false');
  fetch.disabled = true;
  expect(readyNativeLogs(document)).toBeNull();
  fetch.disabled = false;
  pre.textContent = 'still loading';
  expect(readyNativeLogs(document)).toBeNull();
});

it('ignores a hidden inline panel and waits for the visible panel to be ready', () => {
  document.querySelector<HTMLElement>('.logs-panel')!.hidden = true;
  expect(readyNativeLogs(document)).toBeNull();
});
