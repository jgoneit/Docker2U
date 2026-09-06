import type { CoreError } from './api';
import type { Language } from './i18n';
import { frontendErrorMessages } from './messages/errors';

type FrontendErrorKey = keyof typeof frontendErrorMessages;
export type FrontendErrorDescriptor = Readonly<{ origin: 'frontend'; key: FrontendErrorKey }>;
const frontendSource = Symbol('frontend error message');
type FrontendError = CoreError & { [frontendSource]: FrontendErrorDescriptor };
const codes: Record<FrontendErrorKey, string> = {
  staleInventory: 'STALE_RESPONSE', staleLogs: 'STALE_RESPONSE', invalidBulkResponse: 'INVALID_BULK_RESPONSE',
  ipcFailure: 'IPC_FAILURE', nativeRequired: 'NATIVE_REQUIRED',
};

/** The private symbol cannot arrive in native JSON; only locally created messages are translated. */
export function frontendError(key: FrontendErrorKey): FrontendError {
  return { code: codes[key], message: frontendErrorMessages[key].ko, [frontendSource]: { origin: 'frontend', key } };
}
export function frontendErrorDescriptor(error: object): FrontendErrorDescriptor | undefined {
  return (error as Partial<FrontendError>)[frontendSource];
}
/** Resolve at render time so a retained error follows subsequent language changes. */
export function displayErrorMessage(error: { message: string }, language: Language, descriptor = frontendErrorDescriptor(error)): string {
  return descriptor ? frontendErrorMessages[descriptor.key][language] : error.message;
}
