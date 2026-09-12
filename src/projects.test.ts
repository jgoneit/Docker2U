import { expect, it } from 'vitest';
import type { Container } from './api';
import { groupContainers, matchesContainer, parseProjectFilter, projectFilterValue } from './projects';
const row = (name: string, composeProject: string | null = null, composeService: string | null = null): Container => ({ handle: name, fullId: name, shortId: name, name, image: 'image', state: 'running', health: null, ports: [], composeProject, composeService, createdAt: '' });
it('sorts projects then container names, preserves standalone group and does not mutate source', () => {
  const rows = [row('z', 'beta'), row('b', 'alpha'), row('a', 'alpha'), row('single'), row('empty', '')];
  expect(groupContainers(rows).map(group => [group.name, group.containers.map(item => item.name)])).toEqual([['alpha', ['a', 'b']], ['beta', ['z']], [null, ['empty', 'single']]]);
  expect(rows[0]!.name).toBe('z');
});
it('combines project, service search and state filters before calculating group counts', () => {
  const rows = [row('one', 'orders', 'api'), row('two', 'orders', 'redis'), row('three', 'other', 'api')];
  const matching = rows.filter(item => matchesContainer(item, 'API', 'running', { kind: 'project', name: 'orders' }));
  expect(groupContainers(matching)[0]?.containers.map(item => item.name)).toEqual(['one']);
  expect(matchesContainer(rows[0]!, 'orders', 'all')).toBe(true);
  expect(matchesContainer({ ...rows[0]!, state: 'exited' }, '', 'running')).toBe(false);
  expect(matchesContainer(row('single'), '', 'all', { kind: 'none' })).toBe(true);
});
it('keeps project names distinct from selector sentinel values', () => {
  for (const name of ['all', 'none', '프로젝트 없음', 'quoted " project']) {
    const filter = { kind: 'project', name } as const;
    expect(parseProjectFilter(projectFilterValue(filter))).toEqual(filter);
  }
  expect(parseProjectFilter('invalid')).toEqual({ kind: 'all' });
});

import { projectTreeGroups } from './projects';
import type { ComposeProject } from './composeApi';
const registration: ComposeProject = { id: 'registration-1', name: 'orders', revision: 1, composeFile: '/work/compose.yaml', workingDirectory: '/work', envFile: null };
it('merges a registration into its discovered name without duplicate rows or invented handles', () => {
  const api = row('api', 'orders'); const groups = projectTreeGroups([api, row('standalone')], [registration], '', 'all');
  expect(groups.map(group => group.name)).toEqual(['orders', null]); expect(groups[0]?.registration).toEqual(registration);
  expect(groups[0]?.containers).toEqual([api]);
});
it('keeps registrations without containers in all and stopped, but not running filters', () => {
  expect(projectTreeGroups([], [registration], '', 'all')[0]?.containers).toEqual([]);
  expect(projectTreeGroups([], [registration], '', 'stopped')).toHaveLength(1);
  expect(projectTreeGroups([], [registration], '', 'running')).toEqual([]);
});
it('searches empty registrations by project and directory and keeps configuration errors in attention', () => {
  expect(projectTreeGroups([], [registration], '/work', 'all')).toHaveLength(1);
  expect(projectTreeGroups([], [registration], 'missing', 'all')).toEqual([]);
  const issue = { code: 'ComposeProjectConflict', message: 'Configuration does not match.' };
  expect(projectTreeGroups([], [registration], '', 'attention', new Map([['orders', issue]]))[0]?.issue).toEqual(issue);
});
it('retains a discovered row after unregistering and removes only the absent registration', () => {
  const containers = [row('api', 'orders')];
  expect(projectTreeGroups(containers, [], '', 'all')[0]?.name).toBe('orders');
  expect(projectTreeGroups([], [], '', 'all')).toEqual([]);
});
