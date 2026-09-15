import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api, type ContainerList } from '../api';
import { imageExportApi } from '../imageExportApi';
import { mountApi } from '../mountApi';
import { observationApi, projectLogApi } from '../observationApi';
import { installObservationFixture } from './observationFixture';
import { installImageExportFixture } from './imageExportFixture';
import { installMountFixture } from './mountFixture';
import { exportInventory } from './imageExportData';

const originals = { api: { ...api }, observation: { ...observationApi }, logs: { ...projectLogApi }, exports: { ...imageExportApi }, mounts: { ...mountApi } };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function snapshot(generation: number, sessionId = 'session-1'): ContainerList {
  return { ...exportInventory, sessionId, generation, containers: exportInventory.containers.map(container => ({ ...container, handle: `${sessionId}-g${generation}`, composeProject: 'orders' })) };
}
function install() { installObservationFixture(); installMountFixture(); installImageExportFixture(); }
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-13T00:00:00Z')); });
afterEach(() => {
  Object.assign(api, originals.api); Object.assign(observationApi, originals.observation); Object.assign(projectLogApi, originals.logs); Object.assign(imageExportApi, originals.exports); Object.assign(mountApi, originals.mounts);
  vi.restoreAllMocks(); vi.useRealTimers();
});

it('shares a deferred initial list between observation and logs so the observed generation can prepare an export', async () => {
  const requests: ReturnType<typeof deferred<ContainerList>>[] = [];
  const list = vi.fn(() => { const request = deferred<ContainerList>(); requests.push(request); return request.promise; }); api.listContainers = list;
  install();
  const observed = observationApi.configure('session-1', { kind: 'all' });
  const logs = projectLogApi.configure('session-1', 'orders', null);
  requests[0]!.resolve(snapshot(1)); const result = await observed;
  // A second independent initialization used to advance the Engine generation
  // after the view received generation 1, rejecting export until the next poll.
  requests[1]?.resolve(snapshot(2)); await logs;
  const current = result.inventory!;
  await expect(imageExportApi.prepare(current.sessionId, current.generation, current.containers[0]!.handle)).resolves.toMatchObject({ containerId: current.containers[0]!.fullId });
  expect(list).toHaveBeenCalledTimes(1);
});

it('refreshes after three seconds, shares an in-flight refresh, and suspends periodic collection while held', async () => {
  let generation = 0; const list = vi.fn(async (sessionId: string) => snapshot(++generation, sessionId)); api.listContainers = list; install();
  await observationApi.configure('session-1', { kind: 'all' });
  await vi.advanceTimersByTimeAsync(3000); await observationApi.read('session-1', 0); expect(list).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  const pending = deferred<ContainerList>(); list.mockReturnValueOnce(pending.promise);
  const read = observationApi.read('session-1', 0), logs = projectLogApi.configure('session-1', 'orders', null);
  expect(list).toHaveBeenCalledTimes(2); pending.resolve(snapshot(++generation)); await Promise.all([read, logs]);
  const hold = await observationApi.hold('session-1'); expect(hold.inventory.generation).toBe(3);
  await vi.advanceTimersByTimeAsync(4000); await observationApi.read('session-1', 0); expect(list).toHaveBeenCalledTimes(3);
  await observationApi.release('session-1', hold.holdId); await observationApi.read('session-1', 0); expect(list).toHaveBeenCalledTimes(4);
});

it('does not let an old deferred session overwrite the new session inventory cache', async () => {
  const old = deferred<ContainerList>(), current = deferred<ContainerList>();
  const list = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise); api.listContainers = list; installObservationFixture();
  const older = observationApi.configure('session-1', { kind: 'all' });
  const newer = observationApi.configure('session-2', { kind: 'all' });
  current.resolve(snapshot(1, 'session-2')); await newer;
  old.resolve(snapshot(99, 'session-1')); await older;
  const next = await observationApi.read('session-2', 0);
  expect(next.inventory?.sessionId).toBe('session-2'); expect(next.inventory?.generation).toBe(1); expect(list).toHaveBeenCalledTimes(2);
});
