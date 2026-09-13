import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { mountApi, type MountInventory } from './mountApi';
import { useMountInventory, type MountInventoryInput } from './useMountInventory';
import { storageFixture, storageSnapshot as snapshot, storageContainer } from './test/storageFixtures';

vi.mock('./mountApi', async original => ({ ...await original<typeof import('./mountApi')>(), mountApi: { getInventory: vi.fn() } }));
const read = vi.mocked(mountApi.getInventory);
const onError = vi.fn();
const input = (overrides: Partial<MountInventoryInput> = {}): MountInventoryInput => ({ snapshot, active: true, enabled: true, onError, ...overrides });
const flush = () => act(async () => { await Promise.resolve(); });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
beforeEach(() => { vi.resetAllMocks(); read.mockResolvedValue(storageFixture()); });

it('loads the whole inventory lazily and caches across tabs, generation changes and reordered IDs', async () => {
  const { result, rerender } = renderHook(useMountInventory, { initialProps: input({ active: false }) });
  expect(read).not.toHaveBeenCalled();
  rerender(input()); await flush();
  expect(read).toHaveBeenCalledExactlyOnceWith(snapshot.sessionId, false);
  expect(result.current.inventory?.containers).toHaveLength(2);
  rerender(input({ active: false })); rerender(input({ snapshot: { ...snapshot, generation: 7, containers: [...snapshot.containers].reverse() } })); await flush();
  expect(read).toHaveBeenCalledTimes(1); expect(result.current.stale).toBe(false);
});

it('retains an in-flight response in the cache when the storage tab closes', async () => {
  const pending = deferred<MountInventory>(); read.mockReturnValueOnce(pending.promise);
  const { result, rerender } = renderHook(useMountInventory, { initialProps: input() });
  rerender(input({ active: false }));
  await act(async () => pending.resolve(storageFixture()));
  rerender(input()); await flush();
  expect(result.current.inventory?.coverage).toBe('complete'); expect(read).toHaveBeenCalledTimes(1);
});

it('serializes changed ID sets and rejects the old response while showing stale cached mounts', async () => {
  const { result, rerender } = renderHook(useMountInventory, { initialProps: input() }); await flush();
  const pending = deferred<MountInventory>(); read.mockReturnValueOnce(pending.promise);
  act(() => result.current.reload());
  const reduced = { ...snapshot, generation: 2, containers: [storageContainer] };
  read.mockResolvedValue(storageFixture(reduced));
  rerender(input({ snapshot: reduced }));
  expect(result.current.stale).toBe(true); expect(read).toHaveBeenCalledTimes(2);
  await act(async () => pending.resolve(storageFixture()));
  expect(read).toHaveBeenCalledTimes(3); expect(result.current.inventory?.containers).toHaveLength(1); expect(result.current.stale).toBe(false);
});

it('does not collect on a changed ID set while the panel is closed and loads it on return', async () => {
  const { result, rerender } = renderHook(useMountInventory, { initialProps: input() }); await flush();
  const reduced = { ...snapshot, containers: [storageContainer] }; read.mockResolvedValue(storageFixture(reduced));
  rerender(input({ active: false, snapshot: reduced })); await flush();
  expect(read).toHaveBeenCalledTimes(1); expect(result.current.stale).toBe(true);
  rerender(input({ snapshot: reduced })); await flush();
  expect(read).toHaveBeenCalledTimes(2); expect(result.current.inventory?.containers).toHaveLength(1);
});

it('clears a replaced session immediately and rejects its late response', async () => {
  const pending = deferred<MountInventory>(); read.mockReturnValueOnce(pending.promise);
  const { result, rerender } = renderHook(useMountInventory, { initialProps: input() });
  const replacement = { ...snapshot, sessionId: 'storage-two' }; read.mockResolvedValue(storageFixture(replacement));
  rerender(input({ snapshot: replacement }));
  expect(result.current.inventory).toBeNull(); expect(read).toHaveBeenCalledTimes(1);
  await act(async () => pending.resolve(storageFixture()));
  expect(result.current.inventory?.sessionId).toBe('storage-two'); expect(read).toHaveBeenCalledTimes(2);
});

it('forces an explicit refresh while preserving prior observations and coalesces duplicate clicks', async () => {
  const { result } = renderHook(useMountInventory, { initialProps: input() }); await flush();
  const before = result.current.inventory;
  const pending = deferred<MountInventory>(); read.mockReturnValueOnce(pending.promise);
  act(() => result.current.reload());
  expect(read).toHaveBeenLastCalledWith(snapshot.sessionId, true); expect(result.current.loading).toBe(true); expect(result.current.stale).toBe(true); expect(result.current.inventory).toBe(before);
  act(() => result.current.reload()); expect(read).toHaveBeenCalledTimes(2);
  await act(async () => pending.resolve(storageFixture()));
  expect(result.current.loading).toBe(false); expect(result.current.stale).toBe(false);
});

it('marks disabled or stale lists without repeatedly inspecting the same IDs on recovery', async () => {
  const { result, rerender } = renderHook(useMountInventory, { initialProps: input() }); await flush();
  rerender(input({ enabled: false })); expect(result.current.stale).toBe(true);
  act(() => result.current.reload()); expect(read).toHaveBeenCalledTimes(1);
  rerender(input({ snapshot: { ...snapshot, stale: true } })); expect(result.current.stale).toBe(true);
  rerender(input()); await flush(); expect(result.current.stale).toBe(false); expect(read).toHaveBeenCalledTimes(1);
});

it('does not fetch an initially disabled or stale list', async () => {
  const { rerender } = renderHook(useMountInventory, { initialProps: input({ enabled: false }) });
  rerender(input({ snapshot: { ...snapshot, stale: true } })); await flush(); expect(read).not.toHaveBeenCalled();
  rerender(input()); await flush(); expect(read).toHaveBeenCalledOnce();
});

it('preserves a failed refresh as stale and retries ordinary failures only explicitly', async () => {
  const { result, rerender } = renderHook(useMountInventory, { initialProps: input() }); await flush();
  read.mockRejectedValueOnce({ code: 'TimedOut', message: 'timeout' });
  act(() => result.current.reload()); await flush();
  expect(result.current.error?.code).toBe('TimedOut'); expect(result.current.stale).toBe(true);
  rerender(input({ active: false })); rerender(input()); await flush(); expect(read).toHaveBeenCalledTimes(2);
  act(() => result.current.reload()); await flush(); expect(result.current.error).toBeNull(); expect(result.current.stale).toBe(false);
});

it('waits for inventory-set changes after a Core inventory-changed error instead of spinning', async () => {
  read.mockRejectedValueOnce({ code: 'MountInventoryChanged', message: 'changed' });
  const { result, rerender } = renderHook(useMountInventory, { initialProps: input() }); await flush();
  expect(result.current.error?.code).toBe('MountInventoryChanged');
  rerender(input({ snapshot: { ...snapshot, generation: 2 } })); await flush(); expect(read).toHaveBeenCalledTimes(1);
  const reduced = { ...snapshot, containers: [storageContainer] }; read.mockResolvedValue(storageFixture(reduced));
  rerender(input({ snapshot: reduced })); await flush(); expect(result.current.error).toBeNull(); expect(read).toHaveBeenCalledTimes(2);
});

it('routes late current-session Engine errors even after closing but ignores a replaced session', async () => {
  const pending = deferred<MountInventory>(); read.mockReturnValueOnce(pending.promise);
  const { rerender } = renderHook(useMountInventory, { initialProps: input() });
  rerender(input({ active: false })); await act(async () => pending.reject({ code: 'EnvironmentChanged', message: 'changed' }));
  expect(onError).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.objectContaining({ code: 'EnvironmentChanged' }), snapshot.sessionId);
  const other = deferred<MountInventory>(); read.mockReturnValueOnce(other.promise);
  rerender(input({ snapshot: { ...snapshot, sessionId: 'storage-two' } }));
  rerender(input({ snapshot: { ...snapshot, sessionId: 'storage-three' }, active: false }));
  await act(async () => other.reject({ code: 'EnvironmentChanged', message: 'old' }));
  expect(onError).toHaveBeenCalledTimes(1);
});

it('rejects a foreign or invalid response instead of showing sharing data', async () => {
  read.mockResolvedValueOnce({ ...storageFixture(), sessionId: 'foreign' });
  const { result } = renderHook(useMountInventory, { initialProps: input() }); await flush();
  expect(result.current.inventory).toBeNull(); expect(result.current.error?.code).toBe('InvalidMountResponse');
});

it('routes a late NeedsValidation error while reads are temporarily disabled', async () => {
  const pending = deferred<MountInventory>(); read.mockReturnValueOnce(pending.promise);
  const { rerender } = renderHook(useMountInventory, { initialProps: input() });
  rerender(input({ enabled: false }));
  await act(async () => pending.reject({ code: 'NeedsValidation', message: 'refresh or reconnect' }));
  expect(onError).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.objectContaining({ code: 'NeedsValidation' }), snapshot.sessionId);
});

it('accepts a partial result as known coverage and waits for manual refresh or an ID change', async () => {
  const partial = storageFixture(); partial.coverage = 'partial'; partial.containers[1] = { ...partial.containers[1]!, mountsAvailable: false, mounts: [] };
  read.mockResolvedValueOnce(partial);
  const { result, rerender } = renderHook(useMountInventory, { initialProps: input() }); await flush();
  expect(result.current.inventory?.coverage).toBe('partial'); expect(result.current.stale).toBe(false);
  rerender(input({ snapshot: { ...snapshot, generation: 4 } })); await flush(); expect(read).toHaveBeenCalledOnce();
  act(() => result.current.reload()); await flush(); expect(result.current.inventory?.coverage).toBe('complete');
});

it('rejects a Core inventory that advanced before the frontend and recovers after the list catches up', async () => {
  const added = { ...storageContainer, fullId: 'c'.repeat(64), handle: 'store-c' };
  const advanced = { ...snapshot, containers: [...snapshot.containers, added] };
  read.mockResolvedValue(storageFixture(advanced));
  const { result, rerender } = renderHook(useMountInventory, { initialProps: input() }); await flush();
  expect(result.current.inventory).toBeNull(); expect(result.current.error?.code).toBe('InvalidMountResponse');
  rerender(input({ snapshot: advanced })); await flush();
  expect(result.current.inventory?.containers).toHaveLength(3); expect(result.current.error).toBeNull(); expect(read).toHaveBeenCalledTimes(2);
});
