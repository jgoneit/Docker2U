export const LOG_SEARCH_CHECKPOINT_STRIDE = 512;
const SLICE_EXEC_LIMIT = 16_384;
const SLICE_BUDGET_MS = 4;

export type LogMatch = { ordinal: number; start: number; length: number };
function literalPattern(query: string) {
  return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
}

/** Exact, non-overlapping Unicode matches with one UTF-16 offset per 512 matches. */
export class LogSearchIndex {
  private readonly pattern: RegExp;
  private readonly checkpoints: Uint32Array;
  private count = 0;
  private complete: boolean;

  constructor(private readonly text: string, private readonly query: string) {
    this.pattern = literalPattern(query);
    // Every nonempty match consumes at least one UTF-16 code unit.
    this.checkpoints = new Uint32Array(query ? Math.ceil(text.length / LOG_SEARCH_CHECKPOINT_STRIDE) : 0);
    this.complete = !text || !query;
  }

  get done() { return this.complete; }
  get total() { return this.count; }
  get checkpointCount() { return Math.ceil(this.count / LOG_SEARCH_CHECKPOINT_STRIDE); }
  get checkpointBytes() { return this.checkpoints.byteLength; }

  scanSlice(now: () => number = () => performance.now()) {
    if (this.complete) return true;
    const started = now();
    for (let executions = 0; executions < SLICE_EXEC_LIMIT; executions++) {
      if (executions % 64 === 0 && now() - started >= SLICE_BUDGET_MS) return false;
      const match = this.pattern.exec(this.text);
      if (!match) { this.complete = true; return true; }
      if (this.count % LOG_SEARCH_CHECKPOINT_STRIDE === 0) this.checkpoints[this.count / LOG_SEARCH_CHECKPOINT_STRIDE] = match.index;
      this.count++;
    }
    return false;
  }

  locate(ordinal: number): LogMatch | undefined {
    if (!this.complete || !Number.isInteger(ordinal) || ordinal < 0 || ordinal >= this.count) return undefined;
    const checkpoint = Math.floor(ordinal / LOG_SEARCH_CHECKPOINT_STRIDE);
    const start = this.checkpoints[checkpoint];
    if (start === undefined) return undefined;
    const pattern = literalPattern(this.query);
    pattern.lastIndex = start;
    for (let current = checkpoint * LOG_SEARCH_CHECKPOINT_STRIDE; current <= ordinal; current++) {
      const match = pattern.exec(this.text);
      if (!match) return undefined;
      if (current === ordinal) return { ordinal, start: match.index, length: match[0].length };
    }
    return undefined;
  }
}

export type LogSearchRequest =
  | { type: 'snapshot'; snapshotId: number; text: string }
  | { type: 'search'; snapshotId: number; searchId: number; query: string }
  | { type: 'locate'; searchId: number; navigationId: number; ordinal: number }
  | { type: 'cancel' }
  | { type: 'reset' };
export type LogSearchReply =
  | { type: 'ready' }
  | { type: 'result'; snapshotId: number; searchId: number; total: number; match?: LogMatch }
  | { type: 'located'; searchId: number; navigationId: number; match: LogMatch }
  | { type: 'error'; searchId: number };

export type ScheduleLogSearch = (callback: () => void) => () => void;
export const scheduleLogSearch: ScheduleLogSearch = callback => {
  const timer = setTimeout(callback, 0);
  return () => clearTimeout(timer);
};

/** Shared by the Worker and its cooperative main-thread fallback. */
export class LogSearchRunner {
  private text = '';
  private snapshotId = 0;
  private searchId = 0;
  private index?: LogSearchIndex;
  private cancelScan?: () => void;
  private cancelNavigation?: () => void;
  private disposed = false;

  constructor(private readonly reply: (reply: LogSearchReply) => void, private readonly schedule: ScheduleLogSearch = scheduleLogSearch) {}

  handle(request: LogSearchRequest) {
    if (this.disposed) return;
    if (request.type === 'reset' || request.type === 'snapshot') {
      this.cancelWork(); this.index = undefined;
      this.text = request.type === 'snapshot' ? request.text : '';
      this.snapshotId = request.type === 'snapshot' ? request.snapshotId : 0;
      this.searchId = 0;
    } else if (request.type === 'cancel') {
      this.cancelWork(); this.index = undefined; this.searchId = 0;
    } else if (request.type === 'search') {
      if (request.snapshotId !== this.snapshotId) return;
      this.cancelWork(); this.searchId = request.searchId;
      try {
        const index = new LogSearchIndex(this.text, request.query);
        this.index = index;
        const scan = () => {
          if (this.disposed || this.index !== index || this.searchId !== request.searchId) return;
          try {
            if (index.scanSlice()) {
              this.cancelScan = undefined;
              this.reply({ type: 'result', snapshotId: request.snapshotId, searchId: request.searchId, total: index.total, match: index.locate(0) });
            } else this.cancelScan = this.schedule(scan);
          } catch { this.reply({ type: 'error', searchId: request.searchId }); }
        };
        this.cancelScan = this.schedule(scan);
      } catch { this.reply({ type: 'error', searchId: request.searchId }); }
    } else if (request.searchId === this.searchId && this.index?.done) {
      this.cancelNavigation?.();
      const index = this.index;
      this.cancelNavigation = this.schedule(() => {
        if (this.disposed || this.index !== index || this.searchId !== request.searchId) return;
        this.cancelNavigation = undefined;
        try {
          const match = index.locate(request.ordinal);
          if (match) this.reply({ type: 'located', searchId: request.searchId, navigationId: request.navigationId, match });
        } catch { this.reply({ type: 'error', searchId: request.searchId }); }
      });
    }
  }

  private cancelWork() {
    this.cancelScan?.(); this.cancelNavigation?.();
    this.cancelScan = undefined; this.cancelNavigation = undefined;
  }

  dispose() {
    this.disposed = true; this.cancelWork(); this.index = undefined; this.text = '';
  }
}
