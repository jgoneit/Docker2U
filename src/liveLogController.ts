import { coreError, type Container, type ContainerList, type CoreError, type RecentLogs } from './api';
import { frontendError } from './frontendErrors';
import { connectionInvalidatingErrors } from './frontendSession';
import { appendLogText, type LogSnapshot } from './logSnapshot';

export type LiveLogStatus = 'idle' | 'connecting' | 'following' | 'ended' | 'error';
export interface LiveLogState {
  logs: LogSnapshot | null;
  logsError: CoreError | null;
  loadingLogs: boolean;
  logRequestPending: boolean;
  liveStatus: LiveLogStatus;
}
export interface LiveLogInput {
  container: Container | null;
  snapshot: ContainerList | null;
  enabled: boolean;
  invalidated?: boolean;
  restartVersion?: number;
  replaceVersion?: number;
}
interface Stream { sessionId: string; streamId: string; fullId: string }
interface Frame { sessionId: string; streamId: string; sequence: number; text: string; truncated: boolean; terminal: boolean; error: CoreError | null }
export interface LogTransport {
  getRecentLogs(sessionId: string, handle: string): Promise<RecentLogs>;
  startLogStream(sessionId: string, generation: number, handle: string): Promise<Stream>;
  readLogStream(sessionId: string, streamId: string): Promise<Frame>;
  stopLogStream(sessionId: string, streamId: string): Promise<void>;
}
export const emptyLogState = (): LiveLogState => ({ logs: null, logsError: null, loadingLogs: false, logRequestPending: false, liveStatus: 'idle' });
const liveStates = new Set(['running', 'paused', 'restarting']);
const readableStates = new Set([...liveStates, 'created', 'exited', 'dead']);

/** One selected identity, one pending start/snapshot, and serialized 250ms reads. */
export class LiveLogController {
  private input: LiveLogInput = { container: null, snapshot: null, enabled: false };
  private identity = '';
  private blockedSession: string | null = null;
  private revision = 0;
  private wanted = false;
  private cleared = false;
  private restartAfterRead = false;
  private busy = false;
  private reading = false;
  private queuedRead: { stream: Stream; revision: number; identity: string } | null = null;
  private destroyed = false;
  private stream: Stream | null = null;
  private acknowledgedSequence = -1;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopping = new Set<string>();
  private state = emptyLogState();
  constructor(private transport: LogTransport, private publish: (state: LiveLogState) => void,
    private reportError: (error: unknown, failure: CoreError, sessionId: string) => boolean | void = () => {}) {}
  private emit(patch: Partial<LiveLogState>) {
    this.state = { ...this.state, ...patch };
    if (!this.destroyed) this.publish(this.state);
  }
  update(input: LiveLogInput) {
    const identity = input.container && input.snapshot ? `${input.snapshot.sessionId}/${input.container.fullId}` : '';
    const restart = input.restartVersion !== this.input.restartVersion;
    const replace = !!identity && identity === this.identity && input.replaceVersion !== this.input.replaceVersion;
    const wasReadable = !!this.input.container && readableStates.has(this.input.container.state);
    const wasInvalidated = this.input.invalidated || this.input.snapshot?.stale;
    this.input = input;
    if (identity !== this.identity) {
      this.cancel(); this.identity = identity; this.cleared = false; this.wanted = !!identity;
      this.emit({ ...emptyLogState(), loadingLogs: !!identity, logRequestPending: this.busy });
    }
    if (input.container && !readableStates.has(input.container.state) && !input.snapshot?.stale) {
      this.cancel(); this.wanted = false;
      this.emit({ ...emptyLogState(), logRequestPending: this.busy });
      return;
    }
    if (input.invalidated || input.snapshot?.stale) {
      this.cancel(); this.wanted = false;
      this.emit({ loadingLogs: false, logRequestPending: this.busy, liveStatus: this.state.logs ? 'ended' : 'idle' });
      return;
    }
    if ((wasInvalidated || !wasReadable) && !this.cleared) this.wanted = !!identity;
    if (replace && !this.cleared) {
      // A successful Restart with fresh inventory replaces the tail exactly once.
      // Do not wait for an old follow process that may survive the container restart.
      this.cancel(); this.wanted = true;
    } else if (restart && !this.cleared) {
      if (this.state.liveStatus === 'ended') this.wanted = true;
      // A refresh can precede the final read of a stream that just exited.
      else if (this.state.liveStatus === 'following') this.restartAfterRead = true;
    }
    this.drain();
  }
  reload() {
    if (!this.canStart() || this.busy || this.wanted) return;
    this.cancel(); this.cleared = false; this.wanted = true;
    this.emit({ logs: null, logsError: null, loadingLogs: true });
    this.drain();
  }
  clear() {
    this.cancel(); this.cleared = true; this.wanted = false;
    this.emit({ ...emptyLogState(), logRequestPending: this.busy });
  }
  destroy() { this.destroyed = true; this.wanted = false; this.cancel(); }
  private canStart() {
    return !this.destroyed && this.input.enabled && !this.input.invalidated && !!this.input.container && !!this.input.snapshot
      && this.input.snapshot.sessionId !== this.blockedSession
      && !this.input.snapshot.stale && readableStates.has(this.input.container.state);
  }
  private valid(revision: number, identity: string) { return !this.destroyed && revision === this.revision && identity === this.identity; }
  private cancel() {
    ++this.revision; this.restartAfterRead = false; this.queuedRead = null;
    this.acknowledgedSequence = -1;
    clearTimeout(this.timer); this.timer = undefined;
    const stream = this.stream; this.stream = null;
    if (stream) this.stop(stream);
  }
  private stop(stream: Stream) {
    const key = `${stream.sessionId}/${stream.streamId}`;
    if (this.stopping.has(key)) return;
    this.stopping.add(key);
    void this.transport.stopLogStream(stream.sessionId, stream.streamId).catch(() => {}).finally(() => {
      this.stopping.delete(key); this.drain();
    });
  }
  private fail(error: unknown, sessionId: string, revision: number, identity: string) {
    const failure = coreError(error);
    // An old selection may still reveal an invalid connection, but an old session cannot.
    const current = this.valid(revision, identity);
    if (!current && !connectionInvalidatingErrors.has(failure.code)) return;
    if (!this.destroyed && this.input.snapshot?.sessionId === sessionId && this.reportError(error, failure, sessionId) === true) {
      this.blockedSession = sessionId; this.wanted = false; this.cancel();
    }
    if (current) this.emit({ logsError: failure, loadingLogs: false, liveStatus: 'error' });
  }
  private drain() {
    if (!this.wanted || this.busy || this.stopping.size || !this.canStart()) return;
    const container = this.input.container!; const snapshot = this.input.snapshot!;
    const revision = this.revision; const identity = this.identity;
    this.wanted = false; this.busy = true;
    this.emit({ loadingLogs: true, logRequestPending: true, logsError: null, liveStatus: liveStates.has(container.state) ? 'connecting' : 'idle' });
    void (async () => {
      try {
        if (liveStates.has(container.state)) {
          const stream = await this.transport.startLogStream(snapshot.sessionId, snapshot.generation, container.handle);
          if (!this.valid(revision, identity)) { this.stop(stream); return; }
          if (stream.sessionId !== snapshot.sessionId || stream.fullId !== container.fullId || !stream.streamId) {
            this.stop(stream); throw frontendError('staleLogs');
          }
          this.stream = stream;
          this.acknowledgedSequence = -1;
          this.emit({ logs: { sessionId: snapshot.sessionId, generation: snapshot.generation, handle: container.handle, text: '', byteCount: 0,
            truncated: false, command: '', stderr: '', fetchedAt: new Date().toISOString(), source: 'live', streamId: stream.streamId,
            sequence: -1, droppedBytes: 0, droppedBatches: 0, receivedBytes: 0 }, loadingLogs: false, liveStatus: 'following' });
          this.poll(stream, revision, identity);
        } else {
          const logs = await this.transport.getRecentLogs(snapshot.sessionId, container.handle);
          if (!this.valid(revision, identity)) return;
          if (logs.sessionId !== snapshot.sessionId || logs.generation !== snapshot.generation || logs.handle !== container.handle) throw frontendError('staleLogs');
          const bounded = appendLogText('', logs.text);
          this.emit({ logs: { ...logs, text: bounded.text, byteCount: bounded.byteCount, truncated: logs.truncated || bounded.droppedBytes > 0,
            fetchedAt: new Date().toISOString(), droppedBytes: bounded.droppedBytes }, loadingLogs: false, liveStatus: 'ended' });
        }
      } catch (error) { this.fail(error, snapshot.sessionId, revision, identity); }
      finally { this.busy = false; this.emit({ logRequestPending: false }); this.drain(); }
    })();
  }
  private poll(stream: Stream, revision: number, identity: string) {
    if (!this.valid(revision, identity) || this.stream !== stream) return;
    // Cancellation invalidates display delivery, but cannot release an IPC still in flight.
    if (this.reading) { this.queuedRead = { stream, revision, identity }; return; }
    this.reading = true;
    void this.transport.readLogStream(stream.sessionId, stream.streamId).then(frame => {
      if (!this.valid(revision, identity) || this.stream !== stream) {
        if (frame.error) this.fail(frame.error, stream.sessionId, revision, identity);
        return;
      }
      if (frame.sessionId !== stream.sessionId || frame.streamId !== stream.streamId
        || !Number.isSafeInteger(frame.sequence) || frame.sequence < this.acknowledgedSequence) throw frontendError('staleLogs');
      const previous = this.state.logs!;
      // Native reads acknowledge every poll, including empty ones. Keep transport
      // ordering separate from the last visible change and actual receipt time.
      const fresh = frame.sequence > this.acknowledgedSequence;
      this.acknowledgedSequence = frame.sequence;
      if (fresh && (frame.text.length > 0 || frame.truncated)) {
        const bounded = frame.text ? appendLogText(previous.text, frame.text)
          : { text: previous.text, byteCount: previous.byteCount, droppedBytes: 0 };
        const received = new TextEncoder().encode(frame.text).byteLength;
        this.emit({ logs: { ...previous, ...bounded, truncated: previous.truncated || frame.truncated || bounded.droppedBytes > 0,
          droppedBytes: (previous.droppedBytes ?? 0) + bounded.droppedBytes, droppedBatches: (previous.droppedBatches ?? 0) + Number(frame.truncated), receivedBytes: (previous.receivedBytes ?? 0) + received,
          sequence: frame.sequence, fetchedAt: received > 0 ? new Date().toISOString() : previous.fetchedAt } });
      }
      if (frame.terminal || frame.error) {
        this.stream = null; this.stop(stream);
        if (frame.error) this.fail(frame.error, stream.sessionId, revision, identity);
        else {
          this.emit({ liveStatus: 'ended' });
          if (this.restartAfterRead && !this.cleared) { this.wanted = true; this.drain(); }
        }
        this.restartAfterRead = false;
        return;
      }
      this.restartAfterRead = false;
      this.timer = setTimeout(() => this.poll(stream, revision, identity), 250);
    }).catch(error => {
      if (this.valid(revision, identity) && this.stream === stream) { this.stream = null; this.stop(stream); }
      this.fail(error, stream.sessionId, revision, identity);
    }).finally(() => {
      this.reading = false;
      const queued = this.queuedRead; this.queuedRead = null;
      if (queued) this.poll(queued.stream, queued.revision, queued.identity);
    });
  }
}
