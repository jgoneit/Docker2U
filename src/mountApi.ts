import { invoke, isTauri } from '@tauri-apps/api/core';
import { frontendError } from './frontendErrors';

export interface ContainerMount {
  type: string;
  source: string | null;
  destination: string | null;
  readOnly: boolean | null;
  volumeName: string | null;
}
export interface MountInventory {
  sessionId: string;
  observedAt: string;
  coverage: 'complete' | 'partial';
  containers: { fullId: string; mountsAvailable: boolean; mounts: ContainerMount[] }[];
}
export const mountApi = {
  getInventory: (sessionId: string, refresh: boolean) => {
    if (!isTauri()) return Promise.reject(frontendError('nativeRequired'));
    return invoke<MountInventory>('get_mount_inventory', { sessionId, refresh });
  },
};

/** Check observed identity before displaying sharing relationships. */
export function validateMountInventory(value: MountInventory, sessionId: string, ids: string[]): MountInventory {
  const invalid = (): never => { throw { code: 'InvalidMountResponse', message: 'Storage observations do not match the current container inventory.' }; };
  if (!value || value.sessionId !== sessionId || typeof value.observedAt !== 'string' || !Number.isFinite(Date.parse(value.observedAt))
    || !['complete', 'partial'].includes(value.coverage) || !Array.isArray(value.containers)) return invalid();
  const expected = new Set(ids);
  const seen = new Set<string>();
  const nullableString = (item: unknown) => item === null || typeof item === 'string';
  for (const item of value.containers) {
    if (!item || !expected.has(item.fullId) || seen.has(item.fullId) || typeof item.mountsAvailable !== 'boolean' || !Array.isArray(item.mounts)) return invalid();
    seen.add(item.fullId);
    if (!item.mountsAvailable && item.mounts.length) return invalid();
    for (const mount of item.mounts) {
      if (!mount || typeof mount.type !== 'string' || !nullableString(mount.source) || !nullableString(mount.destination)
        || !nullableString(mount.volumeName) || (mount.readOnly !== null && typeof mount.readOnly !== 'boolean')) return invalid();
    }
  }
  // A bounded query may omit containers. Treat those as unavailable, never as empty mounts.
  const missing = ids.filter(id => !seen.has(id)).map(fullId => ({ fullId, mountsAvailable: false, mounts: [] }));
  return { ...value, coverage: missing.length || value.containers.some(item => !item.mountsAvailable) ? 'partial' : value.coverage,
    containers: [...value.containers, ...missing] };
}

/** Only Engine-reported exact identities are shared. Unknown and tmpfs mounts remain local. */
export function mountKey(mount: ContainerMount, fullId: string, index: number): string {
  if (mount.type === 'volume' && mount.volumeName) return JSON.stringify(['volume', mount.volumeName]);
  if (mount.type === 'bind' && mount.source) return JSON.stringify(['bind', mount.source]);
  return JSON.stringify(['container', fullId, mount.type, mount.destination, index]);
}
