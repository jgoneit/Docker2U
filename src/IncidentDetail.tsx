import { useLayoutEffect, useRef } from 'react';
import { RefreshCw, X } from 'lucide-react';
import { ErrorDetails } from './components';
import { useI18n } from './i18n';
import { usePreferences } from './preferences';
import { incidentMessages } from './messages/incident';
import { observationMessages } from './messages/observation';
import type { ResourcePoint } from './observationApi';
import { formatBytes } from './useObservation';
import { INCIDENT_PAGE_SIZE, incidentWindow, nearestIncidentRow, type IncidentReview, type IncidentTab } from './useIncidentReview';
import './incidentReview.css';

export function incidentResourceSegments(points: ResourcePoint[], metric: 'cpu' | 'memory') {
  const value = (point: ResourcePoint) => metric === 'cpu' ? point.cpuPercent : point.memoryUsageBytes;
  const segments: ResourcePoint[][] = [];
  let segment: ResourcePoint[] = [];
  for (const point of points) {
    const previous = segment.at(-1);
    const gap = previous && (Date.parse(point.sampledAt) - Date.parse(previous.sampledAt) > 15_000 || Date.parse(point.sampledAt) < Date.parse(previous.sampledAt));
    if (!point.available || value(point) === null || gap) {
      if (segment.length) segments.push(segment);
      segment = [];
    }
    if (point.available && value(point) !== null) segment.push(point);
  }
  if (segment.length) segments.push(segment);
  return segments;
}
export function IncidentResourceChart({ points, metric, from, to, occurredAt }: { points: ResourcePoint[]; metric: 'cpu' | 'memory'; from: string; to: string; occurredAt: string }) {
  const t = useI18n(incidentMessages), observation = useI18n(observationMessages);
  const { language } = usePreferences();
  const locale = language === 'ko' ? 'ko-KR' : 'en-US';
  const value = (point: ResourcePoint) => metric === 'cpu' ? point.cpuPercent : point.memoryUsageBytes;
  const max = Math.max(metric === 'cpu' ? 100 : 1, ...points.map(point => point.available ? value(point) ?? 0 : 0));
  const start = Date.parse(from), end = Date.parse(to);
  const x = (time: string) => 8 + (Date.parse(time) - start) / (end - start) * 584;
  const y = (point: ResourcePoint) => 104 - (value(point) ?? 0) / max * 96;
  const title = metric === 'cpu' ? 'CPU' : observation('memory');
  return <figure className="resource-chart incident-resource-chart"><figcaption><strong>{title}</strong><span>0–{metric === 'cpu' ? `${max.toFixed(0)}%` : formatBytes(max)}</span></figcaption>
    <svg viewBox="0 0 600 114" role="img" aria-label={`${title} · ${t('at')} ${new Date(occurredAt).toLocaleTimeString(locale)}`} preserveAspectRatio="none">
      <path d="M8 8H592M8 56H592M8 104H592" className="resource-grid" />
      {incidentResourceSegments(points, metric).map((segment, index) => segment.length === 1
        ? <circle key={index} cx={x(segment[0]!.sampledAt)} cy={y(segment[0]!)} r="2.5" className="resource-point" />
        : <polyline key={index} className="resource-line" points={segment.map(point => `${x(point.sampledAt)},${y(point)}`).join(' ')} />)}
      <line className="incident-time-marker" x1={x(occurredAt)} x2={x(occurredAt)} y1="5" y2="109"><title>{t('at')}</title></line>
    </svg>
    <div className="resource-chart-times"><time dateTime={from}>{new Date(from).toLocaleTimeString(locale)}</time><span className="incident-marker-label">{t('at')}</span><time dateTime={to}>{new Date(to).toLocaleTimeString(locale)}</time></div>
  </figure>;
}
export function IncidentDetail({ review, onClose, onNavigate, currentAvailable }: {
  review: IncidentReview; onClose: () => void; onNavigate: (tab: IncidentTab) => void; currentAvailable: boolean;
}) {
  const t = useI18n(incidentMessages), observation = useI18n(observationMessages);
  const { language } = usePreferences();
  const viewport = useRef<HTMLDivElement>(null);
  const state = review.state;
  useLayoutEffect(() => { if (viewport.current && state) viewport.current.scrollTop = state.logScroll; }, [state?.page]);
  if (!state) return null;
  const { event, page } = state;
  const locale = language === 'ko' ? 'ko-KR' : 'en-US';
  const time = (value: string) => new Date(value).toLocaleTimeString(locale, { hour12: false });
  const { timeFrom, timeTo } = incidentWindow(event, state.windowMinutes);
  const points = state.resourcePoints.filter(point => Date.parse(point.sampledAt) >= Date.parse(timeFrom) && Date.parse(point.sampledAt) <= Date.parse(timeTo));
  const source = page?.sources.find(item => item.fullId === event.fullId);
  const eventKeys: Record<string, keyof typeof observationMessages> = { pause: 'eventPause', stop: 'eventStop', kill: 'eventKill', health_status: 'healthChanged', 'health_status: starting': 'healthStarting', 'health_status: healthy': 'healthHealthy', 'health_status: unhealthy': 'healthUnhealthy' };
  const kind = eventKeys[event.kind] ? observation(eventKeys[event.kind]!) : event.kind in observationMessages ? observation(event.kind as keyof typeof observationMessages) : event.kind;
  const nearest = page ? nearestIncidentRow(page, event.occurredAt) : -1;
  return <section className="incident-detail" aria-label={t('title')} data-incident-sequence={event.sequence}>
    <header className="incident-header"><div><strong>{kind}</strong><time dateTime={event.occurredAt} title={event.occurredAt}>{new Date(event.occurredAt).toLocaleString(locale)}</time><span>{event.composeService ?? '—'}</span><span>{event.name ?? '—'}</span><code title={event.fullId ?? undefined}>{event.fullId?.slice(0, 12)}</code></div><button className="incident-close" type="button" aria-label={t('close')} onClick={onClose}><X size={15} aria-hidden="true" /></button></header>
    {event.detail && <p className="incident-event-detail">{event.detail}</p>}
    <div className="incident-toolbar"><div role="group" aria-label={t('window')} className="incident-window">{([1, 2, 5] as const).map(minutes => <button type="button" key={minutes} aria-pressed={state.windowMinutes === minutes} onClick={() => review.setWindow(minutes)}>{t('minutes', { count: minutes })}</button>)}</div><button type="button" disabled={state.loading} onClick={review.refresh}><RefreshCw size={13} aria-hidden="true" />{t('refresh')}</button></div>
    <p className="incident-hint">{t('frozen')} <span className="incident-captured">{t('captured')} <time dateTime={state.capturedAt}>{time(state.capturedAt)}</time></span></p>
    <div className="incident-charts"><IncidentResourceChart points={points} metric="cpu" from={timeFrom} to={timeTo} occurredAt={event.occurredAt} /><IncidentResourceChart points={points} metric="memory" from={timeFrom} to={timeTo} occurredAt={event.occurredAt} /></div>
    <p className="incident-hint">{points.some(point => point.available) ? t('resourceGaps') : t('noResources')}{state.resourcePoints.length > 0 && <> {t('resourceCoverage')}: <time dateTime={state.resourcePoints[0]!.sampledAt}>{time(state.resourcePoints[0]!.sampledAt)}</time>–<time dateTime={state.resourcePoints.at(-1)!.sampledAt}>{time(state.resourcePoints.at(-1)!.sampledAt)}</time></>}</p>
    {state.resourceTruncated && <p className="observation-warning">{observation('resourceTruncated')}</p>}
    <h4>{t('logs')}</h4>
    {page && <div className="incident-log-meta"><span>{t('logCoverage')}: {page.retainedFrom && page.retainedTo ? <><time dateTime={page.retainedFrom}>{time(page.retainedFrom)}</time>–<time dateTime={page.retainedTo}>{time(page.retainedTo)}</time></> : t('unknownCoverage')}</span>{source && <span>{observation(source.status)}</span>}</div>}
    {!!page?.droppedRows && <p className="observation-warning">{t('projectDropped', { count: page.droppedRows })}</p>}
    {!!page?.coverageGaps && <p className="observation-warning">{t('projectGaps', { count: page.coverageGaps })}</p>}
    {page?.anchorLost && <p className="observation-warning">{observation('anchorLost')}</p>}
    {page && !source && <p className="incident-hint">{t('sourceMissing')}</p>}
    {source && !source.selected && <p className="incident-hint">{t('sourceNotSelected')}</p>}
    {source?.error && source.error !== state.error && <ErrorDetails error={source.error} />}
    {state.error && <div role="status"><p className="observation-warning">{t('unavailable')} {!!page?.rows.length && t('previousRetained')}</p><ErrorDetails error={state.error} /></div>}
    {state.loading && <p className="incident-hint" role="status">{t('loading')}</p>}
    <div className="incident-log-viewport" ref={viewport} role="log" aria-label={t('logs')} aria-live="off" tabIndex={0} onScroll={event => review.setLogScroll(event.currentTarget.scrollTop)}>
      {page?.rows.length ? page.rows.map((row, index) => <div className="incident-log-row" data-nearest={index === nearest ? 'true' : undefined} data-pipe={row.pipe} key={row.rowId}>
        <time dateTime={row.timestamp ?? row.receivedAt} title={row.timestamp ?? `${row.receivedAt} · ${observation('received')}`}>{time(row.timestamp ?? row.receivedAt)}{!row.timestamp && <span className="incident-received"> {observation('received')}</span>}</time><span>{row.text}</span>{row.truncated && <span className="incident-truncated">{observation('lineTrimmed')}</span>}
      </div>) : !state.loading && <p className="incident-hint">{state.error ? t('unavailable') : t('empty')}</p>}
    </div>
    <div className="incident-log-pages"><span>{t('page', { from: page?.rows.length ? page.offset + 1 : 0, to: page ? page.offset + page.rows.length : 0, total: page?.totalRows ?? 0 })}</span><button type="button" disabled={state.loading || !page || page.offset === 0} onClick={() => review.page(Math.max(0, (page?.offset ?? 0) - INCIDENT_PAGE_SIZE))}>{t('previous')}</button><button type="button" disabled={state.loading || !page || page.offset + page.rows.length >= page.totalRows || !page.rows.length} onClick={() => review.page(page!.offset + page!.rows.length)}>{t('next')}</button></div>
    <footer className="incident-current"><strong>{t('current')}</strong><p className="incident-hint">{currentAvailable ? t('currentHint') : t('currentUnavailable')}</p><div>{(['diagnostics', 'connectivity', 'storage'] as const).map(tab => <button type="button" key={tab} disabled={!currentAvailable} onClick={() => onNavigate(tab)}>{t(tab)}</button>)}</div></footer>
  </section>;
}
