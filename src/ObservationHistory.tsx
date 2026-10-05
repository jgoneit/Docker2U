import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { Container } from './api';
import type { ProjectFilter } from './projects';
import type { ObservationEvent, ObservationRead, ResourcePoint } from './observationApi';
import { IncidentDetail } from './IncidentDetail';
import type { IncidentReview } from './useIncidentReview';
import { ErrorDetails } from './components';
import { useI18n } from './i18n';
import { usePreferences } from './preferences';
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
  const { language } = usePreferences();
  const locale = language === 'ko' ? 'ko-KR' : 'en-US';
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
    </svg><div className="resource-chart-times"><time>{new Date(start).toLocaleTimeString(locale)}</time><time>{new Date(end).toLocaleTimeString(locale)}</time></div>
  </figure>;
}
export interface HistoryViewState { expanded: string | null; eventCursor: number | null; scrollTop: number; retainedEvent?: ObservationEvent | null }
/** A cleared session must not be repopulated by a departing view's cleanup. */
export class HistoryViewCache extends Map<string, HistoryViewState> {
  generation = 0;
  override clear() { super.clear(); ++this.generation; }
}
export function ObservationHistory({ observation, containers, fullId, scope = observation?.scope, onRetry, retrying = false,
  incident, onSelectEvent, onCloseIncident, onNavigateIncident, currentAvailable = false, viewCache, viewKey = '', visible = true,
}: { observation: ObservationRead | null; containers: Container[]; fullId?: string; scope?: ProjectFilter; onRetry?: () => void; retrying?: boolean;
  incident?: IncidentReview; onSelectEvent?: (event: ObservationEvent) => void; onCloseIncident?: () => void;
  onNavigateIncident?: (tab: 'diagnostics' | 'connectivity' | 'storage' | 'terminal') => void; currentAvailable?: boolean;
  viewCache?: HistoryViewCache; viewKey?: string; visible?: boolean;
}) {
  const t = useI18n(observationMessages);
  const { language } = usePreferences();
  const locale = language === 'ko' ? 'ko-KR' : 'en-US';
  const historyId = useId();
  const [saved] = useState(() => viewCache?.get(viewKey));
  const cacheGeneration = useRef(viewCache?.generation).current;
  const [expanded, setExpanded] = useState<string | null>(saved?.expanded ?? null);
  const [eventCursor, setEventCursor] = useState<number | null>(saved?.eventCursor ?? null);
  const [retainedEvent, setRetainedEvent] = useState<ObservationEvent | null>(saved?.retainedEvent ?? null);
  const section = useRef<HTMLElement>(null);
  const scrollTop = useRef(saved?.scrollTop ?? 0);
  const latestView = useRef({ expanded, eventCursor, retainedEvent }); latestView.current = { expanded, eventCursor, retainedEvent };
  useLayoutEffect(() => {
    if (visible && section.current) section.current.scrollTop = scrollTop.current;
    const save = () => {
      if (viewCache?.generation === cacheGeneration) viewCache?.set(viewKey, { ...latestView.current, scrollTop: scrollTop.current });
    };
    // A restored view replaces cleanup data from the view it just superseded.
    save();
    return save;
  }, [visible, viewCache, viewKey, cacheGeneration]);
  const scopeKey = JSON.stringify(scope);
  const initialScope = useRef({ fullId, scopeKey });
  useEffect(() => {
    if (initialScope.current.fullId === fullId && initialScope.current.scopeKey === scopeKey) return;
    initialScope.current = { fullId, scopeKey }; setEventCursor(null); setExpanded(null); setRetainedEvent(null);
  }, [fullId, scopeKey]);
  const ids = new Set(containers.map(item => item.fullId));
  const activeId = fullId ?? (containers.some(container => container.fullId === expanded) ? expanded : null);
  const resources = observation?.resources ?? [];
  const points = resources.filter(point => point.fullId === activeId);
  const latest = new Map<string, ResourcePoint>(); for (const point of resources) latest.set(point.fullId, point);
  const eventKeys: Record<string, keyof typeof observationMessages> = { pause: 'eventPause', stop: 'eventStop', kill: 'eventKill', health_status: 'healthChanged', 'health_status: starting': 'healthStarting', 'health_status: healthy': 'healthHealthy', 'health_status: unhealthy': 'healthUnhealthy' };
  const events = (observation?.events ?? []).filter(event => !event.fullId || (fullId ? event.fullId === fullId
    : scope?.kind === 'all' || ids.has(event.fullId)
      || (scope?.kind === 'none' ? event.composeProject === null : scope?.kind === 'project' && event.composeProject === scope.name))).slice().reverse();
  const selectedEvent = incident?.state?.event;
  const preservedEvent = selectedEvent ?? retainedEvent;
  if (preservedEvent && !events.some(event => event.sequence === preservedEvent.sequence)) {
    events.push(preservedEvent); events.sort((a, b) => b.sequence - a.sequence);
  }
  const scopeResources = resources.filter(point => fullId ? point.fullId === fullId : ids.has(point.fullId));
  const resourceFrom = scopeResources.length ? scopeResources.reduce((oldest, point) => point.sampledAt < oldest ? point.sampledAt : oldest, scopeResources[0]!.sampledAt) : null;
  const resourceTo = scopeResources.at(-1)?.sampledAt ?? null;
  const eventTo = events[0]?.observedAt ?? null;
  const eventFrom = events.length ? events.reduce((oldest, event) => event.observedAt < oldest ? event.observedAt : oldest, events[0]!.observedAt) : null;
  const matchingEvents = events.filter(event => eventCursor === null || event.sequence <= eventCursor);
  const visibleEvents = matchingEvents.slice(0, 200);
  const charts = <div className="history-charts" aria-label={t('resources')}>{points.length ? <><ResourceChart points={points} metric="cpu" /><ResourceChart points={points} metric="memory" /></> : <p className="observation-hint">{t('noHistory')}</p>}</div>;
  function closeIncident() {
    const sequence = selectedEvent?.sequence;
    if (selectedEvent) setRetainedEvent(selectedEvent);
    onCloseIncident?.();
    section.current?.querySelector<HTMLButtonElement>(`[data-event-sequence="${sequence}"]`)?.focus({ preventScroll: true });
  }
  function changeEventPage(cursor: number | null) {
    // Pagination can remove the selected row. Close its review without moving
    // focus from the paging control to a trigger that is about to unmount.
    if (selectedEvent) onCloseIncident?.();
    setRetainedEvent(null);
    setEventCursor(cursor);
  }
  return <section ref={section} className="observation-history" aria-label={t('history')} onScroll={event => {
    if (!visible) return;
    scrollTop.current = event.currentTarget.scrollTop;
    if (viewCache?.generation === cacheGeneration) viewCache?.set(viewKey, { ...latestView.current, scrollTop: scrollTop.current });
  }}>
    <p className="observation-hint">{t('historyHint')}</p>
    {(resourceFrom || eventFrom) && <p className="observation-status">{t('coverage')} · {resourceFrom && <span>{t('resources')} <time dateTime={resourceFrom}>{new Date(resourceFrom).toLocaleTimeString(locale)}</time>–{resourceTo && <time dateTime={resourceTo}>{new Date(resourceTo).toLocaleTimeString(locale)}</time>} </span>}{eventFrom && <span>{t('stateChanges')} <time dateTime={eventFrom}>{new Date(eventFrom).toLocaleTimeString(locale)}</time>–{eventTo && <time dateTime={eventTo}>{new Date(eventTo).toLocaleTimeString(locale)}</time>}</span>}</p>}
    {observation?.statsError && <ErrorDetails error={observation.statsError} />}
    {observation?.eventError && <ErrorDetails error={observation.eventError} />}
    {observation && <p className="observation-status" role="status">{t('stateChanges')} · {t(observation.eventStatus)}</p>}
    {observation && ['error', 'stopped'].includes(observation.eventStatus) && onRetry && <button disabled={retrying} onClick={onRetry}>{t('retry')}</button>}
    {observation?.resourceTruncated && <p className="observation-warning">{t('resourceTruncated')}</p>}
    {observation?.eventTruncated && <p className="observation-warning">{t('eventTruncated')}</p>}
    {!fullId && <div className="history-services">{containers.map(container => { const point = latest.get(container.fullId); const fresh = point?.available && container.state === 'running' && Date.now() - Date.parse(point.sampledAt) <= 15_000; const selected = activeId === container.fullId; const triggerId = `${historyId}-${container.fullId}-trigger`; const panelId = `${historyId}-${container.fullId}-resources`; return <div key={container.fullId} className="history-service-item"><button id={triggerId} className="history-service" aria-expanded={selected} aria-controls={panelId} onClick={() => setExpanded(selected ? null : container.fullId)}>
      <span><ChevronRight className="history-disclosure" size={14} aria-hidden="true" /><strong title={container.composeService ?? container.name}>{container.composeService ?? container.name}</strong><small title={container.name}>{container.name}</small></span><span>CPU {fresh && point.cpuPercent !== null ? `${point.cpuPercent.toFixed(1)}%` : '—'}</span><span>{fresh ? formatBytes(point.memoryUsageBytes) : '—'}</span>
    </button><div id={panelId} className="history-service-details" role="region" aria-labelledby={triggerId} hidden={!selected}>{selected && charts}</div></div>; })}</div>}
    {fullId && charts}
    <h3>{t('stateChanges')}</h3>
    {!events.length ? <p className="observation-hint">{t('noHistory')}</p> : <ol className="history-events">{visibleEvents.map(event => {
      const selected = selectedEvent?.sequence === event.sequence;
      const canOpen = !!(event.fullId && event.composeProject && onSelectEvent);
      const triggerId = `${historyId}-event-${event.sequence}`;
      const content = <><time dateTime={event.occurredAt} title={event.occurredAt}>{new Date(event.occurredAt).toLocaleTimeString(locale)}</time><strong>{event.composeService ?? '—'}</strong>{event.name && <span className="history-event-container">{event.name}</span>}{event.fullId && <code className="history-event-id" title={event.fullId}>{event.fullId.slice(0, 12)}</code>}<span>{eventKeys[event.kind] ? t(eventKeys[event.kind]!) : event.kind in observationMessages ? t(event.kind as keyof typeof observationMessages) : event.kind}</span>{event.detail && <span>{event.detail}</span>}</>;
      return <li key={event.sequence} className={canOpen ? 'history-event-item' : undefined}>
        {canOpen ? <button className="history-event-trigger" id={triggerId} data-event-sequence={event.sequence} aria-expanded={selected}
          aria-controls={`${triggerId}-detail`} onClick={() => {
            if (selected) closeIncident();
            else { if (eventCursor === null) setEventCursor(events[0]?.sequence ?? null); onSelectEvent(event); }
          }}><ChevronRight size={14} aria-hidden="true" />{content}</button> : content}
        {selected && incident && <div className="history-event-detail" id={`${triggerId}-detail`} role="region" aria-labelledby={triggerId}>
          <IncidentDetail review={incident} onClose={closeIncident} onNavigate={tab => onNavigateIncident?.(tab)} currentAvailable={currentAvailable} />
        </div>}
      </li>;
    })}</ol>}
    {!!events.length && <div className="history-event-pages"><span>{t('eventPage', { count: visibleEvents.length, total: events.length })}</span><button disabled={eventCursor === null} onClick={() => changeEventPage(null)}>{t('latest')}</button><button disabled={matchingEvents.length <= 200} onClick={() => changeEventPage((visibleEvents.at(-1)?.sequence ?? 0) - 1)}>{t('olderEvents')}</button></div>}
  </section>;
}
