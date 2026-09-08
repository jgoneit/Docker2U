import type { Container } from './api';

export type ProjectFilter = { kind: 'all' } | { kind: 'none' } | { kind: 'project'; name: string };
export type ContainerFilter = 'all' | 'running' | 'stopped' | 'attention';
export const allProjects: ProjectFilter = { kind: 'all' };
export function projectName(container: Container): string | null {
  return container.composeProject?.trim() ? container.composeProject : null;
}
export function matchesContainer(container: Container, query: string, filter: ContainerFilter, project: ProjectFilter = allProjects) {
  const name = projectName(container);
  const projectMatches = project.kind === 'all' || (project.kind === 'none' ? name === null : name === project.name);
  const searchMatches = [container.name, container.image, container.shortId, container.fullId, ...container.ports, name ?? '', container.composeService ?? ''].join(' ').toLowerCase().includes(query.trim().toLowerCase());
  const filterMatches = filter === 'all' || (filter === 'running' && container.state === 'running')
    || (filter === 'stopped' && ['created', 'exited'].includes(container.state))
    || (filter === 'attention' && (container.health === 'unhealthy' || ['dead', 'paused', 'restarting', 'removing', 'unknown'].includes(container.state)));
  return projectMatches && searchMatches && filterMatches;
}
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
export function groupContainers(containers: Container[]) {
  const groups = new Map<string | null, Container[]>();
  for (const container of containers) {
    const key = projectName(container);
    const group = groups.get(key) ?? [];
    group.push(container); groups.set(key, group);
  }
  return [...groups].sort(([a], [b]) => a === null ? 1 : b === null ? -1 : compare(a, b))
    .map(([name, items]) => ({ name, containers: items.sort((a, b) => compare(a.name, b.name) || compare(a.fullId, b.fullId)) }));
}
export function projectFilterValue(filter: ProjectFilter) {
  return filter.kind === 'project' ? JSON.stringify(['project', filter.name]) : filter.kind;
}
export function parseProjectFilter(value: string): ProjectFilter {
  if (value === 'all' || value === 'none') return { kind: value };
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.length === 2 && parsed[0] === 'project' && typeof parsed[1] === 'string') return { kind: 'project', name: parsed[1] };
  } catch { /* A removed option resets to the full inventory. */ }
  return allProjects;
}
