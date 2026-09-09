import { beforeEach, expect, it } from 'vitest';
import { nativeCheckpoint, nativePaneSize, readyNativeInventory, readyNativeLogs } from './readiness';

const originalList = '2026-09-06T00:00:00.000Z';
const originalLogs = '2026-09-06T00:00:01.000Z';
const previous = { listCheckedAt: originalList, logsReceivedAt: originalLogs };
beforeEach(() => {
  document.body.innerHTML = `<time class="refresh-age" datetime="${originalList}"></time><section class="logs-panel"><button aria-label="로그 조회"><svg aria-hidden="true"></svg></button><span class="log-fetched-at"><time datetime="${originalLogs}"></time></span><pre class="log-content" aria-busy="false"></pre></section>`;
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

it('ignores a mounted log panel inside an inactive tab', () => {
  const panel = document.querySelector<HTMLElement>('.logs-panel')!;
  const tab = document.createElement('div'); panel.replaceWith(tab); tab.append(panel); tab.hidden = true;
  expect(readyNativeLogs(document)).toBeNull();
  tab.hidden = false;
  expect(readyNativeLogs(document)).not.toBeNull();
});


it('accepts bounded UTF-8 live content without requiring an ASCII-sized snapshot', () => {
  document.querySelector('pre')!.textContent = '한글 실시간 로그';
  expect(readyNativeLogs(document)).toBeNull();
  expect(readyNativeLogs(document, undefined, false)?.text).toBe('한글 실시간 로그');
  document.querySelector('pre')!.textContent = '한'.repeat(2 * 1024 * 1024);
  expect(readyNativeLogs(document, undefined, false)).toBeNull();
});

it('allows warning-preserving Refresh readiness without a new log receipt', () => {
  const app = document.createElement('div'); app.className = 'app-shell';
  app.innerHTML = '<button>새로고침</button>'; document.body.append(app);
  expect(readyNativeInventory(document, previous)).toBeNull();
  document.querySelector('time.refresh-age')!.setAttribute('datetime', '2026-09-06T00:00:02.000Z');
  expect(readyNativeInventory(document, previous)?.logsReceivedAt).toBe(originalLogs);
  app.querySelector('button')!.disabled = true;
  expect(readyNativeInventory(document, previous)).toBeNull();
});

it('reads the announced pane size only when it is within the controlled pane bounds', () => {
  document.body.insertAdjacentHTML('beforeend', '<button role="separator" aria-orientation="horizontal" aria-controls="inventory-pane detail-pane" aria-valuenow="260" aria-valuemin="220" aria-valuemax="430"></button>');
  expect(nativePaneSize(document)).toEqual({ height: 260, min: 220, max: 430 });
  const separator = document.querySelector('[role="separator"]')!;
  for (const height of ['219', '431', '', 'NaN']) {
    separator.setAttribute('aria-valuenow', height);
    expect(nativePaneSize(document)).toBeNull();
  }
  separator.removeAttribute('aria-valuenow');
  expect(nativePaneSize(document)).toBeNull();
});

it('does not accept a separator for another orientation or pane pair', () => {
  document.body.insertAdjacentHTML('beforeend', '<button role="separator" aria-orientation="vertical" aria-controls="inventory-pane detail-pane" aria-valuenow="260" aria-valuemin="220" aria-valuemax="430"></button>');
  const separator = document.querySelector('[role="separator"]')!;
  expect(nativePaneSize(document)).toBeNull();
  separator.setAttribute('aria-orientation', 'horizontal');
  separator.setAttribute('aria-controls', 'unrelated-pane');
  expect(nativePaneSize(document)).toBeNull();
});
