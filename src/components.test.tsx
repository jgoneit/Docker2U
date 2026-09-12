import type { ReactNode } from 'react';
import { PreferencesProvider } from './preferences';
import { useLayoutEffect, useState } from 'react';
import { fireEvent, render as renderUI, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Container, ContainerList } from './api';
import { ConfirmDialog, ContainerDetail, ContainerInformation, ContainerSummary, OperationResult } from './components';
import type { Confirmation } from './components';
import type { ResourceSample } from './useContainerStats';

function render(ui: ReactNode) { return renderUI(<PreferencesProvider initialPreferences={{ theme: 'dark', language: 'ko' }}>{ui}</PreferencesProvider>); }

const container: Container = {
  handle: 'handle-1', fullId: 'a'.repeat(64), shortId: 'a'.repeat(12), name: 'backend',
  image: 'company-api:1', state: 'running', health: 'healthy', ports: [], composeProject: null, composeService: null, createdAt: '2026-09-05T03:00:00Z',
};
const snapshot: ContainerList = {
  sessionId: 'session-1', generation: 1, containers: [container], refreshedAt: '2026-09-05T04:20:00Z', stale: false,
};
const resourceSample: ResourceSample = { handle: container.handle, fullId: container.fullId, available: true,
  cpuPercent: 125.5, memoryUsage: '64MiB / 2GiB', memoryPercent: 3.125, sampledAt: '2026-09-05T04:20:05Z', stale: false };

describe('container summary and information', () => {
  it.each(['ko', 'en'] as const)('keeps the header compact and exposes copyable facts in a separate information region in %s', async language => {
    const user = userEvent.setup();
    const copy = vi.fn(async () => {});
    const target = { ...container, composeProject: 'orders', composeService: 'api' };
    renderUI(<PreferencesProvider initialPreferences={{ theme: 'light', language }}>
      <ContainerSummary container={target} snapshot={snapshot} mutationBlocked={false} mutationAllowed resourceSample={resourceSample} />
      <ContainerInformation container={target} snapshot={snapshot} copy={copy} resourceSample={resourceSample} />
    </PreferencesProvider>);
    const summary = document.querySelector('.container-summary') as HTMLElement;
    expect(within(summary).getByRole('heading', { name: 'backend' })).toBeVisible();
    expect(within(summary).getByText(language === 'ko' ? '실행 중' : 'Running')).toBeVisible();
    expect(within(summary).getByText(language === 'ko' ? '정상' : 'Healthy')).toBeVisible();
    expect(summary.querySelector('details')).toBeNull();
    expect(within(summary).queryByRole('button')).not.toBeInTheDocument();
    for (const text of [container.image, container.fullId, '125.50%', '64MiB / 2GiB']) expect(within(summary).queryByText(text)).not.toBeInTheDocument();
    const information = within(screen.getByRole('region', { name: language === 'ko' ? '컨테이너 정보' : 'Container information' }));
    for (const text of [container.image, container.fullId, 'orders', 'api', '125.50%', '64MiB / 2GiB']) expect(information.getByText(text)).toBeVisible();
    expect(information.getByText(/Docker Engine/)).toBeVisible();
    expect(information.getByText(language === 'ko' ? '목록 갱신 시각' : 'List refreshed at')).toBeVisible();
    expect(information.getByText(language === 'ko' ? /관측 시각/ : /Observed at/)).toBeVisible();
    await user.click(information.getByRole('button', { name: language === 'ko' ? '전체 ID 복사' : 'Copy full ID' }));
    expect(copy).toHaveBeenCalledExactlyOnceWith(container.fullId, 'fullId');
  });
  it('keeps stale resources, unhealthy status and blocked-operation warnings in the header', () => {
    render(<ContainerSummary container={{ ...container, health: 'unhealthy' }} snapshot={{ ...snapshot, stale: true }}
      mutationBlocked mutationAllowed resourceSample={{ ...resourceSample, stale: true }} />);
    for (const text of ['비정상', '이전 정보', '자원 이전 값', '추가 복구 작업이 차단되었습니다. 재연결로 환경을 다시 검증하세요.', '최신 상태를 확인할 수 없어 복구 작업을 잠시 사용할 수 없습니다. 새로고침을 실행하세요.']) {
      expect(screen.getByText(text)).toBeVisible();
    }
  });
  it('puts absent healthcheck information in metadata without hiding real state', () => {
    const target = { ...container, health: null };
    render(<><ContainerSummary container={target} snapshot={snapshot} mutationBlocked={false} mutationAllowed />
      <ContainerInformation container={target} snapshot={snapshot} copy={async () => {}} /></>);
    const summary = document.querySelector('.container-summary') as HTMLElement;
    expect(within(summary).getByText('실행 중')).toBeVisible();
    expect(within(summary).queryByText('상태 검사 기록 없음')).not.toBeInTheDocument();
    const information = within(screen.getByRole('region', { name: '컨테이너 정보' }));
    expect(information.getByText('상태 검사 기록 없음')).toBeVisible();
    expect(information.getByText('수집된 값 없음')).toBeVisible();
  });
  it('updates information across refreshed handles and updated resource samples', async () => {
    const user = userEvent.setup();
    function InformationHarness() {
      const [generation, setGeneration] = useState(1);
      return <><button onClick={() => setGeneration(2)}>Refresh sample</button><ContainerInformation container={{ ...container, handle: `handle-${generation}` }} snapshot={{ ...snapshot, generation }}
        copy={async () => {}} resourceSample={{ ...resourceSample, cpuPercent: generation === 1 ? 125.5 : 0 }} /></>;
    }
    render(<InformationHarness />);
    await user.click(screen.getByRole('button', { name: 'Refresh sample' }));
    expect(screen.getByText(container.fullId)).toBeVisible();
    expect(screen.getByText('0.00%')).toBeVisible();
  });
});

function ConfirmationHarness({ simulateInertFocusLoss = false, closeOnConfirm = false }: { simulateInertFocusLoss?: boolean; closeOnConfirm?: boolean }) {
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  useLayoutEffect(() => {
    // Simulate a browser clearing focus when background content becomes inert.
    if (simulateInertFocusLoss && confirmation && document.activeElement instanceof HTMLElement) document.activeElement.blur();
  }, [confirmation, simulateInertFocusLoss]);
  return <>
    <div data-testid="background" inert={!!confirmation}>
      <button>이전 위치</button>
      <ContainerDetail container={container} snapshot={snapshot} logs={null} logsError={null}
        loadingLogs={false} refreshing={false} mutating={false} mutationBlocked={false} mutationAllowed
        loadLogs={() => {}} clearLogs={() => {}} copy={async () => {}}
        requestAction={(action, returnFocus) => {
          if (action === 'start') return;
          setConfirmation({ container, action, sessionId: snapshot.sessionId, generation: snapshot.generation,
            contextName: 'colima-docker2u', endpoint: 'unix:///fixed/docker.sock', engineId: 'engine-1', returnFocus });
        }} />
    </div>
    {confirmation && <ConfirmDialog confirmation={confirmation} onCancel={() => setConfirmation(null)} onConfirm={() => { if (closeOnConfirm) setConfirmation(null); }} />}
  </>;
}

function BulkConfirmationHarness({ leaveOpen = false, onConfirmed }: { leaveOpen?: boolean; onConfirmed: () => void }) {
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  return <>
    <div inert={!!confirmation}>
      <button onClick={event => setConfirmation({ containers: [container], action: 'stop', sessionId: snapshot.sessionId,
        generation: snapshot.generation, contextName: 'colima-docker2u', endpoint: 'unix:///fixed/docker.sock', engineId: 'engine-1', returnFocus: event.currentTarget })}>Stop (1)</button>
    </div>
    {confirmation && <ConfirmDialog confirmation={confirmation} onCancel={() => setConfirmation(null)} onConfirm={() => { onConfirmed(); if (!leaveOpen) setConfirmation(null); }} />}
  </>;
}

describe('confirmation trigger focus', () => {
  it.each(['중지', '재시작'])('returns to %s after a click that does not focus the button', action => {
    render(<ConfirmationHarness />);
    screen.getByRole('button', { name: '이전 위치' }).focus();
    const trigger = screen.getByRole('button', { name: action });

    // Unlike userEvent.click, this leaves native click-to-focus behavior to the component.
    fireEvent.click(trigger);

    const dialog = screen.getByRole('dialog', { name: `backend ${action} 확인` });
    const cancel = within(dialog).getByRole('button', { name: '취소' });
    expect(cancel).toHaveFocus();
    expect(screen.getByTestId('background')).toHaveAttribute('inert');
    fireEvent.keyDown(cancel, { key: 'Escape' });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByTestId('background')).not.toHaveAttribute('inert');
    expect(trigger).toHaveFocus();
  });
  it.each(['중지', '재시작'])('returns to %s when inert blurs the trigger before dialog effects', action => {
    render(<ConfirmationHarness simulateInertFocusLoss />);
    const trigger = screen.getByRole('button', { name: action });

    fireEvent.click(trigger);

    const cancel = within(screen.getByRole('dialog')).getByRole('button', { name: '취소' });
    expect(cancel).toHaveFocus();
    fireEvent.keyDown(cancel, { key: 'Escape' });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
  it('preserves single-action trigger restoration when confirmation closes the dialog', async () => {
    const user = userEvent.setup();
    render(<ConfirmationHarness closeOnConfirm />);
    const trigger = screen.getByRole('button', { name: '중지' });
    await user.click(trigger);
    await user.click(screen.getByRole('button', { name: '중지 확인' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});

describe('bulk confirmation close reason', () => {
  it('does not restore the bulk trigger immediately after confirmed close', async () => {
    const user = userEvent.setup();
    const confirmed = vi.fn();
    render(<BulkConfirmationHarness onConfirmed={confirmed} />);
    const trigger = screen.getByRole('button', { name: 'Stop (1)' });
    await user.click(trigger);
    await user.click(screen.getByRole('button', { name: '중지 확인' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toBeEnabled();
    expect(trigger).not.toHaveFocus();
    expect(confirmed).toHaveBeenCalledTimes(1);
  });
  it.each(['cancel', 'Escape'] as const)('restores the trigger on %s after a confirm callback leaves the dialog open', async close => {
    const user = userEvent.setup();
    const confirmed = vi.fn();
    render(<BulkConfirmationHarness leaveOpen onConfirmed={confirmed} />);
    const trigger = screen.getByRole('button', { name: 'Stop (1)' });
    await user.click(trigger);
    await user.click(screen.getByRole('button', { name: '중지 확인' }));
    expect(screen.getByRole('dialog')).toBeVisible();
    expect(confirmed).toHaveBeenCalledTimes(1);
    if (close === 'cancel') await user.click(screen.getByRole('button', { name: '취소' }));
    else await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(confirmed).toHaveBeenCalledTimes(1);
  });
});

describe('compact operation details', () => {
  it('keeps result uncertainty visible while native messages, command and identity remain in collapsed details', async () => {
    const user = userEvent.setup();
    const command = 'docker --host unix:///fixed/docker.sock container restart RAW_ID';
    const operation = { fullId: container.fullId, name: container.name, action: 'restart' as const,
      contextName: 'raw-context', endpoint: 'unix:///raw/socket', engineId: 'RAW_ENGINE',
      outcome: 'resultUnknown' as const, message: '원문 diagnostic stays unchanged', command, stderr: 'raw stderr',
      reconciliation: 'succeeded' as const, observedState: 'running', mutationBlocked: false };
    render(<><OperationResult operation={operation} copy={vi.fn(async () => {})} /><ContainerDetail container={container} snapshot={snapshot} logs={null} logsError={null}
      loadingLogs={false} refreshing={false} mutating={false} mutationBlocked={false} mutationAllowed
      loadLogs={vi.fn()} clearLogs={vi.fn()} copy={vi.fn(async () => {})} requestAction={vi.fn()} /></>);
    const report = screen.getByRole('region', { name: '최근 작업 결과' });
    expect(within(report).getByRole('heading', { name: '결과 불명 · 재시작 · backend' })).toBeVisible();
    expect(within(report).getByText(/자동 재시도하지 않았습니다/)).toBeVisible();
    expect(within(report).getByText(/대상 상태 재조회 완료 · 실행 중/)).toBeVisible();
    expect(within(report).getByText(operation.message)).not.toBeVisible();
    expect(within(report).getByText(command)).not.toBeVisible();
    await user.click(within(report).getByText('실행 상세'));
    expect(within(report).getByText(operation.message)).toBeVisible();
    expect(within(report).getByText(command)).toBeVisible();
    expect(within(report).getByText('RAW_ENGINE')).toBeVisible();
    const recovery = screen.getByRole('region', { name: '서비스 복구' });
    const logs = screen.getByRole('region', { name: '최근 로그' });
    expect(recovery.compareDocumentPosition(logs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole('tabpanel', { name: '로그' })).toContainElement(logs);
  });

  it('closes locally controlled expanded logs when the selected target changes', async () => {
    const user = userEvent.setup();
    function SelectionHarness() {
      const [selected, setSelected] = useState(container);
      return <><button onClick={() => setSelected({ ...container, handle: 'new-handle', name: 'another-container' })}>Simulate selection change</button>
        <ContainerSummary container={selected} snapshot={snapshot} mutationBlocked={false} mutationAllowed />
        <ContainerDetail container={selected} snapshot={snapshot} logs={null} logsError={null}
          loadingLogs={false} refreshing={false} mutating={false} mutationBlocked={false} mutationAllowed
          loadLogs={vi.fn()} clearLogs={vi.fn()} copy={vi.fn(async () => {})} requestAction={vi.fn()} />
      </>;
    }
    render(<SelectionHarness />);
    await user.click(screen.getByRole('button', { name: '로그 확대 보기' }));
    expect(screen.getByRole('dialog')).toBeVisible();
    // The App normally makes this control inert; simulate a programmatic target replacement.
    fireEvent.click(screen.getByRole('button', { name: 'Simulate selection change' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'another-container' })).toBeVisible();
  });
});


describe('independent latest operation result', () => {
  it.each(['succeeded', 'failed'] as const)('summarizes a definitive %s result and exposes its details on request', async outcome => {
    const user = userEvent.setup();
    render(<OperationResult operation={{ fullId: container.fullId, name: container.name, action: 'restart', contextName: 'ctx', endpoint: 'unix:///fixed', engineId: 'engine', outcome, message: 'raw diagnostic', command: '', stderr: '', reconciliation: 'succeeded', observedState: 'running', mutationBlocked: false }} copy={vi.fn(async () => {})} />);
    const result = screen.getByRole('region', { name: '최근 작업 결과' });
    expect(within(result).getByRole('heading')).toHaveTextContent(`재시작 · ${container.name}`);
    const toggle = within(result).getByRole('button', { name: '결과 펼치기' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(within(result).getByText(/대상 상태 재조회 완료/)).not.toBeVisible();
    await user.click(toggle);
    expect(within(result).getByText(/대상 상태 재조회 완료/)).toBeVisible();
    expect(within(result).getByRole('button', { name: '결과 접기' })).toHaveAttribute('aria-expanded', 'true');
  });
  it.each(['blocked', 'reconciliation'] as const)('does not collapse a known outcome with a %s reconnect warning', source => {
    render(<OperationResult operation={{ fullId: container.fullId, name: container.name, action: 'restart', contextName: 'ctx', endpoint: 'unix:///fixed', engineId: 'engine', outcome: 'succeeded', message: 'raw diagnostic', command: '', stderr: '', reconciliation: source === 'reconciliation' ? 'failed' : 'succeeded', mutationBlocked: source === 'blocked' }} copy={vi.fn(async () => {})} />);
    const result = screen.getByRole('region', { name: '최근 작업 결과' });
    expect(result).toHaveClass('outcome-resultUnknown');
    expect(within(result).queryByRole('button', { name: '결과 펼치기' })).not.toBeInTheDocument();
    expect(within(result).getByText(/재연결/)).toBeVisible();
  });
});
