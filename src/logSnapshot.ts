import type { RecentLogs } from './api';

/** Frontend receipt time; the native RecentLogs IPC contract remains unchanged. */
export type LogSnapshot = RecentLogs & { fetchedAt: string };
