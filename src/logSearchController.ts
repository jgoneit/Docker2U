import { LogSearchRunner, type LogSearchReply, type LogSearchRequest } from './logSearch';

export type LogSearchInput = { target: string; text: string; query: string };
export type LogSearchState = {
  input: LogSearchInput;
  status: 'idle' | 'searching' | 'ready' | 'error';
  total: number;
  activeIndex: number;
  activeStart: number | undefined;
  activeLength: number;
};
export function emptyLogSearchState(input: LogSearchInput): LogSearchState {
  return { input, status: input.text && input.query ? 'searching' : 'idle', total: 0, activeIndex: 0, activeStart: undefined, activeLength: 0 };
}
export function sameLogSearchInput(a: LogSearchInput, b: LogSearchInput) {
  return a.target === b.target && a.text === b.text && a.query === b.query;
}
export type LogSearchWorker = Pick<Worker, 'postMessage' | 'onmessage' | 'onerror' | 'onmessageerror' | 'terminate'>;
const createWorker = () => new Worker(new URL('./logSearch.worker.ts', import.meta.url), { type: 'module' });

export class LogSearchController {
  private state?: LogSearchState;
  private snapshotId = 0;
  private sentSnapshotId?: number;
  private searchId = 0;
  private navigationId = 0;
  private desiredOrdinal = 0;
  private worker?: LogSearchWorker;
  private fallback?: LogSearchRunner;
  private ready = false;
  private readyTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;

  constructor(private readonly publish: (state: LogSearchState) => void, private readonly makeWorker: () => LogSearchWorker = createWorker) {}

  update(input: LogSearchInput) {
    if (this.disposed || (this.state && sameLogSearchInput(this.state.input, input))) return;
    const snapshotChanged = !this.state || this.state.input.target !== input.target || this.state.input.text !== input.text;
    if (snapshotChanged) this.snapshotId++;
    this.searchId++; this.navigationId++; this.desiredOrdinal = 0;
    this.state = emptyLogSearchState(input); this.publish(this.state);
    if (!input.text || !input.query) {
      if (!input.text || snapshotChanged) { this.send({ type: 'reset' }); this.sentSnapshotId = undefined; }
      else this.send({ type: 'cancel' });
      return;
    }
    if (!this.worker && !this.fallback) this.startWorker();
    else this.dispatchLatest();
  }

  move(direction: 1 | -1) {
    if (this.disposed || this.state?.status !== 'ready' || !this.state.total) return;
    this.desiredOrdinal = (this.desiredOrdinal + direction + this.state.total) % this.state.total;
    this.send({ type: 'locate', searchId: this.searchId, navigationId: ++this.navigationId, ordinal: this.desiredOrdinal });
  }

  private startWorker() {
    try {
      const worker = this.makeWorker();
      this.worker = worker;
      worker.onmessage = event => { if (this.worker === worker) this.receive(event.data as LogSearchReply); };
      worker.onerror = event => { event.preventDefault?.(); if (this.worker === worker) this.useFallback(); };
      worker.onmessageerror = () => { if (this.worker === worker) this.useFallback(); };
      this.readyTimer = setTimeout(() => this.useFallback(), 2_000);
    } catch { this.useFallback(); }
  }

  private dispatchLatest() {
    if (!this.ready || !this.state?.input.text || !this.state.input.query || this.disposed) return;
    if (this.sentSnapshotId !== this.snapshotId) {
      this.send({ type: 'snapshot', snapshotId: this.snapshotId, text: this.state.input.text });
      this.sentSnapshotId = this.snapshotId;
    }
    this.send({ type: 'search', snapshotId: this.snapshotId, searchId: this.searchId, query: this.state.input.query });
  }

  private send(request: LogSearchRequest) {
    if (this.disposed) return;
    try {
      if (this.fallback) this.fallback.handle(request);
      else if (this.ready) this.worker?.postMessage(request);
    } catch { this.useFallback(); }
  }

  private receive(reply: LogSearchReply) {
    if (this.disposed) return;
    if (reply.type === 'ready') {
      clearTimeout(this.readyTimer); this.ready = true; this.dispatchLatest();
      return;
    }
    if (!this.state || reply.searchId !== this.searchId || !this.state.input.text || !this.state.input.query) return;
    if (reply.type === 'error') {
      if (!this.fallback) this.useFallback();
      else { this.state = { ...emptyLogSearchState(this.state.input), status: 'error' }; this.publish(this.state); }
    } else if (reply.type === 'result' && reply.snapshotId === this.snapshotId) {
      this.desiredOrdinal = Math.min(this.desiredOrdinal, Math.max(0, reply.total - 1));
      if (this.desiredOrdinal > 0) {
        this.state = { ...this.state, total: reply.total };
        this.send({ type: 'locate', searchId: this.searchId, navigationId: ++this.navigationId, ordinal: this.desiredOrdinal });
        return;
      }
      this.state = { ...this.state, status: 'ready', total: reply.total, activeIndex: reply.match?.ordinal ?? 0, activeStart: reply.match?.start, activeLength: reply.match?.length ?? 0 };
      this.publish(this.state);
    } else if (reply.type === 'located' && reply.navigationId === this.navigationId) {
      this.state = { ...this.state, status: 'ready', activeIndex: reply.match.ordinal, activeStart: reply.match.start, activeLength: reply.match.length };
      this.publish(this.state);
    }
  }

  private useFallback() {
    if (this.disposed || this.fallback) return;
    clearTimeout(this.readyTimer);
    this.worker?.terminate(); this.worker = undefined;
    this.fallback = new LogSearchRunner(reply => this.receive(reply));
    if (this.state) { this.state = emptyLogSearchState(this.state.input); this.publish(this.state); }
    this.ready = true; this.sentSnapshotId = undefined; this.dispatchLatest();
  }

  dispose() {
    this.disposed = true; clearTimeout(this.readyTimer);
    this.worker?.terminate(); this.worker = undefined;
    this.fallback?.dispose(); this.fallback = undefined;
    this.state = undefined;
  }
}
