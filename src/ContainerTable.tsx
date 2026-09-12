import { Fragment, useId } from 'react';
import type { KeyboardEvent, RefObject } from 'react';
import type { Container } from './api';
import { Health, State } from './components';
import { useI18n } from './i18n';
import { appMessages } from './messages/app';
import type { groupContainers } from './projects';
import type { ResourceSample } from './useContainerStats';
import './containerTable.css';

const messages = {
  projectView: { ko: '프로젝트 보기', en: 'View project' },
  selection: { ko: '작업 대상', en: 'Action selection' },
  name: { ko: '컨테이너', en: 'Container' },
  state: { ko: '상태', en: 'State' },
  memory: { ko: '메모리', en: 'Memory' },
  ports: { ko: '포트', en: 'Ports' },
  health: { ko: '헬스', en: 'Health' },
  stale: { ko: '오래된 값', en: 'Stale sample' },
  count: { ko: '{count}개 컨테이너', en: '{count} containers' },
  connectionsFor: { ko: '{name} 접속 정보 보기', en: 'View connections for {name}' },
};

export interface ContainerTableProps {
  groups: ReturnType<typeof groupContainers>;
  selectedId: string | null;
  checkedHandles: ReadonlySet<string>;
  checkboxDisabled: boolean;
  sampleFor: (container: Container) => ResourceSample | undefined;
  inventoryRef: RefObject<HTMLTableSectionElement | null>;
  onSelect: (container: Container) => void;
  onProjectView?: (name: string | null) => void;
  onShowConnections?: (container: Container) => void;
  onToggle: (container: Container) => void;
  onRowKeyDown: (event: KeyboardEvent<HTMLButtonElement>, index: number) => void;
  busy: boolean;
}

export function ContainerTable({ groups, selectedId, checkedHandles, checkboxDisabled, sampleFor,
  inventoryRef, onSelect, onShowConnections, onProjectView, onToggle, onRowKeyDown, busy }: ContainerTableProps) {
  const t = useI18n(messages);
  const app = useI18n(appMessages);
  const id = useId();
  const visible = groups.flatMap(group => group.containers);
  const selectedVisible = visible.some(container => container.fullId === selectedId);
  const indexes = new Map(visible.map((container, index) => [container.fullId, index]));

  return <div className="container-table-scroll">
    <table className="container-table" aria-label={app('containerList')} aria-busy={busy}>
      <colgroup><col className="container-table-check-column" /><col className="container-table-name-column" />
        <col className="container-table-state-column" /><col className="container-table-cpu-column" />
        <col className="container-table-memory-column" /><col /></colgroup>
      <thead><tr>
        <th scope="col" aria-label={t('selection')} />
        <th scope="col">{t('name')}</th><th scope="col">{t('state')}</th>
        <th scope="col" className="container-table-number">CPU</th>
        <th scope="col" className="container-table-number">{t('memory')}</th><th scope="col">{t('ports')}</th>
      </tr></thead>
      <tbody ref={inventoryRef}>
        {groups.map(group => <Fragment key={JSON.stringify(group.name)}>
          <tr className="container-project-header"><td colSpan={6}><div>
            <h3 title={group.name ?? app('noProject')}>{group.name ?? app('noProject')}</h3>
            <span className="container-project-count" aria-label={t('count', { count: group.containers.length })}>{group.containers.length}</span>
            {onProjectView && <button type="button" className="text-button project-view-button" disabled={busy} onClick={() => onProjectView(group.name)}>{t('projectView')}</button>}
          </div></td></tr>
          {group.containers.map(container => {
            const index = indexes.get(container.fullId)!;
            const selected = container.fullId === selectedId;
            const sample = sampleFor(container);
            const cpu = sample?.available && sample.cpuPercent !== null ? `${sample.cpuPercent.toFixed(2)}%` : '—';
            const memory = sample?.available ? sample.memoryUsage ?? '—' : '—';
            const ports = container.ports.join(', ') || '—';
            const staleId = sample?.stale ? `${id}-stale-${container.fullId}` : undefined;
            const healthIssue = container.health && container.health !== 'none' && container.health !== 'healthy';
            return <tr key={container.fullId} className="container-list-item" data-selected={selected || undefined}
              onClick={event => {
                if (event.target instanceof Element && event.target.closest('button, input')) return;
                event.currentTarget.querySelector<HTMLButtonElement>('.container-row')?.focus({ preventScroll: true });
                onSelect(container);
              }}>
              <td className="container-table-check"><input type="checkbox" className="container-checkbox"
                aria-label={app('selectTarget', { name: container.name })} checked={checkedHandles.has(container.handle)}
                disabled={checkboxDisabled} onChange={() => onToggle(container)} /></td>
              <td className="container-table-name"><button className="container-row" title={container.name}
                aria-label={app('detailsFor', { name: container.name })} aria-current={selected ? 'true' : undefined}
                tabIndex={selected || (!selectedVisible && index === 0) ? 0 : -1}
                onClick={() => onSelect(container)} onKeyDown={event => onRowKeyDown(event, index)}>{container.name}</button></td>
              <td className="container-table-state"><State value={container.state} />
                {healthIssue && <span className="container-table-health">{t('health')}: <Health value={container.health} /></span>}</td>
              <td className="container-table-cpu container-table-number"><span className="container-cpu-value" aria-describedby={staleId}>{cpu}</span></td>
              <td className="container-table-memory container-table-number"><span className="container-memory-value" title={memory} aria-describedby={staleId}>{memory.split(' / ')[0]}</span>
                {sample?.stale && <span id={staleId} className="resource-stale">{t('stale')}</span>}</td>
              <td className="container-table-ports">{onShowConnections && container.ports.length > 0 ? <button type="button" className="container-connection-link" aria-label={t('connectionsFor', { name: container.name })} title={ports} onClick={() => onShowConnections(container)}>{ports}</button> : <span title={ports}>{ports}</span>}</td>
            </tr>;
          })}
        </Fragment>)}
      </tbody>
    </table>
  </div>;
}
