import { beforeEach, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ContainerTerminal } from './ContainerTerminal';
import { TerminalRegistry, type TerminalView } from './terminalRegistry';
import { PreferencesProvider } from './preferences';
import type { Container, ContainerList } from './api';
const container: Container = { handle: 'opaque-a', fullId: 'a'.repeat(64), shortId: 'a'.repeat(12), name: 'api', state: 'running', health: null, healthConfigured: false, image: 'fixture', ports: [], createdAt: '', composeProject: 'orders', composeService: 'api' };
const snapshot: ContainerList = { sessionId: 's', generation: 7, containers: [container], refreshedAt: '', stale: false };
let registry: TerminalRegistry;
beforeEach(() => {
  registry = new TerminalRegistry();
  vi.spyOn(registry, 'connect').mockResolvedValue(); vi.spyOn(registry, 'disconnect').mockResolvedValue(); vi.spyOn(registry, 'close').mockResolvedValue();
  vi.spyOn(registry, 'attach').mockImplementation(() => {}); vi.spyOn(registry, 'fit').mockImplementation(() => {});
});
function view(props: Partial<Parameters<typeof ContainerTerminal>[0]> = {}) {
  return <PreferencesProvider initialPreferences={{ language: 'en', theme: 'light' }}><ContainerTerminal registry={registry} container={container} snapshot={snapshot} enabled {...props} /></PreferencesProvider>;
}
function retained(overrides: Partial<TerminalView> = {}): TerminalView {
  return { containerId: container.fullId, containerName: container.name, shell: 'sh', terminalId: 'terminal-a', status: 'running', exitCode: null, error: null, pending: false, ...overrides };
}
it('does not start a shell on mount and requires an explicit Connect with the chosen shell', async () => {
  const user = userEvent.setup(); const { rerender } = render(view());
  expect(registry.connect).not.toHaveBeenCalled(); expect(screen.getByRole('combobox', { name: 'Shell' })).toHaveValue('sh');
  expect(screen.getByText(container.fullId)).toBeVisible();
  await user.selectOptions(screen.getByRole('combobox', { name: 'Shell' }), 'bash');
  await user.click(screen.getByRole('button', { name: 'Connect' }));
  expect(registry.connect).toHaveBeenCalledExactlyOnceWith('s', 7, container, 'bash');
  rerender(view()); expect(registry.connect).toHaveBeenCalledOnce();
});
it.each([
  { container: { ...container, state: 'exited' } },
  { snapshot: { ...snapshot, stale: true } },
  { enabled: false },
])('disables Connect while the target cannot be validated %#', props => {
  render(view(props)); expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled(); expect(registry.connect).not.toHaveBeenCalled();
});
it('shows retained output controls without automatically starting another exec', async () => {
  vi.spyOn(registry, 'getSnapshot').mockReturnValue([retained()]);
  const user = userEvent.setup(); render(view());
  expect(screen.queryByRole('button', { name: 'Connect' })).not.toBeInTheDocument(); expect(registry.connect).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Disconnect' })); expect(registry.disconnect).toHaveBeenCalledWith(container.fullId);
  await user.click(screen.getByRole('button', { name: /^Close session$/ })); expect(registry.close).toHaveBeenCalledWith(container.fullId);
});
it('counts exited sessions toward the limit and exposes each explicit close control', async () => {
  vi.spyOn(registry, 'getSnapshot').mockReturnValue(Array.from({ length: 8 }, (_, index) => retained({ containerId: `old-${index}`, containerName: `old-${index}`, status: 'exited', exitCode: 0 })));
  const user = userEvent.setup(); render(view());
  expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled();
  await user.click(screen.getByText('Retained sessions 8/8'));
  await user.click(screen.getByRole('button', { name: 'Close session old-3' })); expect(registry.close).toHaveBeenCalledWith('old-3');
});
it('can view a retained container that has disappeared from the current inventory', async () => {
  vi.spyOn(registry, 'getSnapshot').mockReturnValue([retained({ containerId: 'removed', containerName: 'old-api', status: 'exited', exitCode: 0 })]);
  const user = userEvent.setup(); render(view());
  await user.click(screen.getByText('Retained sessions 1/8')); await user.click(screen.getByRole('button', { name: 'View old-api' }));
  expect(screen.getByTitle('removed')).toBeVisible(); expect(screen.queryByRole('button', { name: 'Connect' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Back to selected container' })); expect(screen.getByRole('button', { name: 'Connect' })).toBeVisible();
});
it('keeps retained output and close actions accessible with an empty inventory without a synthetic handle', async () => {
  vi.spyOn(registry, 'getSnapshot').mockReturnValue([retained({ containerId: 'removed', status: 'disconnected' })]);
  const user = userEvent.setup(); render(view({ container: null, snapshot: { ...snapshot, containers: [] }, enabled: false }));
  expect(screen.getByTitle('removed')).toBeVisible(); expect(screen.queryByRole('button', { name: 'Connect' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: /^Close session$/ }));
  expect(registry.close).toHaveBeenCalledWith('removed'); expect(registry.connect).not.toHaveBeenCalled();
});
it('renders no terminal panel when inventory and retained sessions are empty', () => {
  render(view({ container: null, snapshot: { ...snapshot, containers: [] }, enabled: false }));
  expect(screen.queryByRole('region', { name: 'Container terminal' })).not.toBeInTheDocument();
});
