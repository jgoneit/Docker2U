import { beforeEach, expect, it, vi } from 'vitest';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { mountApi, mountKey, validateMountInventory, type MountInventory } from './mountApi';
import { storageFixture, storageSnapshot, volumeMount } from './test/storageFixtures';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: vi.fn(() => true) }));
beforeEach(() => { vi.clearAllMocks(); vi.mocked(isTauri).mockReturnValue(true); });
const validate = (value: MountInventory) => validateMountInventory(value, storageSnapshot.sessionId, storageSnapshot.containers.map(container => container.fullId));

it('uses only typed session and refresh inputs on the mount IPC', async () => {
  vi.mocked(invoke).mockResolvedValue(storageFixture());
  await expect(mountApi.getInventory('session', true)).resolves.toEqual(storageFixture());
  expect(invoke).toHaveBeenCalledExactlyOnceWith('get_mount_inventory', { sessionId: 'session', refresh: true });
});
it('requires the native runtime', async () => {
  vi.mocked(isTauri).mockReturnValue(false);
  await expect(mountApi.getInventory('session', false)).rejects.toMatchObject({ code: 'NATIVE_REQUIRED' });
  expect(invoke).not.toHaveBeenCalled();
});
it('preserves null paths and access without inferring read-write or sharing', () => {
  const value = storageFixture(); value.containers[0]!.mounts = [{ type: 'bind', source: null, destination: null, volumeName: null, readOnly: null }];
  expect(validate(value).containers[0]!.mounts[0]).toEqual({ type: 'bind', source: null, destination: null, volumeName: null, readOnly: null });
});
it('turns omitted or unavailable containers into partial coverage rather than empty successful reads', () => {
  const value = storageFixture(); value.containers.pop();
  expect(validate(value)).toMatchObject({ coverage: 'partial', containers: [{ mountsAvailable: true }, { mountsAvailable: false, mounts: [] }] });
  const unavailable = storageFixture(); unavailable.containers[0] = { ...unavailable.containers[0]!, mountsAvailable: false, mounts: [] };
  expect(validate(unavailable).coverage).toBe('partial');
});
it.each(['session', 'time', 'foreign-id', 'duplicate-id', 'bad-array', 'unavailable-with-mounts', 'access-string', 'missing-field'])('rejects malformed %s mount responses', kind => {
  const value = storageFixture();
  if (kind === 'session') value.sessionId = 'foreign';
  if (kind === 'time') value.observedAt = 'not a date';
  if (kind === 'foreign-id') value.containers[0]!.fullId = 'foreign';
  if (kind === 'duplicate-id') value.containers[1]!.fullId = value.containers[0]!.fullId;
  if (kind === 'bad-array') value.containers[0]!.mounts = null as unknown as [];
  if (kind === 'unavailable-with-mounts') value.containers[0]!.mountsAvailable = false;
  if (kind === 'access-string') value.containers[0]!.mounts[0]!.readOnly = 'false' as unknown as boolean;
  if (kind === 'missing-field') delete (value.containers[0]!.mounts[0] as Partial<typeof volumeMount>).source;
  expect(() => validate(value)).toThrow(expect.objectContaining({ code: 'InvalidMountResponse' }));
});
it('groups volumes by name and bind mounts by exact source only', () => {
  expect(mountKey(volumeMount, 'one', 0)).toBe(mountKey({ ...volumeMount, source: '/different/path' }, 'two', 5));
  expect(mountKey(volumeMount, 'one', 0)).not.toBe(mountKey({ ...volumeMount, volumeName: 'another-volume' }, 'two', 0));
  const bind = { ...volumeMount, type: 'bind', source: '/data', volumeName: null };
  expect(mountKey(bind, 'one', 0)).toBe(mountKey(bind, 'two', 1));
  expect(mountKey(bind, 'one', 0)).not.toBe(mountKey({ ...bind, source: '/data/' }, 'two', 0));
  expect(mountKey(bind, 'one', 0)).not.toBe(mountKey({ ...bind, source: '/data/child' }, 'two', 0));
});
it.each(['tmpfs', 'unknown'])('does not claim shared identity for %s', type => {
  const mount = { ...volumeMount, type };
  expect(mountKey(mount, 'one', 0)).not.toBe(mountKey(mount, 'two', 0));
});
