import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import App from './App';
import { api, type Environment } from './api';
import { imageExportApi } from './imageExportApi';
import { exportContainer, exportDestination, exportInventory, exportOperation, exportPreview } from './test/imageExportData';
import { installSnapshotStreams } from './test/snapshotStreams';
import { containerDetailsFixture } from './test/containerDetailsFixture';

vi.mock('./api', async original => ({ ...await original<typeof import('./api')>(), api: {
  getEnvironment: vi.fn(), listContainers: vi.fn(), getRecentLogs: vi.fn(), startLogStream: vi.fn(), readLogStream: vi.fn(),
  stopLogStream: vi.fn(), getContainerStats: vi.fn(), getContainerDetails: vi.fn(), mutateContainer: vi.fn(), mutateContainers: vi.fn(),
} }));
const tick = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const click = (element: HTMLElement) => act(async () => { element.focus(); fireEvent.click(element); });
async function mount() { render(<App />); await tick(); expect(screen.getByRole('treeitem', { name: 'web 상세' })).toBeVisible(); }
const dialog = () => within(screen.getByRole('dialog'));
async function review() { await click(screen.getByRole('button', { name: '이미지 내보내기' })); }
async function start() { await review(); await click(dialog().getByRole('button', { name: '저장 위치 선택' })); await click(dialog().getByRole('button', { name: '내보내기 시작' })); }
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-13T00:00:00Z')); vi.resetAllMocks();
  localStorage.setItem('docker2u.preferences.v1', JSON.stringify({ theme: 'dark', language: 'ko' }));
  installSnapshotStreams(vi.mocked(api));
  vi.mocked(api.getEnvironment).mockResolvedValue({ status: 'ready', sessionId: 'session-1', contextName: 'desktop', endpoint: 'unix:///engine.sock', engineId: 'engine-1', mutationAllowed: true, error: null, diagnostics: [] } as unknown as Environment);
  vi.mocked(api.listContainers).mockResolvedValue(exportInventory);
  vi.mocked(api.getRecentLogs).mockResolvedValue({ sessionId: 'session-1', generation: 1, handle: exportContainer.handle, text: 'service ready\nsearch target', truncated: false, byteCount: 27, command: 'fixture logs', stderr: '' });
  vi.mocked(api.getContainerDetails).mockResolvedValue(containerDetailsFixture(exportContainer, exportInventory));
  vi.spyOn(crypto, 'randomUUID').mockReturnValue(exportOperation().requestId as `${string}-${string}-${string}-${string}-${string}`);
  vi.spyOn(imageExportApi, 'available').mockReturnValue(true); vi.spyOn(imageExportApi, 'list').mockResolvedValue([]);
  vi.spyOn(imageExportApi, 'prepare').mockResolvedValue(exportPreview); vi.spyOn(imageExportApi, 'pick').mockResolvedValue(exportDestination);
  vi.spyOn(imageExportApi, 'start').mockResolvedValue(exportOperation()); vi.spyOn(imageExportApi, 'read').mockResolvedValue(exportOperation());
  vi.spyOn(imageExportApi, 'cancel').mockResolvedValue(exportOperation({ phase: 'finished', outcome: 'cancelled' }));
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it('offers export on every container tab, including stopped containers, and reviews the inspected ID and chosen path', async () => {
  vi.mocked(api.listContainers).mockResolvedValue({ ...exportInventory, containers: [{ ...exportContainer, state: 'exited' }] });
  await mount();
  for (const name of ['상태 진단', '접속 정보', '이력', '로그']) { await click(screen.getByRole('tab', { name })); expect(screen.getByRole('button', { name: '이미지 내보내기' })).toBeEnabled(); }
  await review(); expect(dialog().getByText(exportPreview.imageId)).toBeVisible(); expect(dialog().getByText(exportContainer.image)).toBeVisible();
  expect(dialog().queryByRole('textbox')).not.toBeInTheDocument(); expect(dialog().getByRole('button', { name: '내보내기 시작' })).toBeDisabled();
  expect(dialog().getByText(/볼륨·마운트 데이터는 포함되지/)).toBeVisible();
  await click(dialog().getByRole('button', { name: '저장 위치 선택' })); expect(dialog().getByText(exportDestination.path)).toBeVisible();
  expect(imageExportApi.start).not.toHaveBeenCalled();
  await click(dialog().getByRole('button', { name: '내보내기 시작' }));
  expect(screen.getByRole('dialog', { name: '이미지 내보내기 작업' })).toBeVisible(); expect(api.mutateContainer).not.toHaveBeenCalled();
});
it('keeps log search, pause and scroll when export closes and reopens, with focus returning to the recent export', async () => {
  await mount(); await click(screen.getByRole('button', { name: '일시정지' })); await click(screen.getByRole('button', { name: '로그 검색 열기' }));
  const search = screen.getByRole('searchbox', { name: '로그 검색' }); act(() => fireEvent.change(search, { target: { value: 'target' } }));
  const content = screen.getByLabelText('최근 로그 내용'); content.scrollTop = 80; fireEvent.scroll(content);
  await start(); expect(screen.getByRole('dialog').closest('[inert]')).toBeNull(); expect(document.querySelector('.main-content')).toHaveAttribute('inert');
  act(() => fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' }));
  const recent = screen.getByRole('button', { name: '최근 이미지 내보내기' }); expect(recent).toHaveFocus();
  expect(screen.getByLabelText('최근 로그 내용')).toBe(content); expect(content.scrollTop).toBe(80); expect(search).toHaveValue('target'); expect(screen.getByRole('button', { name: '재개' })).toHaveAttribute('aria-pressed', 'true');
  await click(recent); expect(screen.getByRole('dialog', { name: '이미지 내보내기 작업' })).toBeVisible(); expect(imageExportApi.start).toHaveBeenCalledTimes(1); expect(imageExportApi.cancel).not.toHaveBeenCalled();
});
it('returns from a cancelled save picker and keeps the start button disabled until a path is chosen', async () => {
  vi.mocked(imageExportApi.pick).mockResolvedValue(null); await mount(); await review(); await click(dialog().getByRole('button', { name: '저장 위치 선택' }));
  expect(screen.getByRole('dialog', { name: '이미지 내보내기 확인' })).toBeVisible(); expect(dialog().getByRole('button', { name: '내보내기 시작' })).toBeDisabled();
  act(() => fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })); expect(screen.getByRole('button', { name: '이미지 내보내기' })).toHaveFocus();
});
it('shows a localizable preparation failure and keeps raw diagnostics in a disclosure', async () => {
  vi.mocked(imageExportApi.prepare).mockRejectedValue({ code: 'ImageExportPreparationExpired', message: 'Expired native preview' });
  await mount(); await review(); expect(dialog().getByText('확인 정보가 만료되었습니다. 창을 닫고 이미지 내보내기를 다시 여세요.')).toBeVisible(); expect(dialog().getByText('Expired native preview')).not.toBeVisible();
});
it('copies only the successfully published path and preserves terminal success after closing the window', async () => {
  const writeText = vi.fn(async () => {}); Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  vi.mocked(imageExportApi.read).mockResolvedValue(exportOperation({ phase: 'finished', outcome: 'succeeded', exitCode: 0 }));
  await mount(); await start(); await tick(); await click(dialog().getByRole('button', { name: '저장 경로 복사' }));
  expect(writeText).toHaveBeenCalledExactlyOnceWith(exportDestination.path); expect(dialog().getByText('저장 경로 복사됨')).toBeVisible();
  act(() => fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })); await click(screen.getByRole('button', { name: '최근 이미지 내보내기' })); expect(dialog().getByText('파일 저장 완료')).toBeVisible();
});
it('keeps the modal exclusive, traps Tab, and exposes failed output without a successful-path copy action', async () => {
  vi.mocked(imageExportApi.read).mockResolvedValue(exportOperation({ phase: 'finished', outcome: 'failed', exitCode: 1, stderr: 'native stderr details', error: { code: 'ImageExportDestinationExists', message: 'Destination exists' } }));
  await mount();
  const settings = screen.getByRole('button', { name: '설정' });
  act(() => { fireEvent.click(screen.getByRole('button', { name: '이미지 내보내기' })); fireEvent.click(settings); }); await tick();
  expect(screen.getAllByRole('dialog')).toHaveLength(1); expect(screen.getByRole('dialog', { name: '이미지 내보내기 확인' })).toBeVisible();
  await click(dialog().getByRole('button', { name: '저장 위치 선택' })); await click(dialog().getByRole('button', { name: '내보내기 시작' })); await tick();
  expect(dialog().getByText('같은 이름의 파일이 이미 있습니다. 다른 파일 이름이나 위치를 선택하세요.')).toBeVisible();
  expect(dialog().queryByRole('button', { name: '저장 경로 복사' })).not.toBeInTheDocument();
  await click(dialog().getByText('실행 상세')); expect(dialog().getByLabelText('명령 오류 출력')).toHaveTextContent('native stderr details');
  const closes = dialog().getAllByRole('button', { name: '닫기' }); closes.at(-1)!.focus(); act(() => fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab' })); expect(closes[0]).toHaveFocus();
});
