import type { Mocked } from 'vitest';
import { type api, type ContainerList, type RecentLogs } from '../api';
import { frontendError } from '../frontendErrors';

/** One finite stream for legacy App fixtures; native and controller tests cover continuing output. */
export function installSnapshotStreams(mock: Mocked<typeof api>) {
  let next = 0;
  const streams = new Map<string, RecentLogs>();
  mock.startLogStream.mockImplementation(async (sessionId, generation, handle) => {
    const inventory = mock.listContainers.mock.results.at(-1)?.value as Promise<ContainerList>;
    const logs = await mock.getRecentLogs(sessionId, handle);
    if (logs.sessionId !== sessionId || logs.generation !== generation || logs.handle !== handle) throw frontendError('staleLogs');
    const container = (await inventory).containers.find(item => item.handle === handle);
    if (!container) throw { code: 'StaleHandle', message: 'Fixture target was removed' };
    const streamId = `fixture-stream-${++next}`;
    streams.set(streamId, logs);
    return { sessionId, streamId, fullId: container.fullId };
  });
  mock.readLogStream.mockImplementation(async (sessionId, streamId) => {
    const logs = streams.get(streamId);
    return { sessionId, streamId, sequence: 1, text: logs?.text ?? '', truncated: logs?.truncated ?? false, terminal: true, error: null };
  });
  mock.stopLogStream.mockImplementation(async (_sessionId, streamId) => { streams.delete(streamId); });
  mock.getContainerStats.mockImplementation(async (sessionId, generation, handles) => {
    const list = await mock.listContainers.mock.results.at(-1)?.value as ContainerList;
    return { sessionId, generation, sampledAt: new Date().toISOString(), error: null,
      items: handles.map(handle => ({ handle, fullId: list.containers.find(item => item.handle === handle)!.fullId,
        cpuPercent: null, memoryUsage: null, memoryPercent: null, available: false })) };
  });
}
