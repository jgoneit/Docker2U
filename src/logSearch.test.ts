import { describe, expect, it, vi } from 'vitest';
import { LogSearchIndex, LogSearchRunner, type LogSearchReply, type ScheduleLogSearch } from './logSearch';

function finishedIndex(text: string, query: string) {
  const index = new LogSearchIndex(text, query);
  while (!index.scanSlice(() => 0)) { /* Deterministic execution-bound slices. */ }
  return index;
}
function positions(text: string, query: string) {
  const index = finishedIndex(text, query);
  return Array.from({ length: index.total }, (_, ordinal) => index.locate(ordinal)?.start);
}
function taskQueue() {
  let nextId = 0;
  const pending = new Map<number, () => void>();
  const schedule: ScheduleLogSearch = callback => {
    const id = nextId++; pending.set(id, callback);
    return () => { pending.delete(id); };
  };
  const next = () => {
    const entry = pending.entries().next().value;
    if (entry) { pending.delete(entry[0]); entry[1](); }
  };
  const flush = () => { while (pending.size) next(); };
  return { pending, schedule, next, flush };
}

describe('literal log matching', () => {
  it('finds case-insensitive text and treats regular expression syntax literally', () => {
    expect(positions('ERROR error Error', 'eRrOr')).toEqual([0, 6, 12]);
    expect(positions('first .* [x] then .*', '.*')).toEqual([6, 18]);
    expect(positions('first .* [x] then .*', '[x]')).toEqual([9]);
    expect(positions('x\\path', '\\')).toEqual([1]);
    expect(positions('not empty', '')).toEqual([]);
  });
  it('retains original offsets after Unicode text', () => {
    expect(positions('İ first ERROR 한글 error', 'error')).toEqual([8, 17]);
    expect(positions('😀İ ERROR 😀 error', 'error')).toEqual([4, 13]);
    expect(positions('K k K', 'k')).toEqual([0, 2, 4]);
    expect(positions('ſ s S', 's')).toEqual([0, 2, 4]);
    expect(positions('Σ σ ς', 'σ')).toEqual([0, 2, 4]);
    expect(positions('aaaaa', 'aa')).toEqual([0, 2]);
    expect(finishedIndex('x😀y😀', '😀').locate(1)).toEqual({ ordinal: 1, start: 4, length: 2 });
  });

  it('counts every dense 2 MiB match using only 4096 sparse checkpoints', () => {
    const length = 2 * 1024 * 1024;
    const index = finishedIndex('a'.repeat(length), 'a');
    expect(index.total).toBe(length);
    expect(index.checkpointCount).toBe(4096);
    expect(index.checkpointBytes).toBe(16 * 1024);
    for (const ordinal of [0, 511, 512, 513, 1023, 1024, length - 1]) {
      expect(index.locate(ordinal)).toEqual({ ordinal, start: ordinal, length: 1 });
    }
    expect(index.locate(-1)).toBeUndefined();
    expect(index.locate(length)).toBeUndefined();
  });

  it('retains exact non-overlapping navigation across checkpoint boundaries', () => {
    const index = finishedIndex('aab'.repeat(1200), 'aa');
    expect(index.total).toBe(1200);
    for (let ordinal = 0; ordinal < index.total; ordinal++) {
      expect(index.locate(ordinal)).toEqual({ ordinal, start: ordinal * 3, length: 2 });
    }
  });

  it('ends slices at their execution or elapsed-time budget', () => {
    const byExecutions = new LogSearchIndex('a'.repeat(50_000), 'a');
    expect(byExecutions.scanSlice(() => 0)).toBe(false);
    expect(byExecutions.total).toBe(16_384);
    expect(byExecutions.locate(0)).toBeUndefined();
    let clock = 0;
    const byTime = new LogSearchIndex('a'.repeat(50_000), 'a');
    expect(byTime.scanSlice(() => clock++)).toBe(false);
    expect(byTime.total).toBeGreaterThan(0);
    expect(byTime.total).toBeLessThan(16_384);
  });
});

describe('cooperative search runner', () => {
  it('yields between dense slices and keeps only the latest pending search', () => {
    const queue = taskQueue();
    const reply = vi.fn<(reply: LogSearchReply) => void>();
    const runner = new LogSearchRunner(reply, queue.schedule);
    runner.handle({ type: 'snapshot', snapshotId: 1, text: 'a'.repeat(100_000) + 'needle' });
    runner.handle({ type: 'search', snapshotId: 1, searchId: 1, query: 'a' });
    queue.next();
    expect(reply).not.toHaveBeenCalled();
    expect(queue.pending.size).toBe(1);
    runner.handle({ type: 'search', snapshotId: 1, searchId: 2, query: 'needle' });
    runner.handle({ type: 'search', snapshotId: 1, searchId: 3, query: 'absent' });
    expect(queue.pending.size).toBe(1);
    queue.flush();
    expect(reply).toHaveBeenCalledExactlyOnceWith({ type: 'result', snapshotId: 1, searchId: 3, total: 0, match: undefined });
    runner.dispose();
  });

  it('cancels queued navigation and query clearing retains the cached snapshot', () => {
    const queue = taskQueue();
    const reply = vi.fn<(reply: LogSearchReply) => void>();
    const runner = new LogSearchRunner(reply, queue.schedule);
    runner.handle({ type: 'snapshot', snapshotId: 1, text: 'a a a' });
    runner.handle({ type: 'search', snapshotId: 1, searchId: 1, query: 'a' }); queue.flush();
    runner.handle({ type: 'locate', searchId: 1, navigationId: 1, ordinal: 1 });
    runner.handle({ type: 'locate', searchId: 1, navigationId: 2, ordinal: 2 });
    expect(queue.pending.size).toBe(1); queue.flush();
    expect(reply).toHaveBeenLastCalledWith({ type: 'located', searchId: 1, navigationId: 2, match: { ordinal: 2, start: 4, length: 1 } });
    runner.handle({ type: 'cancel' });
    runner.handle({ type: 'search', snapshotId: 1, searchId: 2, query: 'a' }); queue.flush();
    expect(reply).toHaveBeenLastCalledWith({ type: 'result', snapshotId: 1, searchId: 2, total: 3, match: { ordinal: 0, start: 0, length: 1 } });
    runner.dispose();
  });

  it('releases reset snapshots and stops all work after disposal', () => {
    const queue = taskQueue();
    const reply = vi.fn<(reply: LogSearchReply) => void>();
    const runner = new LogSearchRunner(reply, queue.schedule);
    runner.handle({ type: 'snapshot', snapshotId: 1, text: 'a'.repeat(100_000) });
    runner.handle({ type: 'search', snapshotId: 1, searchId: 1, query: 'a' }); queue.next();
    runner.handle({ type: 'reset' });
    runner.handle({ type: 'search', snapshotId: 1, searchId: 2, query: 'a' }); queue.flush();
    expect(reply).not.toHaveBeenCalled();
    runner.handle({ type: 'snapshot', snapshotId: 2, text: 'a' });
    runner.handle({ type: 'search', snapshotId: 2, searchId: 3, query: 'a' });
    runner.dispose(); queue.flush();
    expect(reply).not.toHaveBeenCalled();
  });
});
