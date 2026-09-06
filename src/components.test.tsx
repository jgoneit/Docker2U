import { useLayoutEffect, useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Container, ContainerList } from './api';
import { ConfirmDialog, ContainerDetail } from './components';
import type { Confirmation } from './components';

const container: Container = {
  handle: 'handle-1', fullId: 'a'.repeat(64), shortId: 'a'.repeat(12), name: 'backend',
  image: 'company-api:1', state: 'running', health: 'healthy', ports: [], createdAt: '2026-09-05T03:00:00Z',
};
const snapshot: ContainerList = {
  sessionId: 'session-1', generation: 1, containers: [container], refreshedAt: '2026-09-05T04:20:00Z', stale: false,
};

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
        operation={null} loadLogs={() => {}} clearLogs={() => {}} copy={async () => {}}
        requestAction={(action, returnFocus) => {
          if (action === 'start') return;
          setConfirmation({ container, action, sessionId: snapshot.sessionId, generation: snapshot.generation,
            profile: 'colima-docker2u', endpoint: 'unix:///fixed/docker.sock', returnFocus });
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
        generation: snapshot.generation, profile: 'colima-docker2u', endpoint: 'unix:///fixed/docker.sock', returnFocus: event.currentTarget })}>Stop (1)</button>
    </div>
    {confirmation && <ConfirmDialog confirmation={confirmation} onCancel={() => setConfirmation(null)} onConfirm={() => { onConfirmed(); if (!leaveOpen) setConfirmation(null); }} />}
  </>;
}

describe('confirmation trigger focus', () => {
  it.each(['Stop', 'Restart'])('returns to %s after a click that does not focus the button', action => {
    render(<ConfirmationHarness />);
    screen.getByRole('button', { name: '이전 위치' }).focus();
    const trigger = screen.getByRole('button', { name: action });

    // Unlike userEvent.click, this leaves native click-to-focus behavior to the component.
    fireEvent.click(trigger);

    const dialog = screen.getByRole('dialog', { name: `${action} backend?` });
    const cancel = within(dialog).getByRole('button', { name: '취소' });
    expect(cancel).toHaveFocus();
    expect(screen.getByTestId('background')).toHaveAttribute('inert');
    fireEvent.keyDown(cancel, { key: 'Escape' });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByTestId('background')).not.toHaveAttribute('inert');
    expect(trigger).toHaveFocus();
  });
  it.each(['Stop', 'Restart'])('returns to %s when inert blurs the trigger before dialog effects', action => {
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
    const trigger = screen.getByRole('button', { name: 'Stop' });
    await user.click(trigger);
    await user.click(screen.getByRole('button', { name: 'Stop 확인' }));
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
    await user.click(screen.getByRole('button', { name: 'Stop 확인' }));
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
    await user.click(screen.getByRole('button', { name: 'Stop 확인' }));
    expect(screen.getByRole('dialog')).toBeVisible();
    expect(confirmed).toHaveBeenCalledTimes(1);
    if (close === 'cancel') await user.click(screen.getByRole('button', { name: '취소' }));
    else await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(confirmed).toHaveBeenCalledTimes(1);
  });
});
