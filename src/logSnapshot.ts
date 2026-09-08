import type { RecentLogs } from './api';

/** Native snapshot fields plus bounded live receipt metadata. */
export type LogSnapshot = RecentLogs & {
  fetchedAt: string;
  source?: 'live';
  streamId?: string;
  sequence?: number;
  receivedBytes?: number;
  droppedBytes?: number;
  droppedBatches?: number;
};
export const LOG_BUFFER_BYTES = 2 * 1024 * 1024;
/** Keep a UTF-8 tail without retaining a partial code point at the front. */
export function appendLogText(current: string, incoming: string, capacity = LOG_BUFFER_BYTES) {
  const bytes = new TextEncoder().encode(current + incoming);
  let start = Math.max(0, bytes.byteLength - capacity);
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) ++start;
  return { text: new TextDecoder().decode(bytes.subarray(start)), byteCount: bytes.length - start, droppedBytes: start };
}
