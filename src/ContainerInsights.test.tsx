import { fireEvent, render, screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { ContainerInsights, connectionCandidate, type ContainerInsightsProps } from './ContainerInsights';
import { PreferencesProvider } from './preferences';
import { containerDetailsFixture } from './test/containerDetailsFixture';

const view = (props: Partial<ContainerInsightsProps> = {}, language: 'ko' | 'en' = 'en') => render(<PreferencesProvider initialPreferences={{ theme: 'dark', language }}><ContainerInsights
  tab="diagnostics" details={containerDetailsFixture()} loading={false} error={null} stale={false} reload={() => {}} copy={() => {}} {...props} /></PreferencesProvider>);

it('does not infer OOM from exit 137 and distinguishes unknown values from zero or false', () => {
  const details = containerDetailsFixture();
  details.diagnostics.restartCount = null; details.diagnostics.finishedAt = null;
  view({ details });
  expect(screen.getByText('137')).toBeVisible();
  expect(screen.getByText('No OOM termination reported by Engine')).toBeVisible();
  expect(screen.getByText('Exit code 137 alone does not establish an out-of-memory termination.')).toBeVisible();
  expect(screen.queryByText('Engine reported an OOM termination')).not.toBeInTheDocument();
  expect(screen.getAllByText('Unavailable')).toHaveLength(2);
});

it('reports OOM only from the explicit Engine flag and preserves zero counters', () => {
  const details = containerDetailsFixture(); details.diagnostics.oomKilled = true; details.diagnostics.restartCount = 0;
  view({ details });
  expect(screen.getByText('Engine reported an OOM termination')).toBeVisible();
  expect(screen.getByText('0')).toBeVisible();
  expect(screen.queryByText(/Exit code 137 alone/)).not.toBeInTheDocument();
});

it.each(['ko', 'en'] as const)('distinguishes unavailable health, unconfigured checks, no results and unknown configuration in %s', language => {
  const details = containerDetailsFixture(); details.diagnostics.healthAvailable = false;
  const { unmount } = view({ details }, language);
  expect(screen.getByText(language === 'ko' ? '상태 검사 정보를 조회할 수 없습니다.' : 'Health check information is unavailable.')).toBeVisible();
  expect(screen.queryByText(language === 'ko' ? '상태 검사 기록이 없습니다. 검사가 없거나 아직 시작되지 않았을 수 있습니다.' : 'No health check state has been recorded. A check may be absent or not started yet.')).not.toBeInTheDocument();
  unmount(); details.diagnostics.healthAvailable = true;
  const second = view({ details }, language);
  expect(screen.getByText(language === 'ko' ? '상태 검사가 설정되어 있지만 아직 결과가 없습니다.' : 'A health check is configured, but no results are available yet.')).toBeVisible();
  second.unmount(); details.diagnostics.healthConfigured = false;
  const third = view({ details }, language);
  expect(screen.getByText(language === 'ko' ? '상태 검사가 설정되어 있지 않습니다.' : 'No health check is configured.')).toBeVisible();
  third.unmount(); details.diagnostics.healthConfigured = null;
  const fourth = view({ details }, language);
  expect(screen.getByText(language === 'ko' ? '상태 검사 기록이 없습니다. 검사가 없거나 아직 시작되지 않았을 수 있습니다.' : 'No health check state has been recorded. A check may be absent or not started yet.')).toBeVisible();
  fourth.unmount(); details.diagnostics.healthConfigured = true; details.diagnostics.health = { status: 'healthy', failingStreak: 0, recentFailures: [] };
  view({ details }, language);
  expect(screen.getByText(language === 'ko' ? 'Engine에 남은 기록에 실패한 검사가 없습니다.' : 'No failed checks in the records retained by Engine.')).toBeVisible();
});

it('renders retained health output as plain text and copies only the displayed bounded output', () => {
  const details = containerDetailsFixture(); const output = '<img src=x onerror=alert(1)> connection refused'; const copy = vi.fn();
  details.diagnostics.health = { status: 'unhealthy', failingStreak: 2, recentFailures: [{ startedAt: null, finishedAt: '2026-09-08T02:59:00Z', exitCode: 1, output, truncated: true }] };
  const { container } = view({ details, copy });
  expect(screen.getByText(output)).not.toBeVisible();
  fireEvent.click(screen.getByText('View check output'));
  expect(screen.getByText(output)).toBeVisible(); expect(container.querySelector('img')).toBeNull();
  expect(screen.getByText('Output was truncated; only part is shown.')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Copy check output' }));
  expect(copy).toHaveBeenCalledExactlyOnceWith(output, 'healthOutput');
});

it('separates exact Engine bindings from unverified Mac candidates and never copies wildcard addresses', () => {
  const copy = vi.fn();
  view({ tab: 'connectivity', copy });
  expect(within(screen.getByRole('region', { name: 'Connect from the host' })).getByText('5432/TCP')).toBeVisible();
  expect(screen.getByText('0.0.0.0:15432')).toBeVisible(); expect(screen.getByText('[::]:15432')).toBeVisible();
  expect(screen.getAllByText('Connection candidate · reachability from Mac unverified')).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: 'Copy address: 127.0.0.1:15432' }));
  fireEvent.click(screen.getByRole('button', { name: 'Copy address: [::1]:15432' }));
  expect(copy.mock.calls).toEqual([['127.0.0.1:15432', 'address'], ['[::1]:15432', 'address']]);
  expect(screen.queryByRole('button', { name: /Copy address: (0\.0\.0\.0|\[::\])/ })).not.toBeInTheDocument();
  expect(screen.queryByRole('link')).not.toBeInTheDocument();
});

it('preserves UDP, unpublished ports and actual network aliases without inventing a connection string', () => {
  const details = containerDetailsFixture(); details.connectivity.ports = [
    { containerPort: 5353, protocol: 'udp', bindings: [{ hostIp: '2001:db8::3', hostPort: 15353 }] },
    { containerPort: 8080, protocol: 'tcp', bindings: [] },
    { containerPort: 3000, protocol: 'tcp', bindings: [{ hostIp: '127.0.0.1', hostPort: null }] },
  ];
  view({ tab: 'connectivity', details });
  const ports = screen.getByRole('region', { name: 'Connect from the host' });
  expect(within(ports).getByText('5353/UDP')).toBeVisible(); expect(within(ports).getByText('8080/TCP')).toBeVisible();
  expect(screen.getByText('Not published to the host')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Copy address: [2001:db8::3]:15353' })).toBeVisible();
  const networks = screen.getByRole('region', { name: 'Connect from a container on the same network' });
  expect(within(networks).getByText('postgres-primary')).toBeVisible(); expect(within(networks).getByText('database')).toBeVisible();
  expect(within(networks).queryByText('orders_database')).not.toBeInTheDocument();
  expect(within(screen.getByRole('region', { name: 'Connect from the host' })).getAllByRole('button', { name: /Copy address/ })).toHaveLength(1);
});

it('copies observed aliases or IPv6 with one selected container port without multiplying every alias by every port', () => {
  const details = containerDetailsFixture(); const copy = vi.fn();
  details.connectivity.networks[0]!.ipv6Address = 'fd00::2';
  details.connectivity.ports.push({ containerPort: 5433, protocol: 'tcp', bindings: [] });
  view({ tab: 'connectivity', details, copy });
  const networks = screen.getByRole('region', { name: 'Connect from a container on the same network' });
  fireEvent.click(within(networks).getByRole('button', { name: 'Copy address: postgres-primary' }));
  fireEvent.change(screen.getByLabelText('Port for container-network addresses'), { target: { value: '5432/tcp' } });
  fireEvent.click(within(networks).getByRole('button', { name: 'Copy address: postgres-primary:5432' }));
  fireEvent.click(within(networks).getByRole('button', { name: 'Copy address: [fd00::2]:5432' }));
  expect(copy.mock.calls).toEqual([['postgres-primary', 'address'], ['postgres-primary:5432', 'address'], ['[fd00::2]:5432', 'address']]);
  expect(within(networks).getAllByRole('button', { name: /Copy address/ })).toHaveLength(4);
  expect(within(networks).queryByText('postgres-primary:5433')).not.toBeInTheDocument();
});

it('never offers unspecified internal IPs or aliases as copyable addresses', () => {
  const details = containerDetailsFixture(); details.connectivity.networks[0] = {
    name: 'orders_default', aliases: ['::', '::0', '0000::', '0.0.0.0', 'postgres-primary'], ipv4Address: '0.0.0.0', ipv6Address: '0:0:0:0:0:0:0:0',
  };
  view({ tab: 'connectivity', details });
  const networks = screen.getByRole('region', { name: 'Connect from a container on the same network' });
  expect(within(networks).getAllByRole('button', { name: /Copy address/ })).toHaveLength(1);
  fireEvent.change(screen.getByLabelText('Port for container-network addresses'), { target: { value: '5432/tcp' } });
  expect(within(networks).getAllByRole('button', { name: /Copy address/ })).toHaveLength(1);
  expect(within(networks).getByRole('button', { name: 'Copy address: postgres-primary:5432' })).toBeVisible();
});

it.each(['host', 'none', 'container:0123456789abcdef'])('explains special network mode %s and marks missing sections as unavailable', networkMode => {
  const details = containerDetailsFixture(); details.connectivity = { networkMode, portsAvailable: false, networksAvailable: false, ports: [], networks: [] };
  view({ tab: 'connectivity', details });
  expect(screen.getByText(networkMode)).toBeVisible();
  expect(screen.getByText('Port information is unavailable.')).toBeVisible(); expect(screen.getByText('Network information is unavailable.')).toBeVisible();
  expect(screen.queryByText('Engine reported no ports.')).not.toBeInTheDocument();
  expect(screen.getByText(networkMode === 'host' ? /Shares the Engine host/ : networkMode === 'none' ? /Networking is disabled/ : /Shares another container/)).toBeVisible();
});

it.each(['host', 'none', 'container:0123456789abcdef'])('suppresses ordinary connection candidates for %s even when Engine includes bindings', networkMode => {
  const details = containerDetailsFixture(); details.connectivity.networkMode = networkMode;
  view({ tab: 'connectivity', details });
  expect(screen.getByText('0.0.0.0:15432')).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Copy address: 127.0.0.1:15432' })).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Port for container-network addresses')).not.toBeInTheDocument();
});

it('keeps observation time and stale/error state visible and disables reload during blocked work', () => {
  const reload = vi.fn();
  view({ stale: true, error: { code: 'TimedOut', message: 'read timed out' }, disabled: true, reload });
  expect(screen.getByText('Previous observations. Reload to check the current state.')).toBeVisible();
  expect(screen.getByRole('alert')).toHaveTextContent('Could not load container details.');
  expect(screen.getByText(/Observed at/).querySelector('time')).toHaveAttribute('datetime', '2026-09-08T03:00:10Z');
  expect(screen.getByRole('button', { name: 'Reload details' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Reload details' })); expect(reload).not.toHaveBeenCalled();
});

it.each([
  ['::', 5432, '[::1]:5432'], ['0:0:0:0:0:0:0:0', 5432, '[::1]:5432'],
  ['::0', 5432, '[::1]:5432'], ['0000::', 5432, '[::1]:5432'],
  ['[::1]', 5432, '[::1]:5432'], ['127.0.0.1', 5432, '127.0.0.1:5432'],
  ['', 5432, null], ['127.0.0.1', null, null], ['127.0.0.1', 0, null], ['127.0.0.1', 65536, null],
] as const)('formats only usable candidate host/port values (%s, %s)', (hostIp, hostPort, expected) => {
  expect(connectionCandidate({ hostIp, hostPort })).toBe(expected);
});
