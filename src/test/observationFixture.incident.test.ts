import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../api';
import { observationApi, projectLogApi, type ProjectLogPage, type ProjectLogQuery, type ProjectLogRow } from '../observationApi';
import { exportInventory } from './imageExportData';
import { installObservationFixture, queryObservationFixtureLogs } from './observationFixture';

const query: ProjectLogQuery = { sourceIds: [], keyword: '', offset: null, limit: 3, throughSequence: null };
function row(index: number, timestamp: string | null = `2026-09-13T00:00:${String(index).padStart(2, '0')}Z`): ProjectLogRow {
  return { rowId: `row-${index}`, sequence: index + 1, sourceId: 'a'.repeat(64), fullId: 'a'.repeat(64), serviceName: 'api', containerName: 'api-1', timestamp, receivedAt: `2026-09-13T00:00:${String(index).padStart(2, '0')}Z`, pipe: 'stdout', text: `request ${index}`, truncated: false };
}
function page(rows = Array.from({ length: 10 }, (_, index) => row(index))): ProjectLogPage {
  return { sessionId: 'session-1', project: 'orders', revision: 1, maxSequence: 10, rows, sources: [], totalRows: rows.length, offset: 0, droppedRows: 7, coverageGaps: 2, needsSelection: false, error: null, retainedFrom: rows[0]?.timestamp ?? null, retainedTo: rows.at(-1)?.timestamp ?? null };
}
const originals = { api: { ...api }, observation: { ...observationApi }, logs: { ...projectLogApi } };
afterEach(() => { Object.assign(api, originals.api); Object.assign(observationApi, originals.observation); Object.assign(projectLogApi, originals.logs); vi.restoreAllMocks(); vi.useRealTimers(); });

it('filters inclusive nanosecond bounds and keeps source coverage before the time filter', () => {
  const rows = [row(0, '2026-09-13T00:00:00.000000001Z'), row(1, '2026-09-13T09:00:00.000000002+09:00'), row(2, '2026-09-13T00:00:00.000000003Z')];
  const result = queryObservationFixtureLogs(page(rows), { ...query, timeFrom: rows[1]!.timestamp, timeTo: rows[1]!.timestamp });
  expect(result.rows.map(item => item.rowId)).toEqual(['row-1']);
  expect(result).toMatchObject({ totalRows: 1, retainedFrom: rows[0]!.timestamp, retainedTo: rows[2]!.timestamp, droppedRows: 7, coverageGaps: 2 });
});

it('uses receipt time for absent or invalid timestamps without broadening source and sequence filters', () => {
  const rows = [row(0), row(1, null), row(2, 'invalid'), { ...row(3), sourceId: 'b'.repeat(64) }, row(4)];
  const result = queryObservationFixtureLogs(page(rows), { ...query, sourceIds: ['a'.repeat(64)], afterSequence: 1, throughSequence: 4, timeFrom: '2026-09-13T00:00:02Z', timeTo: '2026-09-13T00:00:02Z' });
  expect(result.rows.map(item => item.rowId)).toEqual(['row-2']);
  expect(result).toMatchObject({ retainedFrom: rows[1]!.receivedAt, retainedTo: rows[2]!.receivedAt });
});

it('centers the nearest anchor, favors the earlier tie, and fills a final page', () => {
  expect(queryObservationFixtureLogs(page(), { ...query, anchorTime: '2026-09-13T00:00:04.5Z' }).rows.map(item => item.rowId)).toEqual(['row-3', 'row-4', 'row-5']);
  expect(queryObservationFixtureLogs(page(), { ...query, anchorTime: '2026-09-13T00:00:09Z' }).rows.map(item => item.rowId)).toEqual(['row-7', 'row-8', 'row-9']);
  expect(queryObservationFixtureLogs(page(), { ...query, offset: 1, anchorTime: '2026-09-13T00:00:09Z' }).offset).toBe(1);
  expect(queryObservationFixtureLogs(page(), { ...query, anchorRowId: 'row-2', anchorTime: '2026-09-13T00:00:09Z' }).offset).toBe(2);
  expect(queryObservationFixtureLogs(page(), { ...query, anchorRowId: 'missing', anchorTime: '2026-09-13T00:00:04Z' })).toMatchObject({ offset: 7, anchorLost: true });
});

it('preserves legacy latest queries and reports retained coverage for an empty incident window', () => {
  expect(queryObservationFixtureLogs(page(), query)).toMatchObject({ rows: [row(7), row(8), row(9)], offset: 7, totalRows: 10 });
  expect(queryObservationFixtureLogs(page(), { ...query, timeFrom: '2026-09-13T01:00:00Z', timeTo: '2026-09-13T01:01:00Z' })).toMatchObject({ rows: [], totalRows: 0, retainedFrom: row(0).timestamp, retainedTo: row(9).timestamp });
});

it.each([
  { timeFrom: 'invalid' },
  { timeFrom: '2026-09-13T00:00:05Z', timeTo: '2026-09-13T00:00:04Z' },
  { timeTo: '2026-09-13T00:00:04Z', anchorTime: '2026-09-13T00:00:05Z' },
])('rejects invalid incident bounds %j', selection => {
  expect(() => queryObservationFixtureLogs(page(), { ...query, ...selection })).toThrow(expect.objectContaining({ code: 'InvalidSelection' }));
});

it('supports an incident query through the installed transport without configuring collection', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-13T00:00:00Z'));
  api.listContainers = vi.fn(async () => ({ ...exportInventory, containers: exportInventory.containers.map(container => ({ ...container, composeProject: 'orders' })) }));
  installObservationFixture();
  const result = await projectLogApi.query('session-1', 'orders', { ...query, timeFrom: '2026-09-12T23:59:59Z', timeTo: '2026-09-13T00:00:01Z', anchorTime: '2026-09-13T00:00:00Z' });
  expect(result.rows).toHaveLength(3);
  expect(result.rows[1]!.rowId).toBe('row-2400');
  expect((window as unknown as { __docker2uObservationCalls: Record<string, number> }).__docker2uObservationCalls).toEqual({ queryLogs: 1 });
});
