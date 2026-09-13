import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Environment } from './api';
import { composeApi, type ComposeApplyPreview, type ComposeApplySelection, type ComposeOperation, type ComposeOperationRead, type ComposePreparation, type ComposeProject } from './composeApi';
import { useComposeProjects } from './useComposeProjects';
const project: ComposeProject = { id: 'registered-1', revision: 2, name: 'sample', composeFile: '/sample/compose.yaml', workingDirectory: '/sample', envFile: null };
const preparation: ComposePreparation = { prepareId: 'ready-1', project, action: 'up', composeVersion: 'v2', services: [{ name: 'web', image: 'image', build: false, profiles: [] }], existingContainers: 0, recreatePossible: true };
const operation = (patch: Partial<ComposeOperation> = {}): ComposeOperation => ({ id: 'operation-1', requestId: '00000000-0000-4000-8000-000000000001', sessionId: 'session-1', projectId: project.id, projectName: project.name, action: 'up', phase: 'running', outcome: null, cancelRequested: false, exitCode: null, startedAt: '2026-09-13T00:00:00Z', finishedAt: null, reconciliation: 'pending', observedContainers: null, error: null, ...patch });
const page = (op = operation(), text = '', nextSequence = 0): ComposeOperationRead => ({ operation: op, text, nextSequence, oldestSequence: 1, truncated: false });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function mount() {
  const refresh = vi.fn(async () => true); const onError = vi.fn();
  const hook = renderHook(({ id }: { id: string | null }) => useComposeProjects({ environment: { sessionId: id, contextName: 'desktop', endpoint: 'unix:///engine.sock', engineId: 'engine-1' } as Environment, enabled: !!id, refresh, onError }), { initialProps: { id: 'session-1' as string | null } });
  return { ...hook, refresh, onError };
}
async function begin(result: ReturnType<typeof mount>['result']) { await act(async () => { await result.current.prepare(project, 'up'); }); await act(async () => { await result.current.start(); }); }
async function tick(ms = 500) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000001');
  vi.spyOn(composeApi, 'available').mockReturnValue(true);
  vi.spyOn(composeApi, 'list').mockResolvedValue([project]);
  vi.spyOn(composeApi, 'prepare').mockResolvedValue(preparation);
  vi.spyOn(composeApi, 'start').mockResolvedValue(operation());
  vi.spyOn(composeApi, 'operations').mockResolvedValue([]);
  vi.spyOn(composeApi, 'read').mockResolvedValue(page());
  vi.spyOn(composeApi, 'cancel').mockResolvedValue(operation({ cancelRequested: true }));
  vi.spyOn(composeApi, 'remove').mockResolvedValue(undefined);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
describe('Compose projects controller', () => {
  it('keeps a registered project with no containers and stores registry separately from sessions', async () => {
    const hook = mount(); await tick(0);
    expect(hook.result.current.projects).toEqual([project]);
    hook.rerender({ id: 'session-2' }); await tick(0);
    expect(hook.result.current.projects).toEqual([project]);
    expect(composeApi.list).toHaveBeenCalledTimes(1);
  });
  it('accepts an empty starting read and keeps polling a quiet operation without a silence timeout', async () => {
    const hook = mount(); await begin(hook.result); await tick(60_000);
    expect(hook.result.current.readError).toBeNull();
    expect(hook.result.current.busy).toBe(true);
    expect(composeApi.read).toHaveBeenCalledWith('session-1', 'operation-1', 0);
    expect(hook.refresh).not.toHaveBeenCalled();
  });
  it('drains all terminal output pages before final inventory refresh', async () => {
    const terminal = operation({ phase: 'finished', outcome: 'succeeded', reconciliation: 'succeeded' });
    vi.mocked(composeApi.read).mockImplementation(async (_session, _id, after) => page(terminal, after === 0 ? 'first\n' : after === 1 ? 'last\n' : '', Math.min(after + 1, 2)));
    const hook = mount(); await begin(hook.result);
    expect(hook.refresh).not.toHaveBeenCalled();
    await tick(10);
    expect(hook.result.current.text).toBe('first\nlast\n');
    expect(composeApi.read).toHaveBeenLastCalledWith('session-1', 'operation-1', 2);
    expect(hook.refresh).toHaveBeenCalledTimes(1);
    expect(hook.result.current.busy).toBe(false);
  });
  it('accepts a fully evicted empty retained page with oldestSequence one past the cursor', async () => {
    vi.mocked(composeApi.read).mockResolvedValue({ ...page(operation(), '', 9), oldestSequence: 10, truncated: true });
    const hook = mount(); await begin(hook.result); await tick(500);
    expect(hook.result.current.readError).toBeNull(); expect(hook.result.current.truncated).toBe(true);
    expect(composeApi.read).toHaveBeenLastCalledWith('session-1', 'operation-1', 9);
  });
  it('coalesces duplicate start clicks and closing progress never cancels the operation', async () => {
    const pending = deferred<ComposeOperation>(); vi.mocked(composeApi.start).mockReturnValue(pending.promise);
    const hook = mount(); await act(async () => { await hook.result.current.prepare(project, 'up'); });
    let started!: Promise<void>;
    act(() => { started = hook.result.current.start(); void hook.result.current.start(); });
    act(() => hook.result.current.close());
    await act(async () => { pending.resolve(operation()); await started; });
    expect(composeApi.start).toHaveBeenCalledTimes(1); expect(hook.result.current.operation?.id).toBe('operation-1');
    expect(hook.result.current.modal).toBeNull(); expect(composeApi.cancel).not.toHaveBeenCalled();
    act(() => hook.result.current.openProgress()); expect(hook.result.current.modal?.kind).toBe('progress');
  });
  it('does not accept preparation responses after closing or changing the session', async () => {
    const pending = deferred<ComposePreparation>(); vi.mocked(composeApi.prepare).mockReturnValue(pending.promise);
    const hook = mount(); let attempt!: Promise<void>;
    act(() => { attempt = hook.result.current.prepare(project, 'up'); });
    hook.rerender({ id: 'session-2' });
    await act(async () => { pending.resolve(preparation); await attempt; });
    expect(hook.result.current.preparation).toBeNull(); expect(hook.result.current.modal).toBeNull();
    await act(async () => { await hook.result.current.start(); }); expect(composeApi.start).not.toHaveBeenCalled();
  });
  it('ignores a start response after reconnect and retains the local registration', async () => {
    const pending = deferred<ComposeOperation>(); vi.mocked(composeApi.start).mockReturnValue(pending.promise);
    const hook = mount(); await act(async () => { await hook.result.current.prepare(project, 'up'); });
    let attempt!: Promise<void>; act(() => { attempt = hook.result.current.start(); }); hook.rerender({ id: 'session-2' });
    await act(async () => { pending.resolve(operation()); await attempt; });
    expect(hook.result.current.operation).toBeNull(); expect(hook.result.current.busy).toBe(false); expect(hook.result.current.projects).toEqual([project]);
  });
  it('discards late read responses from a previous session', async () => {
    const pending = deferred<ComposeOperationRead>(); const fresh = deferred<ComposeOperationRead>();
    vi.mocked(composeApi.read).mockReturnValueOnce(pending.promise).mockReturnValue(fresh.promise);
    const hook = mount(); await begin(hook.result); hook.rerender({ id: 'session-2' });
    await act(async () => { pending.resolve(page(operation(), 'old-session\n', 1)); });
    expect(hook.result.current.text).toBe(''); expect(hook.result.current.previousSession).toBe(true); expect(hook.refresh).not.toHaveBeenCalled();
  });
  it('recovers a registered running operation after a lost start reply without starting twice', async () => {
    vi.mocked(composeApi.start).mockRejectedValue({ code: 'IPC_FAILURE', message: 'reply lost' });
    const hook = mount(); await tick(0); vi.mocked(composeApi.operations).mockResolvedValue([operation()]); await begin(hook.result);
    expect(composeApi.start).toHaveBeenCalledTimes(1); expect(hook.result.current.operation?.id).toBe('operation-1'); expect(hook.result.current.actionError).toBeNull();
  });
  it('preserves output while an explicit read retry is pending and fences the old request', async () => {
    vi.mocked(composeApi.read).mockResolvedValueOnce(page(operation(), 'kept output\n', 1)).mockRejectedValueOnce({ code: 'Busy', message: 'try again' });
    const hook = mount(); await begin(hook.result); await tick();
    expect(hook.result.current.readError?.code).toBe('Busy');
    const pending = deferred<ComposeOperationRead>(); vi.mocked(composeApi.read).mockReturnValue(pending.promise);
    act(() => hook.result.current.retryRead()); await tick(0);
    expect(hook.result.current.text).toBe('kept output\n');
    await act(async () => { pending.resolve(page(operation(), 'kept output\nnew output\n', 2)); });
    expect(hook.result.current.text).toBe('kept output\nnew output\n');
  });
  it('keeps other mutations blocked while an earlier operation is inspected', async () => {
    const earlier = operation({ id: 'old-operation', phase: 'finished', outcome: 'failed' });
    vi.mocked(composeApi.operations).mockResolvedValue([operation(), earlier]);
    vi.mocked(composeApi.read).mockImplementation(async (_session, id) => page(id === earlier.id ? earlier : operation()));
    const hook = mount(); await tick(0);
    expect(hook.result.current.busy).toBe(true);
    act(() => hook.result.current.selectOperation('old-operation')); await tick(0);
    expect(hook.result.current.operation?.id).toBe('old-operation'); expect(hook.result.current.busy).toBe(true);
    await act(async () => { await hook.result.current.prepare(project, 'up'); }); expect(composeApi.prepare).not.toHaveBeenCalled();
  });
  it('removes only registry metadata and does not start, stop, or cancel jobs', async () => {
    const hook = mount(); await tick(0); await act(async () => { expect(await hook.result.current.remove(project)).toBe(true); });
    expect(hook.result.current.projects).toEqual([]); expect(composeApi.remove).toHaveBeenCalledWith(project.id, project.revision);
    expect(composeApi.start).not.toHaveBeenCalled(); expect(composeApi.cancel).not.toHaveBeenCalled();
  });
  it('does not overwrite a newly saved registration with a late initial list', async () => {
    const pending = deferred<ComposeProject[]>(); vi.mocked(composeApi.list).mockReturnValue(pending.promise);
    const hook = mount(); act(() => hook.result.current.saved(project)); await act(async () => { pending.resolve([]); });
    expect(hook.result.current.projects).toEqual([project]);
  });
  it('preserves failed refresh evidence after a successful command', async () => {
    vi.mocked(composeApi.read).mockResolvedValue(page(operation({ phase: 'finished', outcome: 'succeeded' })));
    const hook = mount(); hook.refresh.mockResolvedValue(false); await begin(hook.result); await tick(0);
    expect(hook.result.current.refreshFailed).toBe(true); expect(hook.result.current.busy).toBe(false);
  });
});
it('opens the newest retained operation from Core’s oldest-first journal', async () => {
  const older = operation({ id: 'older', phase: 'finished', outcome: 'succeeded' });
  const newest = operation({ id: 'newest', phase: 'finished', outcome: 'failed' });
  vi.mocked(composeApi.operations).mockResolvedValue([older, newest]);
  vi.mocked(composeApi.read).mockImplementation(async (_session, id) => page(id === older.id ? older : newest));
  const hook = mount(); await tick(0);
  expect(hook.result.current.recentOperations.map(item => item.id)).toEqual(['newest', 'older']);
  expect(hook.result.current.operation?.id).toBe('newest');
});
it('replays an earlier connection’s output after a new operation without refreshing or cancelling the current Engine', async () => {
  const a = operation({ id: 'operation-a', phase: 'finished', outcome: 'succeeded' });
  const b = operation({ id: 'operation-b', sessionId: 'session-2', phase: 'finished', outcome: 'succeeded' });
  let jobs = [a];
  vi.mocked(composeApi.operations).mockImplementation(async () => jobs);
  vi.mocked(composeApi.read).mockImplementation(async (sessionId, id, cursor) => {
    const target = id === a.id ? a : b; expect(sessionId).toBe(target.sessionId);
    return page(target, cursor === 0 ? `${id} output\n` : '', 1);
  });
  const hook = mount(); await tick(10); expect(hook.result.current.text).toBe('operation-a output\n');
  hook.rerender({ id: 'session-2' }); await tick(10); hook.refresh.mockClear();
  vi.mocked(composeApi.start).mockImplementation(async () => { jobs = [a, b]; return b; });
  await begin(hook.result); await tick(10);
  expect(hook.result.current.text).toBe('operation-b output\n'); expect(hook.refresh).toHaveBeenCalledExactlyOnceWith('session-2');
  hook.refresh.mockClear(); act(() => hook.result.current.selectOperation(a.id)); await tick(10);
  expect(hook.result.current.text).toBe('operation-a output\n'); expect(hook.result.current.previousSession).toBe(true);
  expect(hook.result.current.busy).toBe(false); expect(hook.refresh).not.toHaveBeenCalled();
  await act(async () => { await hook.result.current.cancel(); }); expect(composeApi.cancel).not.toHaveBeenCalled();
});
it('fences a late read when selecting another job with the same project and action', async () => {
  const a = operation({ id: 'operation-a', phase: 'finished', outcome: 'succeeded' });
  const b = operation({ id: 'operation-b', phase: 'finished', outcome: 'failed' });
  const lateB = deferred<ComposeOperationRead>(); const currentA = deferred<ComposeOperationRead>();
  vi.mocked(composeApi.operations).mockResolvedValue([a, b]);
  vi.mocked(composeApi.read).mockImplementation((_session, id) => id === a.id ? currentA.promise : lateB.promise);
  const hook = mount(); await tick(0); expect(hook.result.current.operation?.id).toBe(b.id);
  await act(async () => { hook.result.current.selectOperation(a.id); lateB.resolve(page(b, 'late B must not overwrite A\n', 1)); });
  expect(hook.result.current.operation?.id).toBe(a.id); expect(hook.result.current.text).toBe('');
  await act(async () => currentA.resolve(page(a, 'current A output\n', 1)));
  expect(hook.result.current.operation?.id).toBe(a.id); expect(hook.result.current.text).toBe('current A output\n');
});
it('recovers a lost start reply using only a job from the requesting session', async () => {
  const old = operation({ id: 'old-running', sessionId: 'older-session' });
  vi.mocked(composeApi.start).mockRejectedValue({ code: 'IPC_FAILURE', message: 'reply lost' });
  const hook = mount(); await tick(0);
  vi.mocked(composeApi.operations).mockResolvedValue([old, operation()]);
  await begin(hook.result);
  expect(hook.result.current.operation?.id).toBe('operation-1');
  expect(hook.result.current.actionError).toBeNull();
  expect(composeApi.start).toHaveBeenCalledOnce();
});

const applySelections: ComposeApplySelection[] = [{ service: 'web', preparation: 'build' }];
const applyPreview: ComposeApplyPreview = { project, composeVersion: 'v2', services: [{ name: 'web', image: 'image', build: true, profiles: [], preparations: ['build', 'pull', 'none'], blockedReason: null }] };
const applyPreparation: ComposePreparation = { ...preparation, action: 'apply', selections: applySelections, warnings: [], stages: [
  { kind: 'pull', services: [], status: 'skipped', exitCode: null, error: null },
  { kind: 'build', services: ['web'], status: 'pending', exitCode: null, error: null },
  { kind: 'recreate', services: ['web'], status: 'pending', exitCode: null, error: null },
] };
const applyOperation = (patch: Partial<ComposeOperation> = {}) => operation({ action: 'apply', selections: applySelections, stages: applyPreparation.stages, warnings: [], ...patch });
describe('selected service changes', () => {
  beforeEach(() => {
    vi.spyOn(composeApi, 'previewApply').mockResolvedValue(applyPreview);
    vi.mocked(composeApi.prepare).mockResolvedValue(applyPreparation);
    vi.mocked(composeApi.start).mockResolvedValue(applyOperation());
    vi.mocked(composeApi.read).mockResolvedValue(page(applyOperation()));
  });
  it('does not prepare or start a mutation while choosing services', async () => {
    const hook = mount(); await act(async () => hook.result.current.openApply(project));
    expect(hook.result.current.modal?.kind).toBe('apply');
    expect(hook.result.current.applyPreview).toEqual(applyPreview);
    expect(hook.result.current.applySelections).toEqual([]);
    expect(composeApi.prepare).not.toHaveBeenCalled(); expect(composeApi.start).not.toHaveBeenCalled();
    await act(async () => hook.result.current.prepare(project, 'apply', []));
    expect(composeApi.prepare).not.toHaveBeenCalled();
  });
  it.each(['close', 'reconnect'] as const)('discards a delayed service preview after %s', async change => {
    const pending = deferred<ComposeApplyPreview>(); vi.mocked(composeApi.previewApply).mockReturnValue(pending.promise);
    const hook = mount(); let attempt!: Promise<void>;
    act(() => { attempt = hook.result.current.openApply(project); });
    if (change === 'close') act(() => hook.result.current.close()); else hook.rerender({ id: 'session-2' });
    await act(async () => { pending.resolve(applyPreview); await attempt; });
    expect(hook.result.current.applyPreview).toBeNull(); expect(hook.result.current.modal).toBeNull();
  });
  it('rejects a prepared plan containing a service the user did not select', async () => {
    vi.mocked(composeApi.prepare).mockResolvedValue({ ...applyPreparation, selections: [{ service: 'db', preparation: 'none' }] });
    const hook = mount(); await act(async () => hook.result.current.prepare(project, 'apply', applySelections));
    expect(hook.result.current.preparation).toBeNull(); expect(hook.result.current.actionError?.code).toBe('MalformedOutput');
    await act(async () => hook.result.current.start()); expect(composeApi.start).not.toHaveBeenCalled();
  });
  it('pins the explicit preparation plan and keeps its operation alive after closing', async () => {
    const hook = mount(); await act(async () => hook.result.current.prepare(project, 'apply', applySelections));
    expect(composeApi.prepare).toHaveBeenCalledExactlyOnceWith('session-1', project.id, project.revision, 'apply', applySelections);
    await act(async () => hook.result.current.start()); act(() => hook.result.current.close()); await tick();
    expect(hook.result.current.busy).toBe(true); expect(hook.result.current.operation?.selections).toEqual(applySelections);
    expect(composeApi.cancel).not.toHaveBeenCalled();
    act(() => hook.result.current.openProgress()); expect(hook.result.current.modal?.kind).toBe('progress');
  });
  it('recovers an already finished exact request after a lost start response', async () => {
    const doneStages = applyPreparation.stages!.map(stage => ({ ...stage, status: stage.services.length ? 'succeeded' as const : 'skipped' as const, exitCode: stage.services.length ? 0 : null }));
    const completed = applyOperation({ phase: 'finished', outcome: 'succeeded', stages: doneStages });
    const other = applyOperation({ id: 'other', requestId: 'unrelated-request' });
    vi.mocked(composeApi.start).mockRejectedValue({ code: 'IPC_FAILURE', message: 'reply lost' });
    vi.mocked(composeApi.read).mockResolvedValue(page(completed));
    const hook = mount(); await tick(0); vi.mocked(composeApi.operations).mockResolvedValue([other, completed]);
    await act(async () => hook.result.current.prepare(project, 'apply', applySelections)); await act(async () => hook.result.current.start()); await tick(0);
    expect(hook.result.current.operation?.id).toBe(completed.id); expect(hook.result.current.actionError).toBeNull();
    expect(hook.refresh).toHaveBeenCalledOnce(); expect(composeApi.start).toHaveBeenCalledOnce();
  });
  it('retains completed stages and drained output when a running cancellation reply arrives late', async () => {
    const pendingCancel = deferred<ComposeOperation>();
    vi.mocked(composeApi.cancel).mockReturnValue(pendingCancel.promise);
    const hook = mount();
    await act(async () => hook.result.current.prepare(project, 'apply', applySelections));
    await act(async () => hook.result.current.start());
    let cancelling!: Promise<void>;
    act(() => { cancelling = hook.result.current.cancel(); });
    const completed = applyOperation({ phase: 'finished', outcome: 'succeeded', reconciliation: 'succeeded', stages: applyPreparation.stages!.map(stage => ({ ...stage, status: stage.services.length ? 'succeeded' as const : 'skipped' as const, exitCode: stage.services.length ? 0 : null })) });
    vi.mocked(composeApi.read).mockImplementation(async (_session, _id, after) => page(completed, after === 0 ? 'completed output\n' : '', 1));
    await tick(510);
    expect(hook.result.current.operation).toEqual(completed);
    expect(hook.result.current.text).toBe('completed output\n');
    expect(hook.refresh).toHaveBeenCalledOnce();
    const reads = vi.mocked(composeApi.read).mock.calls.length;
    vi.mocked(composeApi.read).mockReturnValue(deferred<ComposeOperationRead>().promise);
    await act(async () => { pendingCancel.resolve(applyOperation({ cancelRequested: true })); await cancelling; });
    expect(hook.result.current.operation).toEqual(completed);
    expect(hook.result.current.recentOperations.find(item => item.id === completed.id)).toEqual(completed);
    expect(hook.result.current.text).toBe('completed output\n');
    expect(hook.result.current.cancelling).toBe(false);
    expect(hook.result.current.busy).toBe(false);
    expect(composeApi.read).toHaveBeenCalledTimes(reads);
    expect(hook.refresh).toHaveBeenCalledOnce();
  });
  it('never substitutes another job with the same project and action after a lost response', async () => {
    vi.mocked(composeApi.start).mockRejectedValue({ code: 'IPC_FAILURE', message: 'reply lost' });
    const hook = mount(); await tick(0);
    vi.mocked(composeApi.operations).mockResolvedValue([applyOperation({ id: 'other', requestId: 'unrelated-request' })]);
    await act(async () => hook.result.current.prepare(project, 'apply', applySelections)); await act(async () => hook.result.current.start());
    expect(hook.result.current.operation).toBeNull(); expect(hook.result.current.actionError?.code).toBe('IPC_FAILURE');
  });
  it('rejects a read that silently changes the reviewed preparation kind', async () => {
    const hook = mount(); await act(async () => hook.result.current.prepare(project, 'apply', applySelections)); await act(async () => hook.result.current.start());
    const changed = applyOperation({ selections: [{ service: 'web', preparation: 'pull' }], stages: [
      { kind: 'pull', services: ['web'], status: 'running', exitCode: null, error: null },
      { kind: 'build', services: [], status: 'skipped', exitCode: null, error: null },
      { kind: 'recreate', services: ['web'], status: 'pending', exitCode: null, error: null },
    ] });
    vi.mocked(composeApi.read).mockResolvedValue(page(changed, 'wrong operation output', 1)); await tick();
    expect(hook.result.current.readError?.code).toBe('MalformedOutput'); expect(hook.result.current.operation?.selections).toEqual(applySelections);
    expect(hook.result.current.text).toBe('');
  });
});
