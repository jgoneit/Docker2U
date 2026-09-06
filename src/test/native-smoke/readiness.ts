export type NativeCheckpoint = { listCheckedAt: string | null; logsReceivedAt: string | null };

function visiblePanel(root: ParentNode) {
  return Array.from(root.querySelectorAll<HTMLElement>('.logs-panel')).find(element => !element.hidden);
}

export function nativeCheckpoint(root: ParentNode): NativeCheckpoint {
  return {
    listCheckedAt: root.querySelector<HTMLTimeElement>('.refresh-age[datetime]')?.dateTime ?? null,
    logsReceivedAt: visiblePanel(root)?.querySelector<HTMLTimeElement>('.log-fetched-at time')?.dateTime ?? null,
  };
}

// A reconnect temporarily removes the panel. A refresh may briefly show the old
// body after its new inventory arrives and before the next logs effect starts.
export function readyNativeLogs(root: ParentNode, previous?: NativeCheckpoint) {
  const panel = visiblePanel(root);
  const content = panel?.querySelector<HTMLPreElement>('.log-content');
  const fetch = Array.from(panel?.querySelectorAll<HTMLButtonElement>('button') ?? []).find(element => element.textContent?.trim() === '로그 조회');
  const checkpoint = nativeCheckpoint(root);
  if (!checkpoint.listCheckedAt || !checkpoint.logsReceivedAt || !content || content.getAttribute('aria-busy') !== 'false' || !fetch || fetch.disabled) return null;
  if (previous && (checkpoint.listCheckedAt === previous.listCheckedAt || checkpoint.logsReceivedAt === previous.logsReceivedAt)) return null;
  const text = content.textContent ?? '';
  return text.length === 2 * 1024 * 1024 ? { checkpoint, text } : null;
}
