import { useId, useRef, useState } from 'react';
import type { KeyboardEvent, RefObject } from 'react';
import { ChevronRight, FolderClosed, FolderOpen } from 'lucide-react';
import type { Container } from './api';
import { Health, State } from './components';
import { useI18n } from './i18n';
import { appMessages } from './messages/app';
import type { ProjectTreeGroup } from './projects';
import { composeMessages } from './messages/compose';
import type { ResourceSample } from './useContainerStats';
import './containerTable.css';

const messages = {
  standalone: { ko: '독립 컨테이너', en: 'Standalone containers' },
  projectView: { ko: '{name} 프로젝트', en: '{name} project' },
  collapse: { ko: '{name} 접기', en: 'Collapse {name}' },
  expand: { ko: '{name} 펼치기', en: 'Expand {name}' },
  selectedChild: { ko: '선택한 컨테이너: {name}', en: 'Selected container: {name}' },
  memory: { ko: '메모리', en: 'Memory' },
  health: { ko: '헬스', en: 'Health' },
  stale: { ko: '오래된 값', en: 'Stale sample' },
  count: { ko: '{count}개 컨테이너', en: '{count} containers' },
  connectionsFor: { ko: '{name} 접속 정보 보기', en: 'View connections for {name}' },
};

export type NavigationTarget = { kind: 'standalone' } | { kind: 'project'; name: string } | { kind: 'container'; fullId: string } | null;
export interface ContainerTableProps {
  groups: ProjectTreeGroup[];
  selectedTarget: NavigationTarget;
  checkedHandles: ReadonlySet<string>;
  checkboxDisabled: boolean;
  sampleFor: (container: Container) => ResourceSample | undefined;
  inventoryRef: RefObject<HTMLDivElement | null>;
  onSelect: (container: Container) => void;
  onProjectView?: (name: string | null) => void;
  onShowConnections?: (container: Container) => void;
  onToggle: (container: Container) => void;
  busy: boolean;
}

type TreeEntry = { key: string; parent: string | null; group: ContainerTableProps['groups'][number]; container?: Container };
const projectKey = (name: string | null) => `project:${JSON.stringify(name)}`;
const containerKey = (fullId: string) => `container:${fullId}`;

export function ContainerTable({ groups, selectedTarget, checkedHandles, checkboxDisabled, sampleFor,
  inventoryRef, onSelect, onShowConnections, onProjectView, onToggle, busy }: ContainerTableProps) {
  const t = useI18n(messages);
  const ct = useI18n(composeMessages);
  const app = useI18n(appMessages);
  const id = useId();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const nodes = useRef(new Map<string, HTMLDivElement>());
  const entries: TreeEntry[] = groups.flatMap(group => {
    const key = projectKey(group.name);
    return [{ key, parent: null, group }, ...(collapsed.has(key) ? [] : group.containers.map(container => ({ key: containerKey(container.fullId), parent: key, group, container })))];
  });
  const selectedKey = selectedTarget?.kind === 'standalone' ? projectKey(null) : selectedTarget?.kind === 'project' ? projectKey(selectedTarget.name)
    : selectedTarget?.kind === 'container' ? containerKey(selectedTarget.fullId) : null;
  const selectedGroup = selectedTarget?.kind === 'container' ? groups.find(group => group.containers.some(container => container.fullId === selectedTarget.fullId)) : undefined;
  const visibleSelectedKey = entries.some(entry => entry.key === selectedKey) ? selectedKey : selectedGroup ? projectKey(selectedGroup.name) : null;
  const tabKey = entries.some(entry => entry.key === focusedKey) ? focusedKey : visibleSelectedKey ?? entries[0]?.key;

  function focus(key: string) {
    setFocusedKey(key);
    nodes.current.get(key)?.focus();
  }
  function toggleGroup(key: string) {
    setCollapsed(previous => { const next = new Set(previous); if (next.has(key)) next.delete(key); else next.add(key); return next; });
    if (entries.find(entry => entry.key === focusedKey)?.parent === key) setFocusedKey(key);
  }
  function activate(entry: TreeEntry) {
    setFocusedKey(entry.key);
    if (entry.container) onSelect(entry.container);
    else onProjectView?.(entry.group.name);
  }
  function keyDown(event: KeyboardEvent<HTMLDivElement>, entry: TreeEntry) {
    // Checkboxes and port links keep their own keyboard behavior.
    if (event.target !== event.currentTarget) return;
    const index = entries.findIndex(item => item.key === entry.key);
    let next: TreeEntry | undefined;
    if (event.key === 'ArrowDown') next = entries[Math.min(index + 1, entries.length - 1)];
    else if (event.key === 'ArrowUp') next = entries[Math.max(index - 1, 0)];
    else if (event.key === 'Home') next = entries[0];
    else if (event.key === 'End') next = entries.at(-1);
    else if (event.key === 'ArrowRight') {
      if (!entry.container && collapsed.has(entry.key)) toggleGroup(entry.key);
      else if (!entry.container) next = entries[index + 1]?.parent === entry.key ? entries[index + 1] : undefined;
    } else if (event.key === 'ArrowLeft') {
      if (entry.container) next = entries.find(item => item.key === entry.parent);
      else if (!collapsed.has(entry.key)) toggleGroup(entry.key);
    } else if (event.key === 'Enter' || event.key === ' ') activate(entry);
    else return;
    event.preventDefault();
    event.stopPropagation();
    if (next) focus(next.key);
  }
  function register(key: string, node: HTMLDivElement | null) {
    if (node) nodes.current.set(key, node); else nodes.current.delete(key);
  }

  return <div className="container-table-scroll">
    <div ref={inventoryRef} className="container-tree" role="tree" aria-label={app('containerList')} aria-busy={busy}>
      {groups.map((group, groupIndex) => {
        const key = projectKey(group.name);
        const name = group.name ?? t('standalone');
        const expanded = !collapsed.has(key);
        const selected = group.name === null ? selectedTarget?.kind === 'standalone' : selectedTarget?.kind === 'project' && selectedTarget.name === group.name;
        const selectedChild = !expanded && selectedTarget?.kind === 'container' ? group.containers.find(container => container.fullId === selectedTarget.fullId) : undefined;
        const selectedChildId = selectedChild ? `${id}-selected-child-${groupIndex}` : undefined;
        const entry: TreeEntry = { key, parent: null, group };
        return <div key={key} ref={node => register(key, node)} role="treeitem" aria-label={group.name === null ? name : t('projectView', { name })}
          aria-level={1} aria-expanded={expanded} aria-selected={selected} aria-describedby={selectedChildId}
          className="project-tree-item" data-log-scope={group.name === null ? 'standalone' : 'project'} data-selected={selected || undefined} data-selected-descendant={!!selectedChild || undefined}
          tabIndex={tabKey === key ? 0 : -1} onFocus={event => { if (event.target === event.currentTarget) setFocusedKey(key); }}
          onKeyDown={event => keyDown(event, entry)} onClick={event => {
            if (!(event.target instanceof Element) || event.target.closest('[role="treeitem"]') !== event.currentTarget || event.target.closest('button, input')) return;
            focus(key); activate(entry);
          }}>
          <div className="container-project-header">
            <button type="button" className="project-disclosure" aria-label={t(expanded ? 'collapse' : 'expand', { name })} aria-expanded={expanded} onClick={() => toggleGroup(key)}><ChevronRight size={15} aria-hidden="true" /></button>
            {expanded ? <FolderOpen size={16} aria-hidden="true" /> : <FolderClosed size={16} aria-hidden="true" />}
            <span className="project-tree-name" title={name}>{name}</span>
            <span className="container-project-count" aria-label={t('count', { count: group.containers.length })}>{group.containers.length}</span>
            {group.registration && <span className="project-registration-state" title={group.issue?.message ?? group.registration.composeFile} data-error={!!group.issue || undefined}>{group.issue ? ct('failed') : (group.totalContainers ?? group.containers.length) === 0 ? ct('notCreated') : ct('registered')}</span>}
            {selectedChild && <span id={selectedChildId} className="project-selected-child" role="img" aria-label={t('selectedChild', { name: selectedChild.name })} title={t('selectedChild', { name: selectedChild.name })} />}
          </div>
          {expanded && <div role="group" className="project-tree-children">{group.containers.map(container => {
            const childKey = containerKey(container.fullId);
            const childSelected = selectedTarget?.kind === 'container' && container.fullId === selectedTarget.fullId;
            const sample = sampleFor(container);
            const cpu = sample?.available && sample.cpuPercent !== null ? `${sample.cpuPercent.toFixed(2)}%` : '—';
            const memory = sample?.available ? sample.memoryUsage ?? '—' : '—';
            const ports = container.ports.join(', ');
            const staleId = sample?.stale ? `${id}-stale-${container.fullId}` : undefined;
            const healthIssue = container.health && container.health !== 'none' && container.health !== 'healthy';
            const child: TreeEntry = { key: childKey, parent: key, group, container };
            return <div key={childKey} ref={node => register(childKey, node)} role="treeitem" aria-level={2} aria-label={app('detailsFor', { name: container.name })}
              aria-selected={childSelected} className="container-list-item container-row" data-selected={childSelected || undefined} title={container.name}
              tabIndex={tabKey === childKey ? 0 : -1} onFocus={event => { if (event.target === event.currentTarget) setFocusedKey(childKey); }}
              onKeyDown={event => keyDown(event, child)} onClick={event => {
                if (event.target instanceof Element && event.target.closest('button, input')) return;
                focus(childKey); activate(child);
              }}>
              <input type="checkbox" className="container-checkbox" aria-label={app('selectTarget', { name: container.name })}
                checked={checkedHandles.has(container.handle)} disabled={checkboxDisabled} onChange={() => onToggle(container)} />
              <div className="container-tree-content">
                <div className="container-tree-title"><span className="container-tree-name">{container.name}</span><State value={container.state} /></div>
                <div className="container-tree-metrics"><span>CPU <span className="container-cpu-value" aria-describedby={staleId}>{cpu}</span></span><span title={memory}>{t('memory')} <span className="container-memory-value" title={memory} aria-describedby={staleId}>{memory.split(' / ')[0]}</span></span>{sample?.stale && <span id={staleId} className="resource-stale">{t('stale')}</span>}</div>
                {healthIssue && <span className="container-table-health">{t('health')}: <Health value={container.health} /></span>}
                {ports && <div className="container-tree-ports">{onShowConnections ? <button type="button" className="container-connection-link" aria-label={t('connectionsFor', { name: container.name })} title={ports} onClick={() => onShowConnections(container)}>{ports}</button> : <span title={ports}>{ports}</span>}</div>}
              </div>
            </div>;
          })}</div>}
        </div>;
      })}
    </div>
  </div>;
}
