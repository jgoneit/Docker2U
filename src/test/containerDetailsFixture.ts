import type { Container, ContainerList } from '../api';
import type { ContainerDetails } from '../containerDetailsTypes';

export const detailsContainer: Container = { handle: 'details-a', fullId: 'a'.repeat(64), shortId: 'a'.repeat(12), name: 'database',
  image: 'postgres:17', state: 'exited', health: null, ports: [], createdAt: '', composeProject: 'orders', composeService: 'database' };
export const detailsSnapshot: ContainerList = { sessionId: 'one', generation: 1, containers: [detailsContainer], refreshedAt: '2026-09-08T03:00:00Z', stale: false };
export function containerDetailsFixture(container = detailsContainer, snapshot = detailsSnapshot): ContainerDetails {
  return { sessionId: snapshot.sessionId, generation: snapshot.generation, handle: container.handle, fullId: container.fullId, observedAt: '2026-09-08T03:00:10Z',
    diagnostics: { state: 'exited', exitCode: 137, startedAt: '2026-09-08T02:00:00Z', finishedAt: '2026-09-08T02:59:00Z', oomKilled: false,
      restartCount: 3, healthAvailable: true, healthConfigured: true, health: null },
    connectivity: { networkMode: 'orders_default', portsAvailable: true, networksAvailable: true,
      ports: [{ containerPort: 5432, protocol: 'tcp', bindings: [{ hostIp: '0.0.0.0', hostPort: 15432 }, { hostIp: '::', hostPort: 15432 }] }],
      networks: [{ name: 'orders_default', aliases: ['database', 'postgres-primary'], ipv4Address: '172.18.0.2', ipv6Address: null }] },
  };
}
