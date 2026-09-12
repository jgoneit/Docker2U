import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ComposeEditorDialog, ComposePrepareDialog, ComposeProgressDialog } from './ComposeDialogs';
import { composeApi, type ComposeProject, type ComposeProjectPreview } from './composeApi';
import { PreferencesProvider } from './preferences';
const project: ComposeProject = { id: 'registered', revision: 1, name: 'from-compose', composeFile: '/work/compose.yaml', workingDirectory: '/work', envFile: '/work/.env' };
const engine = { contextName: 'desktop-linux', endpoint: 'unix:///pinned.sock', engineId: 'engine-1' };
const preview: ComposeProjectPreview = { previewId: 'preview-token', project: { name: project.name, composeFile: project.composeFile, workingDirectory: project.workingDirectory, envFile: project.envFile }, composeVersion: 'v2', services: [{ name: 'web', image: 'web:local', build: true, profiles: [] }], existingContainers: 0, provenance: 'new' };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { resolve, promise }; }
function editor() {
  const props = { project: null, engine, sessionId: 'session-1', onClose: vi.fn(), onSaved: vi.fn(), onRegistryChanged: vi.fn(), onError: vi.fn() };
  const renderEditor = (sessionId: string | null) => <PreferencesProvider initialPreferences={{ theme: 'dark', language: 'ko' }}><ComposeEditorDialog {...props} sessionId={sessionId} /></PreferencesProvider>;
  const view = render(renderEditor('session-1'));
  return { ...view, props, reconnect: () => view.rerender(renderEditor('session-2')) };
}
beforeEach(() => {
  vi.spyOn(composeApi, 'pick').mockResolvedValue('/work/compose.yaml');
  vi.spyOn(composeApi, 'preview').mockResolvedValue(preview);
  vi.spyOn(composeApi, 'save').mockResolvedValue(project);
});
afterEach(() => vi.restoreAllMocks());
it('uses native file selection, asks Core for a default name and reviews the suggested env before saving', async () => {
  const user = userEvent.setup(); const view = editor();
  expect(screen.getByText('desktop-linux')).toBeVisible(); expect(screen.getByText('unix:///pinned.sock')).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Compose 파일 선택' }));
  expect(composeApi.pick).toHaveBeenCalledWith('file'); expect(screen.getByRole('textbox', { name: '작업 폴더' })).toHaveValue('/work');
  expect(screen.getByRole('textbox', { name: '프로젝트 이름' })).toHaveValue('');
  await user.click(screen.getByRole('button', { name: '구성 확인' }));
  expect(composeApi.preview).toHaveBeenCalledWith('session-1', { name: '', composeFile: '/work/compose.yaml', workingDirectory: '/work', envFile: null });
  expect(screen.getByRole('textbox', { name: '프로젝트 이름' })).toHaveValue('from-compose');
  expect(screen.getByRole('textbox', { name: '환경 파일 · 선택 사항' })).toHaveValue('/work/.env');
  expect(screen.getByRole('button', { name: '등록' })).toBeEnabled();
  await user.click(screen.getByRole('button', { name: '등록' }));
  expect(composeApi.save).toHaveBeenCalledExactlyOnceWith('preview-token'); expect(view.props.onSaved).toHaveBeenCalledExactlyOnceWith(project);
});
it('invalidates a preview after field changes and preserves explicit no-env through the next review', async () => {
  const user = userEvent.setup(); editor(); await user.click(screen.getByRole('button', { name: 'Compose 파일 선택' })); await user.click(screen.getByRole('button', { name: '구성 확인' }));
  await user.click(screen.getByRole('button', { name: '환경 파일 선택 해제' }));
  expect(screen.queryByRole('button', { name: '등록' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '구성 확인' }));
  expect(composeApi.preview).toHaveBeenLastCalledWith('session-1', expect.objectContaining({ envFile: '' }));
  fireEvent.change(screen.getByRole('textbox', { name: '프로젝트 이름' }), { target: { value: 'renamed' } });
  expect(screen.getByRole('button', { name: '구성 확인' })).toBeEnabled(); expect(composeApi.save).not.toHaveBeenCalled();
});
it('keeps a failed save and all form inputs available for correction', async () => {
  vi.mocked(composeApi.save).mockRejectedValue({ code: 'DuplicateRegistration', message: 'Same name exists.' });
  const user = userEvent.setup(); const view = editor(); await user.click(screen.getByRole('button', { name: 'Compose 파일 선택' })); await user.click(screen.getByRole('button', { name: '구성 확인' })); await user.click(screen.getByRole('button', { name: '등록' }));
  expect(within(screen.getByRole('alert')).getByText('Same name exists.', { selector: 'p' })).toBeVisible();
  expect(screen.getByRole('textbox', { name: '프로젝트 이름' })).toHaveValue('from-compose'); expect(view.props.onSaved).not.toHaveBeenCalled();
});
it('discards a delayed preview after reconnect and requires a fresh review', async () => {
  const pending = deferred<ComposeProjectPreview>(); vi.mocked(composeApi.preview).mockReturnValue(pending.promise);
  const user = userEvent.setup(); const view = editor(); await user.click(screen.getByRole('button', { name: 'Compose 파일 선택' })); await user.click(screen.getByRole('button', { name: '구성 확인' }));
  view.reconnect(); await act(async () => pending.resolve(preview));
  expect(screen.getByRole('textbox', { name: '프로젝트 이름' })).toHaveValue(''); expect(screen.queryByRole('button', { name: '등록' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '구성 확인' })).toBeEnabled();
});
it('cancelling a native picker preserves the current input and does not preview automatically', async () => {
  vi.mocked(composeApi.pick).mockResolvedValue(null); const user = userEvent.setup(); editor();
  fireEvent.change(screen.getByRole('textbox', { name: 'Compose 파일' }), { target: { value: '/typed/compose.yaml' } });
  await user.click(screen.getByRole('button', { name: 'Compose 파일 선택' }));
  expect(screen.getByRole('textbox', { name: 'Compose 파일' })).toHaveValue('/typed/compose.yaml'); expect(composeApi.preview).not.toHaveBeenCalled();
});
it('does not use an old picker response after closing and accepts Escape during the pending picker', async () => {
  const pending = deferred<string | null>(); vi.mocked(composeApi.pick).mockReturnValue(pending.promise);
  const user = userEvent.setup(); const view = editor(); await user.click(screen.getByRole('button', { name: 'Compose 파일 선택' })); await user.keyboard('{Escape}');
  expect(view.props.onClose).toHaveBeenCalledOnce(); view.unmount(); await act(async () => pending.resolve('/late/compose.yaml'));
  expect(composeApi.preview).not.toHaveBeenCalled();
});
it('shows preparation configuration and explicit run confirmation without issuing a command itself', async () => {
  const onStart = vi.fn(); const onClose = vi.fn();
  render(<PreferencesProvider initialPreferences={{ theme: 'light', language: 'ko' }}><ComposePrepareDialog project={project} action="up" preparation={{ prepareId: 'prep', project, action: 'up', composeVersion: 'v2', services: preview.services, existingContainers: 2, recreatePossible: true }} engine={engine} loading={false} starting={false} error={null} onClose={onClose} onRetry={vi.fn()} onStart={onStart} /></PreferencesProvider>);
  expect(screen.getByRole('dialog', { name: '프로젝트 실행 확인' })).toBeVisible(); expect(screen.getByText('engine-1')).toBeVisible(); expect(screen.getByText(/컨테이너가 다시 생성/)).toBeVisible();
  expect(onStart).not.toHaveBeenCalled(); await userEvent.click(screen.getByRole('button', { name: '실행' })); expect(onStart).toHaveBeenCalledOnce();
});
it('shows actual inventory states and output with a separate close and cancellation action', async () => {
  const onClose = vi.fn(); const onCancel = vi.fn();
  render(<PreferencesProvider initialPreferences={{ theme: 'dark', language: 'en' }}><ComposeProgressDialog operation={{ id: 'op', sessionId: 's', projectId: project.id, projectName: project.name, action: 'up', phase: 'running', outcome: null, cancelRequested: false, exitCode: null, startedAt: '', finishedAt: null, reconciliation: 'pending', observedContainers: null, error: null }} recentOperations={[]} onSelectOperation={vi.fn()} text={'actual output\nlast line'} truncated={false} readError={null} previousSession={false} services={preview.services} containers={[]} cancelling={false} refreshFailed={false} onClose={onClose} onCancel={onCancel} onRetry={vi.fn()} /></PreferencesProvider>);
  expect(screen.getByLabelText('Operation output')).toHaveTextContent('last line'); expect(screen.getByText('Awaiting container state')).toBeVisible();
  await userEvent.click(screen.getAllByRole('button', { name: 'Close' }).at(-1)!); expect(onClose).toHaveBeenCalledOnce(); expect(onCancel).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: 'Request cancellation' })); await waitFor(() => expect(onCancel).toHaveBeenCalledOnce());
});
it('reloads persisted registrations after a save succeeds across reconnect without reviving the old editor', async () => {
  const pending = deferred<ComposeProject>(); vi.mocked(composeApi.save).mockReturnValue(pending.promise);
  const user = userEvent.setup(); const view = editor();
  await user.click(screen.getByRole('button', { name: 'Compose 파일 선택' }));
  await user.click(screen.getByRole('button', { name: '구성 확인' }));
  await user.click(screen.getByRole('button', { name: '등록' }));
  view.reconnect();
  await act(async () => pending.resolve(project));
  expect(view.props.onRegistryChanged).toHaveBeenCalledOnce();
  expect(view.props.onSaved).not.toHaveBeenCalled();
  expect(view.props.onClose).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: '구성 확인' })).toBeEnabled();
});
it('reloads a completed registry write even if its old editor has unmounted', async () => {
  const pending = deferred<ComposeProject>(); vi.mocked(composeApi.save).mockReturnValue(pending.promise);
  const user = userEvent.setup(); const view = editor();
  await user.click(screen.getByRole('button', { name: 'Compose 파일 선택' }));
  await user.click(screen.getByRole('button', { name: '구성 확인' }));
  await user.click(screen.getByRole('button', { name: '등록' }));
  view.unmount(); await act(async () => pending.resolve(project));
  expect(view.props.onRegistryChanged).toHaveBeenCalledOnce(); expect(view.props.onSaved).not.toHaveBeenCalled();
});
