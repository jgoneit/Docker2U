import { api, type ContainerList } from '../api';
import { mountApi, type ContainerMount } from '../mountApi';

/** Development-only mount metadata, never native IPC or filesystem access. */
export function installMountFixture() {
  let snapshot: ContainerList | null = null;
  let mode = new URLSearchParams(location.search).get('mountMode') ?? 'complete';
  let calls = 0;
  const list = api.listContainers;
  api.listContainers = async id => { const result = await list(id); snapshot = result; return result; };
  const bindSource = '/synthetic/설정 폴더/' + 'long-config-directory-'.repeat(8) + '/settings.yaml';
  const bind = (destination: string): ContainerMount => ({ type: 'bind', source: bindSource, destination, readOnly: true, volumeName: null });
  const volume = (readOnly: boolean): ContainerMount => ({ type: 'volume', source: '/var/lib/docker/volumes/shared-data/_data', destination: '/data', readOnly, volumeName: 'shared-data' });
  mountApi.getInventory = async (sessionId, _refresh) => {
    ++calls;
    if (mode === 'failed') throw { code: 'MountReadFailed', message: 'Synthetic mount metadata read failed.' };
    if (!snapshot || snapshot.sessionId !== sessionId) throw { code: 'StaleSession', message: 'Synthetic mount session changed.' };
    return { sessionId, observedAt: new Date().toISOString(), coverage: mode === 'partial' ? 'partial' : 'complete',
      containers: snapshot.containers.map((container, index) => {
        const available = !(mode === 'partial' && index === 2);
        return { fullId: container.fullId, mountsAvailable: available,
          mounts: !available || mode === 'empty' ? [] : index === 0 ? [volume(false), bind('/app/settings.yaml')]
            : index === 1 ? [volume(true), { type: 'tmpfs', source: null, destination: '/tmp', readOnly: false, volumeName: null }]
            : index === 2 ? [bind('/worker/settings.yaml')] : [] };
      }) };
  };
  Object.assign(window, { __docker2uMountFixture: { get calls() { return calls; }, setMode(value: string) { mode = value; }, bindSource } });
}
