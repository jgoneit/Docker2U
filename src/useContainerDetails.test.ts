import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from './api';
import type { ContainerDetails } from './containerDetailsTypes';
import { useContainerDetails, type ContainerDetailsInput } from './useContainerDetails';
import { containerDetailsFixture, detailsContainer as container, detailsSnapshot as snapshot } from './test/containerDetailsFixture';

vi.mock('./api', async original => ({ ...await original<typeof import('./api')>(), api: { getContainerDetails: vi.fn() } }));
const read = vi.mocked(api.getContainerDetails);
const onError = vi.fn();
const input = (overrides: Partial<ContainerDetailsInput> = {}): ContainerDetailsInput => ({ container, snapshot, active: true, enabled: true, onError, ...overrides });
const flush = () => act(async () => { await Promise.resolve(); });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
beforeEach(() => { vi.useFakeTimers(); vi.resetAllMocks(); read.mockResolvedValue(containerDetailsFixture()); });
afterEach(() => vi.useRealTimers());

it('loads lazily once and shares the accepted snapshot across tab visits without polling', async () => {
  const { result, rerender } = renderHook(useContainerDetails, { initialProps: input({ active: false }) });
  expect(read).not.toHaveBeenCalled();
  rerender(input()); await flush();
  expect(read).toHaveBeenCalledExactlyOnceWith('one', 1, 'details-a');
  expect(result.current.details?.fullId).toBe(container.fullId);
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  rerender(input({ active: false })); rerender(input()); await flush();
  expect(read).toHaveBeenCalledTimes(1); expect(result.current.stale).toBe(false);
});

it('serializes reads and never presents a delayed response for a previous selection', async () => {
  const pending = deferred<ContainerDetails>(); read.mockReturnValueOnce(pending.promise);
  const { result, rerender } = renderHook(useContainerDetails, { initialProps: input() });
  const other = { ...container, handle: 'details-b', fullId: 'b'.repeat(64) };
  const list = { ...snapshot, containers: [container, other] };
  read.mockResolvedValue(containerDetailsFixture(other, list));
  rerender(input({ container: other, snapshot: list }));
  expect(result.current.details).toBeNull(); expect(read).toHaveBeenCalledTimes(1);
  await act(async () => pending.resolve(containerDetailsFixture()));
  expect(read).toHaveBeenLastCalledWith('one', 1, 'details-b');
  expect(result.current.details?.fullId).toBe(other.fullId);
});

it('invalidates at a mutation or refresh boundary and reloads without needing a generation change', async () => {
  const { result, rerender } = renderHook(useContainerDetails, { initialProps: input() }); await flush();
  const before = result.current.details;
  rerender(input({ enabled: false })); await flush();
  expect(result.current.details).toBe(before); expect(result.current.stale).toBe(true);
  act(() => result.current.reload()); expect(read).toHaveBeenCalledTimes(1);
  const after = containerDetailsFixture(); after.diagnostics.oomKilled = true;
  read.mockResolvedValue(after);
  rerender(input()); await flush();
  expect(read).toHaveBeenCalledTimes(2); expect(result.current.details?.diagnostics.oomKilled).toBe(true); expect(result.current.stale).toBe(false);
});

it('hides the previous generation immediately and does not read a stale or missing inventory target', async () => {
  const { result, rerender } = renderHook(useContainerDetails, { initialProps: input() }); await flush();
  rerender(input({ snapshot: { ...snapshot, stale: true } })); await flush();
  expect(result.current.stale).toBe(true); expect(read).toHaveBeenCalledTimes(1);
  const refreshed = { ...snapshot, generation: 2 };
  const pending = deferred<ContainerDetails>(); read.mockReturnValueOnce(pending.promise);
  rerender(input({ snapshot: refreshed })); expect(result.current.details).toBeNull();
  await act(async () => pending.resolve(containerDetailsFixture(container, refreshed)));
  expect(result.current.details?.generation).toBe(2);
  rerender(input({ snapshot: { ...refreshed, containers: [] } })); await flush();
  expect(result.current.stale).toBe(true); expect(read).toHaveBeenCalledTimes(2);
  rerender(input({ container: null })); expect(result.current.details).toBeNull();
});

it('retains an explicitly stale observation during manual reload and prevents duplicate reads', async () => {
  const { result } = renderHook(useContainerDetails, { initialProps: input() }); await flush();
  const pending = deferred<ContainerDetails>(); read.mockReturnValueOnce(pending.promise);
  act(() => result.current.reload());
  expect(result.current.loading).toBe(true); expect(result.current.stale).toBe(true);
  act(() => result.current.reload()); expect(read).toHaveBeenCalledTimes(2);
  await act(async () => pending.resolve(containerDetailsFixture()));
  expect(result.current.loading).toBe(false); expect(result.current.stale).toBe(false);
});

it.each(['sessionId', 'generation', 'handle', 'fullId', 'observedAt'] as const)('rejects mismatched %s in a detail response', async field => {
  const response = containerDetailsFixture();
  if (field === 'generation') response.generation = 5;
  else response[field] = 'unexpected';
  read.mockResolvedValue(response);
  const { result } = renderHook(useContainerDetails, { initialProps: input() }); await flush();
  expect(result.current.details).toBeNull(); expect(result.current.error?.code).toBe('InvalidDetailsResponse');
  expect(onError).toHaveBeenCalledOnce();
});

it('routes a late current-session Engine error after a selection change but ignores a replaced session', async () => {
  const pending = deferred<ContainerDetails>(); read.mockReturnValueOnce(pending.promise);
  const { rerender } = renderHook(useContainerDetails, { initialProps: input() });
  rerender(input({ container: null, active: false }));
  await act(async () => pending.reject({ code: 'EnvironmentChanged', message: 'changed' }));
  expect(onError).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.objectContaining({ code: 'EnvironmentChanged' }), 'one');
  const second = deferred<ContainerDetails>(); read.mockReturnValueOnce(second.promise);
  rerender(input());
  rerender(input({ snapshot: { ...snapshot, sessionId: 'two' }, active: false }));
  await act(async () => second.reject({ code: 'EnvironmentChanged', message: 'old' }));
  expect(onError).toHaveBeenCalledTimes(1);
});

it('shows ordinary errors for the requested target and retries only after an explicit reload', async () => {
  read.mockRejectedValueOnce({ code: 'TimedOut', message: 'timeout' });
  const { result, rerender } = renderHook(useContainerDetails, { initialProps: input() }); await flush();
  expect(result.current.error?.code).toBe('TimedOut');
  rerender(input({ active: false })); rerender(input()); await flush();
  expect(read).toHaveBeenCalledTimes(1);
  act(() => result.current.reload()); await flush();
  expect(result.current.error).toBeNull(); expect(result.current.details).not.toBeNull();
});
