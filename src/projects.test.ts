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
