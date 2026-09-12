import { useEffect, useState } from 'react';
import type { Container } from './api';
import type { ObservationRead, ResourcePoint } from './observationApi';
import { ErrorDetails } from './components';
import { useI18n } from './i18n';
import { observationMessages } from './messages/observation';
import { formatBytes } from './useObservation';
import './observation.css';

export function resourceSegments(points: ResourcePoint[], value: (point: ResourcePoint) => number | null) {
  const segments: ResourcePoint[][] = []; let segment: ResourcePoint[] = [];
  for (const point of points) {
    const previous = segment.at(-1);
    if (!point.available || value(point) === null || (previous && (Date.parse(point.sampledAt) < Date.parse(previous.sampledAt) || Date.parse(point.sampledAt) - Date.parse(previous.sampledAt) > 15_000))) {
      if (segment.length) segments.push(segment); segment = [];
    }
    if (point.available && value(point) !== null) segment.push(point);
  }
  if (segment.length) segments.push(segment);
  return segments;
}
export function ResourceChart({ points, metric }: { points: ResourcePoint[]; metric: 'cpu' | 'memory' }) {
  const t = useI18n(observationMessages);
  const value = (point: ResourcePoint) => metric === 'cpu' ? point.cpuPercent : point.memoryUsageBytes;
  const max = Math.max(metric === 'cpu' ? 100 : 1, ...points.map(point => point.available ? value(point) ?? 0 : 0));
  const timestamps = points.map(point => Date.parse(point.sampledAt)).filter(Number.isFinite);
  const start = timestamps.length ? Math.min(...timestamps) : Date.now();
  const end = Math.max(start + 5_000, timestamps.length ? Math.max(...timestamps) : start);
  const x = (point: ResourcePoint) => 8 + (Date.parse(point.sampledAt) - start) / (end - start) * 584;
  const y = (point: ResourcePoint) => 104 - (value(point) ?? 0) / max * 96;
  return <figure className="resource-chart"><figcaption><strong>{metric === 'cpu' ? 'CPU' : t('memory')}</strong><span>0–{metric === 'cpu' ? `${max.toFixed(0)}%` : formatBytes(max)}</span></figcaption>
    <svg viewBox="0 0 600 114" role="img" aria-label={`${metric === 'cpu' ? 'CPU' : t('memory')} ${t('resources')}`} preserveAspectRatio="none">
      <path d="M8 8H592M8 56H592M8 104H592" className="resource-grid" />
      {resourceSegments(points, value).map((segment, index) => segment.length === 1 ? <circle key={index} cx={x(segment[0]!)} cy={y(segment[0]!)} r="2.5" className="resource-point" /> : <polyline key={index} className="resource-line" points={segment.map(point => `${x(point)},${y(point)}`).join(' ')} />)}
    </svg><div className="resource-chart-times"><time>{new Date(start).toLocaleTimeString()}</time><time>{new Date(end).toLocaleTimeString()}</time></div>
  </figure>;
}
export function ObservationHistory({ observation, containers, fullId, onRetry, retrying = false }: { observation: ObservationRead | null; containers: Container[]; fullId?: string; onRetry?: () => void; retrying?: boolean }) {
  const t = useI18n(observationMessages);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [eventCursor, setEventCursor] = useState<number | null>(null);
  const scopeKey = JSON.stringify(observation?.scope);
  useEffect(() => { setEventCursor(null); setExpanded(null); }, [fullId, scopeKey]);
  const ids = new Set(containers.map(item => item.fullId));
  const activeId = fullId ?? expanded;
  const resources = observation?.resources ?? [];
  const points = resources.filter(point => point.fullId === activeId);
  const latest = new Map<string, ResourcePoint>(); for (const point of resources) latest.set(point.fullId, point);
  const eventKeys: Record<string, keyof typeof observationMessages> = { pause: 'eventPause', stop: 'eventStop', kill: 'eventKill', health_status: 'healthChanged', 'health_status: starting': 'healthStarting', 'health_status: healthy': 'healthHealthy', 'health_status: unhealthy': 'healthUnhealthy' };
  const events = (observation?.events ?? []).filter(event => !event.fullId || (fullId ? event.fullId === fullId
    : observation?.scope.kind === 'all' || ids.has(event.fullId)
      || (observation?.scope.kind === 'none' ? event.composeProject === null : observation?.scope.kind === 'project' && event.composeProject === observation.scope.name))).slice().reverse();
  const scopeResources = resources.filter(point => fullId ? point.fullId === fullId : ids.has(point.fullId));
  const resourceFrom = scopeResources.length ? scopeResources.reduce((oldest, point) => point.sampledAt < oldest ? point.sampledAt : oldest, scopeResources[0]!.sampledAt) : null;
  const resourceTo = scopeResources.at(-1)?.sampledAt ?? null;
  const eventTo = events[0]?.observedAt ?? null;
  const eventFrom = events.length ? events.reduce((oldest, event) => event.observedAt < oldest ? event.observedAt : oldest, events[0]!.observedAt) : null;
  const matchingEvents = events.filter(event => eventCursor === null || event.sequence <= eventCursor);
  const visibleEvents = matchingEvents.slice(0, 200);
  return <section className="observation-history" aria-label={t('history')}>
    <p className="observation-hint">{t('historyHint')}</p>
    {(resourceFrom || eventFrom) && <p className="observation-status">{t('coverage')} · {resourceFrom && <span>{t('resources')} <time dateTime={resourceFrom}>{new Date(resourceFrom).toLocaleTimeString()}</time>–{resourceTo && <time dateTime={resourceTo}>{new Date(resourceTo).toLocaleTimeString()}</time>} </span>}{eventFrom && <span>{t('stateChanges')} <time dateTime={eventFrom}>{new Date(eventFrom).toLocaleTimeString()}</time>–{eventTo && <time dateTime={eventTo}>{new Date(eventTo).toLocaleTimeString()}</time>}</span>}</p>}
    {observation?.statsError && <ErrorDetails error={observation.statsError} />}
    {observation?.eventError && <ErrorDetails error={observation.eventError} />}
    {observation && <p className="observation-status" role="status">{t('stateChanges')} · {t(observation.eventStatus)}</p>}
    {observation && ['error', 'stopped'].includes(observation.eventStatus) && onRetry && <button disabled={retrying} onClick={onRetry}>{t('retry')}</button>}
    {observation?.resourceTruncated && <p className="observation-warning">{t('resourceTruncated')}</p>}
    {observation?.eventTruncated && <p className="observation-warning">{t('eventTruncated')}</p>}
    {!fullId && <div className="history-services">{containers.map(container => { const point = latest.get(container.fullId); const fresh = point?.available && container.state === 'running' && Date.now() - Date.parse(point.sampledAt) <= 15_000; return <button key={container.fullId} className="history-service" aria-expanded={activeId === container.fullId} onClick={() => setExpanded(activeId === container.fullId ? null : container.fullId)}>
      <span><strong>{container.composeService ?? container.name}</strong><small>{container.name}</small></span><span>CPU {fresh && point.cpuPercent !== null ? `${point.cpuPercent.toFixed(1)}%` : '—'}</span><span>{fresh ? formatBytes(point.memoryUsageBytes) : '—'}</span>
    </button>; })}</div>}
    {activeId && <div className="history-charts" aria-label={t('resources')}>{points.length ? <><ResourceChart points={points} metric="cpu" /><ResourceChart points={points} metric="memory" /></> : <p className="observation-hint">{t('noHistory')}</p>}</div>}
    <h3>{t('stateChanges')}</h3>
    {!events.length ? <p className="observation-hint">{t('noHistory')}</p> : <ol className="history-events">{visibleEvents.map(event => <li key={event.sequence}><time dateTime={event.occurredAt} title={event.occurredAt}>{new Date(event.occurredAt).toLocaleTimeString()}</time><strong>{event.composeService ?? '—'}</strong>{event.name && <span className="history-event-container">{event.name}</span>}{event.fullId && <code className="history-event-id" title={event.fullId}>{event.fullId.slice(0, 12)}</code>}<span>{eventKeys[event.kind] ? t(eventKeys[event.kind]!) : event.kind in observationMessages ? t(event.kind as keyof typeof observationMessages) : event.kind}</span>{event.detail && <span>{event.detail}</span>}</li>)}</ol>}
    {!!events.length && <div className="history-event-pages"><span>{t('eventPage', { count: visibleEvents.length, total: events.length })}</span><button disabled={eventCursor === null} onClick={() => setEventCursor(null)}>{t('latest')}</button><button disabled={matchingEvents.length <= 200} onClick={() => setEventCursor((visibleEvents.at(-1)?.sequence ?? 0) - 1)}>{t('olderEvents')}</button></div>}
  </section>;
}
