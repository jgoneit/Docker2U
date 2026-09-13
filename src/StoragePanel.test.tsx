import { fireEvent, render, screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { StoragePanel, type StoragePanelProps } from './StoragePanel';
import { mountKey } from './mountApi';
import { PreferencesProvider } from './preferences';
import { storageContainer, storageFixture, storageOther, storageSnapshot, volumeMount } from './test/storageFixtures';

const defaults: StoragePanelProps = { inventory: storageFixture(), error: null, loading: false, stale: false, reload: () => {}, containers: storageSnapshot.containers,
  target: { kind: 'container', fullId: storageContainer.fullId }, onNavigate: () => {}, copy: () => {} };
const view = (props: Partial<StoragePanelProps> = {}, language: 'ko' | 'en' = 'en') => render(<PreferencesProvider initialPreferences={{ theme: 'dark', language }}><StoragePanel {...defaults} {...props} /></PreferencesProvider>);

it('shows actual volume identity, Engine data path, destination and access for a stopped container', () => {
  view();
  expect(screen.getByText('orders_data')).toBeVisible();
  expect(screen.getByText('/var/lib/docker/volumes/orders_data/_data')).toBeVisible();
  expect(screen.getByText('Engine data path')).toBeVisible();
  expect(screen.getAllByText('/var/lib/postgresql/data')[0]).toBeVisible();
  expect(screen.getAllByText('Read / write')[0]).toBeVisible();
  expect(screen.getByText(/Source and volume data paths belong to the Engine host or VM/)).toBeVisible();
  expect(screen.getByText('Observed at').parentElement?.querySelector('time')).toHaveAttribute('datetime', '2026-09-13T00:00:05Z');
});
it('opens cross-project usage with each destination and RO/RW then navigates by exact ID and mount key', () => {
  const onNavigate = vi.fn(); view({ onNavigate });
  expect(screen.getByText('backup')).not.toBeVisible();
  fireEvent.click(screen.getByText('View 2 using containers'));
  expect(screen.getByText('backup')).toBeVisible(); expect(screen.getByText(/backups \/ backup/)).toBeVisible();
  expect(screen.getByText('/backup/source')).toBeVisible(); expect(screen.getByText('Read only')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Open storage for backup' }));
  expect(onNavigate).toHaveBeenCalledExactlyOnceWith(storageOther.fullId, mountKey(volumeMount, storageOther.fullId, 0));
});
it('groups actual project storage and includes other projects only in usage disclosure', () => {
  const secondReplica = { ...storageOther, composeProject: 'orders', composeService: 'db', name: 'database-2' };
  const containers = [storageContainer, secondReplica, { ...storageOther, fullId: 'c'.repeat(64), name: 'archive' }];
  const inventory = storageFixture({ ...storageSnapshot, containers });
  const { container } = view({ inventory, containers, target: { kind: 'project', name: 'orders' } });
  expect(container.querySelectorAll('.storage-mount')).toHaveLength(1);
  expect(screen.getAllByText('database')[0]).toBeVisible(); expect(screen.getAllByText('database-2')[0]).toBeVisible(); expect(screen.getByText('archive')).not.toBeVisible();
  fireEvent.click(screen.getByText('View 3 using containers')); expect(screen.getByText('archive')).toBeVisible();
});
it('keeps repeated destinations for the same storage as separate container mount rows', () => {
  const inventory = storageFixture(); inventory.containers[0]!.mounts.push({ ...volumeMount, destination: '/second' });
  const { container } = view({ inventory });
  expect(container.querySelectorAll('.storage-mount')).toHaveLength(2); expect(within(container.querySelectorAll('.storage-mount')[1] as HTMLElement).getAllByText('/second')[0]).toBeVisible();
});
it('renders bind and tmpfs and leaves missing access unknown without inventing sharing', () => {
  const inventory = storageFixture(); inventory.containers[0]!.mounts = [
    { type: 'bind', source: '/data/config', destination: '/etc/config', volumeName: null, readOnly: true },
    { type: 'tmpfs', source: '', destination: '/tmp', volumeName: null, readOnly: null },
    { type: 'bind', source: null, destination: null, volumeName: null, readOnly: null },
  ];
  view({ inventory });
  expect(screen.getAllByText('/data/config')[0]).toBeVisible(); expect(screen.getByText('Container-local memory')).toBeVisible();
  expect(screen.getAllByText('Read-only setting unavailable')).toHaveLength(2);
  expect(screen.getByText('This mount is not assumed to identify shared storage.')).toBeVisible();
  expect(screen.getByText('Sharing relationship unavailable')).toBeVisible();
  expect(screen.getAllByText('View 1 using containers')).toHaveLength(1);
});
it('copies only the exact observed path and treats hostile names as text', () => {
  const copy = vi.fn(); const inventory = storageFixture(); const source = '/data/<img src=x onerror=alert(1)>'; inventory.containers[0]!.mounts[0]!.source = source;
  const { container } = view({ inventory, copy });
  fireEvent.click(screen.getByRole('button', { name: `Copy ${source}` }));
  expect(copy).toHaveBeenCalledExactlyOnceWith(source); expect(container.querySelector('img')).toBeNull();
});
it.each(['ko', 'en'] as const)('distinguishes no containers, no mounts and unavailable mounts in %s', language => {
  const first = view({ target: { kind: 'project', name: 'registered-not-started' } }, language);
  expect(screen.getByText(language === 'ko' ? '이 프로젝트의 실제 컨테이너가 없어 연결된 저장소를 확인할 수 없습니다.' : 'This project has no observed containers, so actual storage mounts are not available yet.')).toBeVisible(); first.unmount();
  const inventory = storageFixture(); inventory.containers[0]!.mounts = [];
  const second = view({ inventory }, language);
  expect(screen.getByText(language === 'ko' ? 'Engine에서 보고한 마운트가 없습니다.' : 'Engine reported no mounts.')).toBeVisible(); second.unmount();
  inventory.containers[0]!.mountsAvailable = false; inventory.coverage = 'partial';
  view({ inventory }, language);
  expect(screen.getByText(language === 'ko' ? 'database: 마운트 정보를 조회할 수 없습니다.' : 'database: mount information is unavailable.')).toBeVisible();
  expect(screen.queryByText(language === 'ko' ? 'Engine에서 보고한 마운트가 없습니다.' : 'Engine reported no mounts.')).not.toBeInTheDocument();
});
it('shows partial sharing, stale and failure separately and disables stale navigation', () => {
  const inventory = storageFixture(); inventory.coverage = 'partial';
  view({ inventory, stale: true, error: { code: 'TimedOut', message: 'timeout' } });
  expect(screen.getByText(/Additional containers may share/)).toBeVisible(); expect(screen.getByText(/Previous observations/)).toBeVisible(); expect(screen.getByRole('alert')).toHaveTextContent('Could not load storage mounts.');
  fireEvent.click(screen.getByText('View 2 using containers'));
  expect(screen.getByRole('button', { name: 'Open storage for backup' })).toBeDisabled();
});
it('separates loading, no observations, removed container and manual reload', () => {
  const first = view({ inventory: null, loading: true }); expect(screen.getByRole('status')).toHaveTextContent('Loading storage mounts.'); expect(screen.getByRole('button', { name: 'Refresh storage' })).toBeDisabled(); first.unmount();
  const reload = vi.fn(); const second = view({ inventory: null, reload }); expect(screen.getByText('No storage observations collected.')).toBeVisible(); fireEvent.click(screen.getByRole('button', { name: 'Refresh storage' })); expect(reload).toHaveBeenCalledOnce(); second.unmount();
  view({ target: { kind: 'container', fullId: 'removed' } }); expect(screen.getByText('This container is no longer in the current list.')).toBeVisible();
});
it('highlights the same mount without taking focus from the tab when the panel remounts', () => {
  const selected = { ...defaults, target: { kind: 'container' as const, fullId: storageOther.fullId }, highlightMountKey: mountKey(volumeMount, storageOther.fullId, 0) };
  const surface = (active: boolean) => <PreferencesProvider initialPreferences={{ theme: 'dark', language: 'en' }}>
    <button autoFocus>Storage tab</button>{active && <StoragePanel {...selected} />}
  </PreferencesProvider>;
  const { container, rerender } = render(surface(true));
  const tab = screen.getByRole('button', { name: 'Storage tab' });
  expect(tab).toHaveFocus();
  const highlighted = container.querySelector('.storage-mount[data-highlighted="true"]');
  expect(within(highlighted as HTMLElement).getAllByText('/backup/source')[0]).toBeVisible();
  rerender(surface(false)); rerender(surface(true));
  expect(tab).toHaveFocus(); expect(container.querySelector('.storage-mount[data-highlighted="true"]')).toBeVisible();
});

it.each([
  ['volume', 'ko'], ['volume', 'en'], ['bind', 'ko'], ['bind', 'en'],
] as const)('marks %s sharing as unknown when its identity is absent in %s while retaining tmpfs meaning', (type, language) => {
  const inventory = storageFixture();
  inventory.containers[0]!.mounts = [
    { type, source: null, volumeName: null, destination: '/data', readOnly: null },
    { type: 'tmpfs', source: null, volumeName: null, destination: '/tmp', readOnly: false },
  ];
  const { container } = view({ inventory }, language);
  const mounts = container.querySelectorAll('.storage-mount');
  expect(within(mounts[0] as HTMLElement).getByText(language === 'ko' ? '공유 관계 확인 불가' : 'Sharing relationship unavailable')).toBeVisible();
  expect(within(mounts[0] as HTMLElement).queryByText(language === 'ko' ? '컨테이너 전용 메모리' : 'Container-local memory')).not.toBeInTheDocument();
  expect(within(mounts[1] as HTMLElement).getByText(language === 'ko' ? '컨테이너 전용 메모리' : 'Container-local memory')).toBeVisible();
  expect(within(mounts[1] as HTMLElement).queryByText(language === 'ko' ? '공유 관계 확인 불가' : 'Sharing relationship unavailable')).not.toBeInTheDocument();
  expect(screen.queryByText(/using containers|사용 컨테이너/)).not.toBeInTheDocument();
});
