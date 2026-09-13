import { expect, it } from 'vitest';
import { validImageExportOperation } from './imageExportApi';
import { exportOperation } from './test/imageExportData';
it('requires an immutable image ID and a consistent terminal outcome', () => {
  expect(validImageExportOperation(exportOperation())).toBe(true);
  expect(validImageExportOperation(exportOperation({ imageId: 'app:latest' }))).toBe(false);
  expect(validImageExportOperation(exportOperation({ phase: 'finished' }))).toBe(false);
  expect(validImageExportOperation(exportOperation({ outcome: 'succeeded' }))).toBe(false);
});
it('rejects invalid byte counts and missing error-output metadata', () => {
  expect(validImageExportOperation(exportOperation({ bytesWritten: -1 }))).toBe(false);
  expect(validImageExportOperation(exportOperation({ bytesWritten: Infinity }))).toBe(false);
  expect(validImageExportOperation(exportOperation({ elapsedMs: NaN }))).toBe(false);
  expect(validImageExportOperation({ ...exportOperation(), stderr: undefined } as unknown as ReturnType<typeof exportOperation>)).toBe(false);
});
