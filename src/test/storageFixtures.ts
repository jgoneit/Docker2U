import type { Container, ContainerList } from '../api';
import type { ContainerMount, MountInventory } from '../mountApi';

export const storageContainer: Container = { handle: 'store-a', fullId: 'a'.repeat(64), shortId: 'a'.repeat(12), name: 'database', image: 'postgres:17', state: 'exited', health: null, healthConfigured: false,
  ports: [], createdAt: '', composeProject: 'orders', composeService: 'db' };
export const storageOther: Container = { ...storageContainer, handle: 'store-b', fullId: 'b'.repeat(64), shortId: 'b'.repeat(12), name: 'backup', composeProject: 'backups', composeService: 'backup' };
export const storageSnapshot: ContainerList = { sessionId: 'storage-one', generation: 1, containers: [storageContainer, storageOther], refreshedAt: '2026-09-13T00:00:00Z', stale: false };
export const volumeMount: ContainerMount = { type: 'volume', volumeName: 'orders_data', source: '/var/lib/docker/volumes/orders_data/_data', destination: '/var/lib/postgresql/data', readOnly: false };
export function storageFixture(snapshot = storageSnapshot): MountInventory {
  return { sessionId: snapshot.sessionId, observedAt: '2026-09-13T00:00:05Z', coverage: 'complete', containers: snapshot.containers.map(container => ({ fullId: container.fullId, mountsAvailable: true,
    mounts: [{ ...volumeMount, destination: container.fullId === storageContainer.fullId ? volumeMount.destination : '/backup/source', readOnly: container.fullId !== storageContainer.fullId }] })) };
}
