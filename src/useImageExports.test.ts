import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { imageExportApi, type ImageExportOperation, type ImageExportPreview } from './imageExportApi';
import { useImageExports } from './useImageExports';
import { exportContainer, exportDestination, exportInventory, exportOperation, exportPreview } from './test/imageExportData';

function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const tick = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
function mount() { return renderHook(({ sessionId }) => useImageExports({ sessionId, enabled: true }), { initialProps: { sessionId: 'session-1' } }); }
async function review(hook: ReturnType<typeof mount>) { await act(async () => { await hook.result.current.prepare(exportContainer, exportInventory); }); await act(async () => { await hook.result.current.pick(); }); }
async function start(hook: ReturnType<typeof mount>) { await review(hook); await act(async () => { await hook.result.current.start(); }); }
beforeEach(() => {
  vi.useFakeTimers(); vi.spyOn(crypto, 'randomUUID').mockReturnValue(exportOperation().requestId as `${string}-${string}-${string}-${string}-${string}`);
  vi.spyOn(imageExportApi, 'available').mockReturnValue(true);
  vi.spyOn(imageExportApi, 'prepare').mockResolvedValue(exportPreview);
  vi.spyOn(imageExportApi, 'pick').mockResolvedValue(exportDestination);
  vi.spyOn(imageExportApi, 'start').mockResolvedValue(exportOperation());
  vi.spyOn(imageExportApi, 'read').mockResolvedValue(exportOperation());
  vi.spyOn(imageExportApi, 'list').mockResolvedValue([]);
  vi.spyOn(imageExportApi, 'cancel').mockResolvedValue(exportOperation({ phase: 'finished', outcome: 'cancelled' }));
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it('keeps a started job and polling when its progress window is closed', async () => {
  const hook = mount(); await start(hook); act(() => hook.result.current.close());
  const reads = vi.mocked(imageExportApi.read).mock.calls.length; await tick(1400);
  expect(hook.result.current.modal).toBeNull(); expect(hook.result.current.busy).toBe(true); expect(imageExportApi.read).toHaveBeenCalledTimes(reads + 2);
  act(() => hook.result.current.openProgress()); expect(hook.result.current.modal).toBe('progress'); expect(imageExportApi.start).toHaveBeenCalledTimes(1);
});
it('does not reopen a dialog closed while the start reply is pending', async () => {
  const pending = deferred<ImageExportOperation>(); vi.mocked(imageExportApi.start).mockReturnValue(pending.promise);
  const hook = mount(); await review(hook); act(() => { void hook.result.current.start(); }); act(() => hook.result.current.close());
  await act(async () => pending.resolve(exportOperation()));
  expect(hook.result.current.modal).toBeNull(); expect(hook.result.current.operation?.requestId).toBe(exportOperation().requestId);
  act(() => hook.result.current.openProgress()); expect(hook.result.current.modal).toBe('progress');
});
it('recovers a lost start reply by the exact request ID without another start', async () => {
  vi.mocked(imageExportApi.start).mockRejectedValue(new Error('lost reply'));
  const hook = mount(); await start(hook); await tick();
  expect(hook.result.current.unresolved).toBeNull(); expect(hook.result.current.operation?.id).toBe('export-1');
  expect(imageExportApi.read).toHaveBeenCalledWith('session-1', exportOperation().requestId); expect(imageExportApi.start).toHaveBeenCalledTimes(1);
});
it.each(['InvalidRequestId', 'StaleSession', 'RequestConflict', 'ImageExportBusy', 'ImageExportPreparationExpired', 'ImageExportDestinationUnavailable'])('releases a definite %s start rejection without entering recovery', async code => {
  vi.mocked(imageExportApi.start).mockRejectedValue({ code, message: 'Rejected before registration' });
  const hook = mount(); await start(hook); await tick(2100);
  expect(hook.result.current.error?.code).toBe(code); expect(hook.result.current.unresolved).toBeNull(); expect(hook.result.current.busy).toBe(false); expect(imageExportApi.read).not.toHaveBeenCalled();
});
it('ends an unresolved old start when the new session archive confirms it was never registered', async () => {
  vi.mocked(imageExportApi.start).mockRejectedValue(new Error('lost reply'));
  vi.mocked(imageExportApi.read).mockRejectedValue({ code: 'ImageExportUnavailable', message: 'No registered request' });
  const hook = mount(); await start(hook); expect(hook.result.current.busy).toBe(true);
  hook.rerender({ sessionId: 'session-2' }); await tick();
  expect(hook.result.current.busy).toBe(false); expect(hook.result.current.unresolved).toBeNull(); expect(hook.result.current.failedStart?.requestId).toBe(exportOperation().requestId); expect(hook.result.current.readError?.code).toBe('ImageExportNotStarted');
});
it('rejects a start response or archive entry with the wrong pinned Engine', async () => {
  vi.mocked(imageExportApi.start).mockResolvedValue(exportOperation({ engineId: 'different-engine' }));
  vi.mocked(imageExportApi.read).mockResolvedValue(exportOperation({ engineId: 'different-engine' }));
  const hook = mount(); await start(hook); await tick();
  expect(hook.result.current.operation).toBeNull(); expect(hook.result.current.unresolved).not.toBeNull(); expect(hook.result.current.readError?.code).toBe('InvalidImageExportResponse');
});
it('does not regress a terminal read when an older cancel reply arrives', async () => {
  const pending = deferred<ImageExportOperation>(); vi.mocked(imageExportApi.cancel).mockReturnValue(pending.promise);
  const hook = mount(); await start(hook); act(() => { void hook.result.current.cancel(); });
  const terminal = exportOperation({ phase: 'finished', outcome: 'succeeded', exitCode: 0 }); vi.mocked(imageExportApi.read).mockResolvedValue(terminal); await tick(700);
  await act(async () => pending.resolve(exportOperation()));
  expect(hook.result.current.operation?.outcome).toBe('succeeded'); expect(hook.result.current.busy).toBe(false);
});
it('retains the reviewed path after cancelling the native picker', async () => {
  const hook = mount(); await review(hook); vi.mocked(imageExportApi.pick).mockResolvedValue(null);
  await act(async () => { await hook.result.current.pick(); });
  expect(hook.result.current.modal).toBe('review'); expect(hook.result.current.destination).toEqual(exportDestination); expect(imageExportApi.start).not.toHaveBeenCalled();
});
it('rejects late preview and picker responses after reconnect', async () => {
  const pending = deferred<ImageExportPreview>(); vi.mocked(imageExportApi.prepare).mockReturnValue(pending.promise);
  const hook = mount(); act(() => { void hook.result.current.prepare(exportContainer, exportInventory); }); hook.rerender({ sessionId: 'session-2' });
  await act(async () => pending.resolve(exportPreview));
  expect(hook.result.current.preview).toBeNull(); expect(hook.result.current.modal).toBeNull(); expect(hook.result.current.busy).toBe(false);
});
it('keeps ten historical exports while an old-session result remains readable and cannot be cancelled', async () => {
  vi.mocked(imageExportApi.list).mockResolvedValue(Array.from({ length: 12 }, (_, index) => exportOperation({ id: `job-${index}`, requestId: `request-${index}`, phase: 'finished', outcome: 'succeeded' })).reverse());
  const hook = mount(); await tick(); expect(hook.result.current.recent).toHaveLength(10); expect(hook.result.current.recent.map(item => item.id)).toEqual(Array.from({ length: 10 }, (_, index) => `job-${11 - index}`));
  act(() => hook.result.current.openProgress()); expect(hook.result.current.operation?.id).toBe('job-11');
  hook.rerender({ sessionId: 'session-2' }); await tick(); await act(async () => { await hook.result.current.cancel(); });
  expect(imageExportApi.cancel).not.toHaveBeenCalled(); expect(hook.result.current.operation?.sessionId).toBe('session-1');
});
it('starts on the newest of two archived results and keeps older selection independent', async () => {
  const newest = exportOperation({ id: 'newest', requestId: 'request-new', phase: 'finished', outcome: 'succeeded' });
  const older = exportOperation({ id: 'older', requestId: 'request-old', phase: 'finished', outcome: 'failed' });
  vi.mocked(imageExportApi.list).mockResolvedValue([newest, older]);
  const hook = mount(); await tick(); act(() => hook.result.current.openProgress());
  expect(hook.result.current.operation?.id).toBe('newest'); expect(hook.result.current.recent.map(item => item.id)).toEqual(['newest', 'older']);
  act(() => hook.result.current.selectOperation(older)); expect(hook.result.current.operation?.id).toBe('older'); expect(imageExportApi.start).not.toHaveBeenCalled();
});
