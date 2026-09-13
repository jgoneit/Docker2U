import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { ComposeApplyDialog, ComposePrepareDialog, ComposeProgressDialog } from './ComposeDialogs';
import type { Container } from './api';
import type { ComposeApplyPreview, ComposeOperation, ComposePreparation, ComposeStage } from './composeApi';
import { PreferencesProvider } from './preferences';

const project = { id: 'registered', revision: 1, name: 'demo', composeFile: '/work/a-very-long-path/compose.yaml', workingDirectory: '/work', envFile: null };
const engine = { contextName: 'desktop-linux', endpoint: 'unix:///pinned.sock', engineId: 'engine-1' };
const preview: ComposeApplyPreview = { project, composeVersion: 'v2', services: [
  { name: 'web', image: 'web:local', build: true, profiles: [], preparations: ['pull', 'build', 'none'], blockedReason: null },
  { name: 'db', image: 'db:local', build: false, profiles: [], preparations: ['pull', 'none'], blockedReason: null },
  { name: 'image-mounted', image: 'blocked:local', build: false, profiles: [], preparations: [], blockedReason: 'imageMountUnsupported' },
] };
const stages: ComposeStage[] = [
  { kind: 'pull', services: [], status: 'skipped', exitCode: null, error: null },
  { kind: 'build', services: ['web'], status: 'pending', exitCode: null, error: null },
  { kind: 'recreate', services: ['web'], status: 'pending', exitCode: null, error: null },
];
const preparation: ComposePreparation = { prepareId: 'prepared', project, action: 'apply', composeVersion: 'v2', services: preview.services, selections: [{ service: 'web', preparation: 'build' }], stages, warnings: [{ code: 'sharedImage', image: 'web:local', services: ['web', 'worker'] }], existingContainers: 3, recreatePossible: true };
const operation: ComposeOperation = { id: 'op', requestId: 'request', sessionId: 's', projectId: project.id, projectName: project.name, action: 'apply', selections: preparation.selections, stages, warnings: preparation.warnings, phase: 'running', outcome: null, cancelRequested: false, exitCode: null, startedAt: '', finishedAt: null, reconciliation: 'pending', observedContainers: null, error: null };
function container(service: string, index = 1): Container {
  return { fullId: `${service}-${index}`.padEnd(64, 'a'), shortId: `${service}-${index}`, name: `demo-${service}-${index}`, composeProject: 'demo', composeService: service, image: `${service}:local`, state: 'running', health: 'unhealthy', healthConfigured: true, ports: [], handle: 'h', createdAt: '' };
}
function selector(language: 'ko' | 'en' = 'en', servicePreview = preview) {
  const onReview = vi.fn();
  const view = render(<PreferencesProvider initialPreferences={{ language, theme: 'dark' }}><ComposeApplyDialog project={project} preview={servicePreview} loading={false} error={null} onClose={vi.fn()} onRetry={vi.fn()} onReview={onReview} /></PreferencesProvider>);
  return { ...view, onReview };
}
function progress(op = operation) {
  return render(<PreferencesProvider initialPreferences={{ language: 'en', theme: 'light' }}><ComposeProgressDialog operation={op} recentOperations={[]} onSelectOperation={vi.fn()} text="build output" truncated={false} readError={null} previousSession={false} services={preview.services} containers={[container('web'), container('web', 2), container('db')]} observedAt="2026-09-13T00:00:00Z" stale={false} cancelling={false} refreshFailed={false} onClose={vi.fn()} onCancel={vi.fn()} onRetry={vi.fn()} onInspect={vi.fn()} /></PreferencesProvider>);
}
it('requires an explicit service and preparation choice and disables unsupported modes', async () => {
  const user = userEvent.setup(); const view = selector();
  const review = screen.getByRole('button', { name: 'Review selection' });
  expect(screen.getByRole('checkbox', { name: 'Select web' })).not.toBeChecked();
  expect(review).toBeDisabled();
  expect(screen.getByRole('checkbox', { name: 'Select image-mounted' })).toBeDisabled();
  expect(screen.getByText(/services with image mounts/)).toBeVisible();
  await user.click(screen.getByRole('checkbox', { name: 'Select db' }));
  const choices = screen.getByRole('combobox', { name: 'Image preparation for db' });
  expect(choices).toHaveValue(''); expect(review).toBeDisabled();
  expect(within(choices).getByRole('option', { name: 'Build image' })).toBeDisabled();
  await user.selectOptions(choices, 'pull'); await user.click(review);
  expect(view.onReview).toHaveBeenCalledExactlyOnceWith([{ service: 'db', preparation: 'pull' }]);
  await user.click(screen.getByRole('checkbox', { name: 'Select db' }));
  expect(review).toBeDisabled();
});
it('includes native preparation selectors in the keyboard focus cycle', async () => {
  const user = userEvent.setup(); selector();
  await user.click(screen.getByRole('checkbox', { name: 'Select web' }));
  await user.tab(); expect(screen.getByRole('combobox', { name: 'Image preparation for web' })).toHaveFocus();
  await user.selectOptions(screen.getByRole('combobox', { name: 'Image preparation for web' }), 'build');
  screen.getByRole('button', { name: 'Review selection' }).focus(); await user.tab();
  expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
  await user.tab({ shift: true }); expect(screen.getByRole('button', { name: 'Review selection' })).toHaveFocus();
});
it('presents Korean service choices without an implied default action', () => {
  selector('ko');
  expect(screen.getByRole('dialog', { name: '변경할 서비스 선택' })).toBeVisible();
  expect(screen.getByRole('combobox', { name: 'web 이미지 준비' })).toHaveValue('');
  expect(screen.getByRole('button', { name: '선택 내용 확인' })).toBeDisabled();
});
it('reviews Engine, every selected replica, image preparation and shared image consumers', async () => {
  const onStart = vi.fn();
  render(<PreferencesProvider initialPreferences={{ language: 'en', theme: 'light' }}><ComposePrepareDialog project={project} action="apply" preparation={preparation} engine={engine} loading={false} starting={false} error={null} onClose={vi.fn()} onRetry={vi.fn()} onStart={onStart} containers={[container('web'), container('web', 2), container('db')]} inventoryFresh /></PreferencesProvider>);
  expect(screen.getByRole('dialog', { name: 'Review changes' })).toBeVisible();
  expect(screen.getByText('engine-1')).toBeVisible(); expect(screen.getByText(project.composeFile)).toBeVisible();
  expect(screen.getByText('2 current replicas · all targeted')).toBeVisible();
  expect(screen.getByText(/demo-web-1/)).toBeVisible(); expect(screen.getByText(/demo-web-2/)).toBeVisible();
  expect(screen.queryByText(/demo-db-1/)).not.toBeInTheDocument();
  expect(screen.getByText(/Services using image web:local: web, worker/)).toBeVisible();
  expect(onStart).not.toHaveBeenCalled(); await userEvent.click(screen.getByRole('button', { name: 'Apply to selected services' }));
  expect(onStart).toHaveBeenCalledOnce();
});
it.each([true, false])('distinguishes absent replicas from unobserved inventory (%s)', inventoryFresh => {
  render(<PreferencesProvider initialPreferences={{ language: 'en', theme: 'light' }}><ComposePrepareDialog project={project} action="apply" preparation={preparation} engine={engine} loading={false} starting={false} error={null} onClose={vi.fn()} onRetry={vi.fn()} onStart={vi.fn()} containers={[]} inventoryFresh={inventoryFresh} /></PreferencesProvider>);
  expect(screen.getByText(inventoryFresh ? 'No current containers · will create new containers' : 'Current service state has not been observed.')).toBeVisible();
});
it('keeps completed image preparation separate from recreation and observes only selected services', () => {
  const started = structuredClone(stages); started[1]!.status = 'succeeded'; started[1]!.exitCode = 0; started[2]!.status = 'running';
  progress({ ...operation, stages: started });
  expect(within(screen.getByRole('region', { name: 'Command results by stage' })).getByText('Command completed')).toBeVisible();
  expect(screen.getAllByText('Working')).toHaveLength(2);
  expect(screen.getByRole('button', { name: 'View logs for demo-web-1' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'View diagnostics for demo-web-2' })).toBeVisible();
  expect(screen.queryByRole('button', { name: 'View logs for demo-db-1' })).not.toBeInTheDocument();
  expect(screen.getAllByText('Unhealthy')).toHaveLength(2);
});
it('retains successful build evidence and identifies skipped recreation after cancellation', () => {
  const stopped = structuredClone(stages); stopped[1]!.status = 'succeeded'; stopped[1]!.exitCode = 0; stopped[2]!.status = 'skipped';
  progress({ ...operation, stages: stopped, phase: 'finished', outcome: 'cancelled' });
  expect(screen.getByText('Remaining stages cancelled')).toBeVisible();
  expect(screen.getByText('Command completed')).toBeVisible();
  expect(screen.getAllByText('Not executed')).toHaveLength(2);
  expect(screen.getByText(/Prepared images may remain/)).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Request cancellation' })).not.toBeInTheDocument();
});

it('shows configured profile names even when that profile has no current containers', async () => {
  const configured = { ...preview, services: preview.services.map(service => ({ ...service, profiles: service.name === 'web' ? ['development', 'debug-tools'] : [] })) };
  const view = selector('en', configured);
  expect(screen.getByText('Profiles: development, debug-tools')).toBeVisible();
  expect(screen.getByRole('checkbox', { name: 'Select web' })).not.toBeChecked();
  view.unmount();
  render(<PreferencesProvider initialPreferences={{ language: 'ko', theme: 'light' }}><ComposePrepareDialog project={project} action="apply" preparation={{ ...preparation, services: configured.services }} engine={engine} loading={false} starting={false} error={null} onClose={vi.fn()} onRetry={vi.fn()} onStart={vi.fn()} containers={[]} inventoryFresh /></PreferencesProvider>);
  expect(screen.getByText('프로필: development, debug-tools')).toBeVisible();
  expect(screen.getByText('현재 컨테이너 없음 · 새로 생성됩니다')).toBeVisible();
});
it('can select a valid service named __proto__ and remove it without changing other selections', async () => {
  const user = userEvent.setup(); const configured: ComposeApplyPreview = { ...preview, services: [{ ...preview.services[0]!, name: '__proto__' }, preview.services[1]!] };
  const view = selector('en', configured);
  await user.click(screen.getByRole('checkbox', { name: 'Select __proto__' }));
  expect(screen.getByRole('checkbox', { name: 'Select __proto__' })).toBeChecked();
  await user.selectOptions(screen.getByRole('combobox', { name: 'Image preparation for __proto__' }), 'build');
  await user.click(screen.getByRole('button', { name: 'Review selection' }));
  expect(view.onReview).toHaveBeenCalledExactlyOnceWith([{ service: '__proto__', preparation: 'build' }]);
  await user.click(screen.getByRole('checkbox', { name: 'Select db' }));
  await user.selectOptions(screen.getByRole('combobox', { name: 'Image preparation for db' }), 'none');
  await user.click(screen.getByRole('checkbox', { name: 'Select __proto__' }));
  await user.click(screen.getByRole('button', { name: 'Review selection' }));
  expect(view.onReview).toHaveBeenLastCalledWith([{ service: 'db', preparation: 'none' }]);
});
it.each(['en', 'ko'] as const)('explains shared image preparation for a none consumer before confirming in %s', language => {
  const shared: ComposePreparation = { ...preparation, selections: [{ service: 'web', preparation: 'build' }, { service: 'worker', preparation: 'none' }] };
  render(<PreferencesProvider initialPreferences={{ language, theme: 'light' }}><ComposePrepareDialog project={project} action="apply" preparation={shared} engine={engine} loading={false} starting={false} error={null} onClose={vi.fn()} onRetry={vi.fn()} onStart={vi.fn()} containers={[]} inventoryFresh /></PreferencesProvider>);
  expect(screen.getByText(language === 'en' ? /A service set to use the current local image will use the updated image/ : /현재 로컬 이미지 사용을 선택해도/)).toBeVisible();
  expect(screen.getByRole('button', { name: language === 'en' ? 'Apply to selected services' : '선택 서비스에 반영' })).toBeEnabled();
});
it.each([
  { phase: 'reconciling', reconciliation: 'pending', text: 'Checking service state' },
  { phase: 'finished', reconciliation: 'succeeded', text: 'State refresh completed' },
  { phase: 'finished', reconciliation: 'failed', text: 'State refresh failed' },
  { phase: 'finished', reconciliation: 'skipped', text: 'Not executed' },
] as const)('shows a separate fourth state refresh result after successful commands: $text', ({ phase, reconciliation, text }) => {
  const finished = stages.map(stage => ({ ...stage, status: stage.services.length ? 'succeeded' as const : 'skipped' as const, exitCode: stage.services.length ? 0 : null }));
  progress({ ...operation, stages: finished, outcome: 'succeeded', phase, reconciliation });
  const results = screen.getByRole('region', { name: 'Command results by stage' });
  expect(within(results).getAllByRole('listitem')).toHaveLength(4);
  expect(within(results).getByRole('listitem', { name: 'State refresh' })).toHaveTextContent(text);
  expect(screen.getByRole('status')).toHaveTextContent('Command completed');
});
it.each(['en', 'ko'] as const)('disables external provider services with a specific reason in %s', async language => {
  const user = userEvent.setup();
  const configured: ComposeApplyPreview = { ...preview, services: [{ ...preview.services[0]!, name: 'managed-db', preparations: [], blockedReason: 'providerUnsupported' }] };
  const view = selector(language, configured);
  const checkbox = screen.getByRole('checkbox', { name: language === 'en' ? 'Select managed-db' : 'managed-db 선택' });
  expect(checkbox).toBeDisabled();
  expect(screen.getByText(language === 'en' ? /Services managed by an external provider/ : /외부 provider가 관리하는 서비스/)).toBeVisible();
  expect(screen.getByRole('combobox')).toBeDisabled();
  expect(screen.getByRole('button', { name: language === 'en' ? 'Review selection' : '선택 내용 확인' })).toBeDisabled();
  await user.click(checkbox); expect(checkbox).not.toBeChecked(); expect(view.onReview).not.toHaveBeenCalled();
});
