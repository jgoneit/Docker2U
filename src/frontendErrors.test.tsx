import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { api, coreError, type CoreError } from './api';
import { ErrorDetails } from './components';
import { displayErrorMessage, frontendError, frontendErrorDescriptor } from './frontendErrors';
import { frontendErrorMessages } from './messages/errors';
import { PreferencesProvider, usePreferences } from './preferences';

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => false, invoke: vi.fn() }));

function ErrorHarness({ error }: { error: CoreError }) {
  const { setLanguage } = usePreferences();
  return <><button onClick={() => setLanguage('en')}>English</button><button onClick={() => setLanguage('ko')}>한국어</button><ErrorDetails error={error} /></>;
}

describe('frontend error message ownership', () => {
  it('tags only the API-generated browser and unknown-transport fallbacks', async () => {
    const browserError = await api.getEnvironment().catch(coreError);
    expect(frontendErrorDescriptor(browserError)?.key).toBe('nativeRequired');
    expect(displayErrorMessage(browserError as CoreError, 'en')).toBe(frontendErrorMessages.nativeRequired.en);
    const unknownTransport = coreError(null);
    expect(frontendErrorDescriptor(unknownTransport)?.key).toBe('ipcFailure');
    expect(displayErrorMessage(unknownTransport, 'en')).toBe(frontendErrorMessages.ipcFailure.en);
  });
  it.each(Object.keys(frontendErrorMessages) as Array<keyof typeof frontendErrorMessages>)('renders retained %s guidance in the active language', async key => {
    const user = userEvent.setup();
    const error = frontendError(key);
    render(<PreferencesProvider initialPreferences={{ theme: 'dark', language: 'ko' }}><ErrorHarness error={error} /></PreferencesProvider>);
    await user.click(screen.getByText(`진단 상세 · ${error.code}`));
    expect(screen.getByText(frontendErrorMessages[key].ko)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'English' }));
    expect(screen.getByText(frontendErrorMessages[key].en)).toBeVisible();
    expect(screen.queryByText(frontendErrorMessages[key].ko)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '한국어' }));
    expect(screen.getByText(frontendErrorMessages[key].ko)).toBeVisible();
    expect(error.message).toBe(frontendErrorMessages[key].ko);
  });

  it('distinguishes list and log guidance despite their shared code', () => {
    const inventory = frontendError('staleInventory');
    const logs = frontendError('staleLogs');
    expect(inventory.code).toBe(logs.code);
    expect(displayErrorMessage(inventory, 'en')).toBe(frontendErrorMessages.staleInventory.en);
    expect(displayErrorMessage(logs, 'en')).toBe(frontendErrorMessages.staleLogs.en);
    expect(coreError(logs)).toBe(logs);
    expect(frontendErrorDescriptor(coreError(logs))?.key).toBe('staleLogs');
  });

  it('preserves native JSON and Error.message even with overlapping frontend codes', async () => {
    const user = userEvent.setup();
    const error = { code: 'STALE_RESPONSE', message: '네이티브 원문 unchanged', command: 'docker logs exact-id', stderr: '원문 stderr', frontendError: { origin: 'frontend', key: 'staleLogs' } };
    expect(coreError(error)).toBe(error);
    expect(frontendErrorDescriptor(error)).toBeUndefined();
    render(<PreferencesProvider initialPreferences={{ theme: 'dark', language: 'ko' }}><ErrorHarness error={error} /></PreferencesProvider>);
    await user.click(screen.getByText('진단 상세 · STALE_RESPONSE'));
    await user.click(screen.getByRole('button', { name: 'English' }));
    expect(screen.getByText(error.message)).toBeVisible();
    expect(screen.getByText(error.command)).toBeVisible();
    expect(screen.getByText(error.stderr)).toBeVisible();
    const transport = coreError(new Error('WebView 원문 disconnected'));
    expect(displayErrorMessage(transport, 'en')).toBe('WebView 원문 disconnected');
    expect(frontendErrorDescriptor(transport)).toBeUndefined();
  });
});
