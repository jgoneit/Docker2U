export type NativeCheckpoint = { listCheckedAt: string | null; logsReceivedAt: string | null };
export type NativePaneSize = { height: number; min: number; max: number };

export function nativePaneSize(root: ParentNode): NativePaneSize | null {
  const separator = root.querySelector<HTMLElement>('[role="separator"][aria-orientation="horizontal"]');
  if (!separator || separator.getAttribute('aria-controls') !== 'inventory-pane detail-pane') return null;
  const attributes = ['aria-valuenow', 'aria-valuemin', 'aria-valuemax'].map(name => separator.getAttribute(name));
  if (attributes.some(value => value === null || value.trim() === '')) return null;
  const [height, min, max] = attributes.map(Number) as [number, number, number];
  return [height, min, max].every(Number.isFinite) && min >= 0 && min <= height && height <= max ? { height, min, max } : null;
}

function visiblePanel(root: ParentNode) {
  return Array.from(root.querySelectorAll<HTMLElement>('.logs-panel')).find(element => !element.closest('[hidden]'));
}

export function nativeCheckpoint(root: ParentNode): NativeCheckpoint {
  return {
    listCheckedAt: root.querySelector<HTMLTimeElement>('.refresh-age[datetime]')?.dateTime ?? null,
    logsReceivedAt: visiblePanel(root)?.querySelector<HTMLTimeElement>('.log-fetched-at time')?.dateTime ?? null,
  };
}
export function readyNativeInventory(root: ParentNode, previous?: NativeCheckpoint) {
  const checkpoint = nativeCheckpoint(root);
  const refresh = Array.from(root.querySelectorAll<HTMLButtonElement>('.app-shell button')).find(element => element.textContent?.trim() === '새로고침');
  return checkpoint.listCheckedAt && (!previous || checkpoint.listCheckedAt !== previous.listCheckedAt) && refresh && !refresh.disabled ? checkpoint : null;
}

// Refresh keeps an active stream pinned. Only explicit reconnect requires both
// a new inventory and a new log receipt; dense search separately requires 2MiB.
export function readyNativeLogs(root: ParentNode, previous?: NativeCheckpoint, dense = true) {
  const panel = visiblePanel(root);
  const content = panel?.querySelector<HTMLPreElement>('.log-content');
  const fetch = Array.from(panel?.querySelectorAll<HTMLButtonElement>('button') ?? []).find(element => element.getAttribute('aria-label') === '로그 조회' || element.textContent?.trim() === '로그 조회');
  const checkpoint = nativeCheckpoint(root);
  if (!checkpoint.listCheckedAt || !checkpoint.logsReceivedAt || !content || content.getAttribute('aria-busy') !== 'false' || !fetch || fetch.disabled) return null;
  if (previous && (checkpoint.listCheckedAt === previous.listCheckedAt || checkpoint.logsReceivedAt === previous.logsReceivedAt)) return null;
  const text = content.textContent ?? '';
  const bytes = new TextEncoder().encode(text).byteLength;
  return bytes > 0 && bytes <= 2 * 1024 * 1024 && (!dense || bytes === 2 * 1024 * 1024) ? { checkpoint, text } : null;
}
