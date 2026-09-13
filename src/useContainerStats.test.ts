import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api, type Container, type ContainerList, type ContainerStats } from './api';
import { useContainerStats } from './useContainerStats';
vi.mock('./api', async original => ({ ...await original<typeof import('./api')>(), api: { getContainerStats: vi.fn() } }));
const collect = vi.mocked(api.getContainerStats);
const container: Container = { handle: 'a', fullId: 'a'.repeat(64), shortId: 'a'.repeat(12), name: 'api', image: 'app', state: 'running', health: null, healthConfigured: null, ports: [], composeProject: 'orders', composeService: 'api', createdAt: '' };
const other = { ...container, handle: 'b', fullId: 'b'.repeat(64), name: 'worker' };
const snapshot: ContainerList = { sessionId: 'one', generation: 1, containers: [container, other], refreshedAt: '', stale: false };
const reply = (rows = [container], id = 'one', generation = 1): ContainerStats => ({ sessionId: id, generation, sampledAt: '2026-09-07T00:00:00Z', error: null, items: rows.map(row => ({ handle: row.handle, fullId: row.fullId, available: true, cpuPercent: 125.5, memoryUsage: '64MiB / 2GiB', memoryPercent: 3.125 })) });
const unavailable = (rows = [container], generation = 1): ContainerStats => ({ ...reply(rows, 'one', generation), sampledAt: '2026-09-07T00:00:10Z',
  items: rows.map(row => ({ handle: row.handle, fullId: row.fullId, available: false, cpuPercent: null, memoryUsage: null, memoryPercent: null })) });
const flush = () => act(async () => { await Promise.resolve(); });
function deferred<T>() { let resolve!: (result: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const onError = vi.fn();
function input(rows = [container], enabled = true, list = snapshot) { return { snapshot: list, containers: rows, enabled, onError }; }
beforeEach(() => { vi.useFakeTimers(); vi.resetAllMocks(); Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); collect.mockResolvedValue(reply()); });
afterEach(() => vi.useRealTimers());
it('samples only visible running targets immediately and 5 seconds after completion', async () => {
  const pending = deferred<ContainerStats>(); collect.mockReturnValueOnce(pending.promise);
  const { result } = renderHook(() => useContainerStats(input([container, { ...other, state: 'exited' }])));
  expect(collect).toHaveBeenCalledExactlyOnceWith('one', 1, ['a']);
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); }); expect(collect).toHaveBeenCalledTimes(1);
  await act(async () => pending.resolve(reply())); expect(result.current.sampleFor(container)?.cpuPercent).toBe(125.5);
  await act(async () => { await vi.advanceTimersByTimeAsync(4_999); }); expect(collect).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); }); expect(collect).toHaveBeenCalledTimes(2);
});
it('does not overlap requests across filter changes and ignores the former response', async () => {
  const pending = deferred<ContainerStats>(); collect.mockReturnValueOnce(pending.promise).mockResolvedValue(reply([other]));
  const { result, rerender } = renderHook(props => useContainerStats(props), { initialProps: input() });
  rerender(input([other])); expect(collect).toHaveBeenCalledTimes(1);
  await act(async () => pending.resolve(reply()));
  expect(collect).toHaveBeenLastCalledWith('one', 1, ['b']); expect(result.current.sampleFor(container)).toBeUndefined();
  expect(result.current.sampleFor(other)?.memoryUsage).toBe('64MiB / 2GiB');
});
it('does not invent an old sample after unavailable replies, failures, hidden collection or a refreshed inventory', async () => {
  collect.mockResolvedValue(unavailable());
  const { result, rerender } = renderHook(props => useContainerStats(props), { initialProps: input() }); await flush();
  expect(result.current.sampleFor(container)).toBeUndefined();
  expect(result.current.error).toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  expect(result.current.sampleFor(container)).toBeUndefined();
  collect.mockRejectedValueOnce({ code: 'TimedOut', message: 'timeout' });
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  expect(result.current.sampleFor(container)).toBeUndefined();
  expect(result.current.error?.code).toBe('TimedOut');
  expect(onError).toHaveBeenCalledOnce();
  act(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
  expect(result.current.sampleFor(container)).toBeUndefined();
  act(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); document.dispatchEvent(new Event('visibilitychange')); }); await flush();
  expect(result.current.sampleFor(container)).toBeUndefined();
  expect(result.current.error).toBeNull();
  rerender(input([container], false));
  expect(result.current.sampleFor(container)).toBeUndefined();
  rerender(input([container], true, { ...snapshot, stale: true }));
  expect(result.current.sampleFor(container)).toBeUndefined();
  const refreshed = { ...container, handle: 'new-handle' };
  const pending = deferred<ContainerStats>(); collect.mockReturnValueOnce(pending.promise);
  rerender(input([refreshed], true, { ...snapshot, generation: 2, containers: [refreshed] }));
  expect(result.current.sampleFor(refreshed)).toBeUndefined();
  await act(async () => pending.resolve(unavailable([refreshed], 2)));
  expect(result.current.sampleFor(refreshed)).toBeUndefined();
});
it('retains observed values and their timestamp through unavailable refreshes, then clears stale on recovery', async () => {
  collect.mockRejectedValueOnce({ code: 'TimedOut', message: 'timeout' });
  const { result, rerender } = renderHook(props => useContainerStats(props), { initialProps: input() }); await flush();
  expect(result.current.error?.code).toBe('TimedOut'); expect(result.current.sampleFor(container)).toBeUndefined();
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  const observed = result.current.sampleFor(container)!;
  expect(observed.stale).toBe(false);
  collect.mockResolvedValue(unavailable());
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  expect(result.current.sampleFor(container)).toEqual({ ...observed, stale: true });
  const refreshed = { ...container, handle: 'new-handle' };
  collect.mockResolvedValue(unavailable([refreshed], 2));
  rerender(input([refreshed], true, { ...snapshot, generation: 2, containers: [refreshed] })); await flush();
  expect(result.current.sampleFor(refreshed)).toEqual({ ...observed, handle: refreshed.handle, stale: true });
  const recovered = { ...reply([refreshed], 'one', 2), sampledAt: '2026-09-07T00:00:20Z' };
  recovered.items[0]!.cpuPercent = 0;
  collect.mockResolvedValue(recovered);
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  expect(result.current.sampleFor(refreshed)).toEqual({ ...recovered.items[0], sampledAt: recovered.sampledAt, stale: false });
});
it('pauses new requests while hidden or busy and resumes immediately with a valid list', async () => {
  const { rerender } = renderHook(props => useContainerStats(props), { initialProps: input() }); await flush();
  act(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); }); expect(collect).toHaveBeenCalledTimes(1);
  act(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); document.dispatchEvent(new Event('visibilitychange')); }); await flush();
  expect(collect).toHaveBeenCalledTimes(2); rerender(input([container], false));
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); }); expect(collect).toHaveBeenCalledTimes(2);
  rerender(input()); await flush(); expect(collect).toHaveBeenCalledTimes(3);
});
it.each(['unexpected', 'duplicate', 'session', 'generation', 'numeric'])('rejects %s data and never presents it as a fresh zero', async kind => {
  const value = reply();
  if (kind === 'unexpected') value.items[0]!.fullId = other.fullId;
  if (kind === 'duplicate') value.items.push(value.items[0]!);
  if (kind === 'session') value.sessionId = 'old';
  if (kind === 'generation') value.generation = 0;
  if (kind === 'numeric') value.items[0]!.cpuPercent = NaN;
  collect.mockResolvedValue(value); const { result } = renderHook(() => useContainerStats(input())); await flush();
  expect(result.current.sampleFor(container)).toBeUndefined(); expect(result.current.error?.code).toBe('InvalidStatsResponse');
});
it('does not collect empty targets and hides samples for stopped or replaced-session containers', async () => {
  const { result, rerender } = renderHook(props => useContainerStats(props), { initialProps: input([]) }); expect(collect).not.toHaveBeenCalled();
  rerender(input()); await flush(); expect(result.current.sampleFor({ ...container, state: 'exited' })).toBeUndefined();
  rerender(input([], true, { ...snapshot, sessionId: 'two' })); expect(result.current.sampleFor(container)).toBeUndefined();
});
it('propagates a late same-session connection error during a refresh but ignores a replaced session', async () => {
  const pending = deferred<ContainerStats>(); collect.mockReturnValueOnce(pending.promise);
  const { rerender } = renderHook(props => useContainerStats(props), { initialProps: input() }); rerender(input([container], false));
  await act(async () => pending.reject({ code: 'EnvironmentChanged', message: 'changed' })); expect(onError).toHaveBeenCalledTimes(1);
  const second = deferred<ContainerStats>(); collect.mockReturnValueOnce(second.promise); rerender(input());
  rerender(input([], false, { ...snapshot, sessionId: 'two' }));
  await act(async () => second.reject({ code: 'EnvironmentChanged', message: 'old' })); expect(onError).toHaveBeenCalledTimes(1);
});
