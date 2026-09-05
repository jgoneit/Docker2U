import { useLayoutEffect, useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
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

function ConfirmationHarness({ simulateInertFocusLoss = false }: { simulateInertFocusLoss?: boolean }) {
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
    {confirmation && <ConfirmDialog confirmation={confirmation} onCancel={() => setConfirmation(null)} onConfirm={() => {}} />}
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
});
