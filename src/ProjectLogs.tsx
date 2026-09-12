import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Copy, Maximize2, Minimize2, Pause, Play, Search } from 'lucide-react';
import { coreError, type Container, type CoreError } from './api';
import { ErrorDetails } from './components';
import { observationApi, projectLogApi, type ProjectLogPage, type ProjectLogRow } from './observationApi';
import { useI18n } from './i18n';
import { observationMessages } from './messages/observation';
import './observation.css';

/** Subscription lifetime follows project scope, never the visible detail tab. */
export function useProjectLogCollection(sessionId: string | null, project: string | null, enabled: boolean,
  onError: (original: unknown, error: CoreError, sessionId: string) => void) {
  const [page, setPage] = useState<ProjectLogPage | null>(null);
  const [error, setError] = useState<CoreError | null>(null);
  const current = useRef({ sessionId, project, onError }); current.current = { sessionId, project, onError };
  const work = useRef<Promise<unknown>>(Promise.resolve());
  const configure = useCallback(async (handles: string[] | null = null) => {
    const input = current.current;
    if (!input.sessionId || !input.project) return;
    try {
      const result = await projectLogApi.configure(input.sessionId, input.project, handles);
      if (current.current.sessionId === input.sessionId && current.current.project === input.project) { setPage(result); setError(result.error); }
    } catch (original) {
      if (current.current.sessionId !== input.sessionId || current.current.project !== input.project) return;
      const failure = coreError(original); setError(failure); input.onError(original, failure, input.sessionId);
    }
  }, []);
  useEffect(() => {
    if (!enabled || !sessionId || !observationApi.available()) return;
    setPage(null); setError(null);
    // Serialize project switches so a late old stop cannot terminate a new scope.
    work.current = work.current.catch(() => {}).then(() => project ? configure() : projectLogApi.stop(sessionId));
    return () => { work.current = work.current.catch(() => {}).then(() => projectLogApi.stop(sessionId)).catch(() => {}); };
  }, [sessionId, project, enabled, configure]);
  return { page: page?.sessionId === sessionId && page.project === project ? page : null, error, configure };
}

const ROW_HEIGHT = 26;
const PAGE_SIZE = 160;
function initialWindow(page: ProjectLogPage | null): ProjectLogPage | null {
  if (!page || page.rows.length <= PAGE_SIZE) return page;
  const skipped = page.rows.length - PAGE_SIZE;
  return { ...page, offset: page.offset + skipped, rows: page.rows.slice(skipped) };
}
export function logRowsText(rows: ProjectLogRow[]) {
  return rows.map(row => `${row.timestamp ?? row.receivedAt}\t${row.serviceName ?? '—'}\t${row.containerName}\t${row.text}`).join('\n');
}
export function ProjectLogs({ sessionId, project, containers, initialPage, fullId, configure, error: collectionError, visible = true, onError }: {
  sessionId: string; project: string; containers: Container[]; initialPage: ProjectLogPage | null; fullId?: string;
  configure: (handles: string[] | null) => Promise<void>; error: CoreError | null; visible?: boolean;
  onError: (original: unknown, failure: CoreError, sessionId: string) => void;
}) {
  const t = useI18n(observationMessages);
  const [page, setPage] = useState<ProjectLogPage | null>(fullId ? null : initialWindow(initialPage));
  const [error, setError] = useState<CoreError | null>(null);
  const [keyword, setKeyword] = useState('');
  const [services, setServices] = useState<string[] | null>(null);
  const [paused, setPaused] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [copyStatus, setCopyStatus] = useState<'copied' | 'copyFailed' | null>(null);
  const savedScroll = useRef(0);
  const restoredScroll = useRef<{ node: HTMLDivElement; top: number } | null>(null);
  const viewportGeometry = useRef<{ node: HTMLDivElement; height: number } | null>(null);
  const anchorInset = useRef(0);
  const scrollToLatest = useRef(false);
  const [queryRevision, setQueryRevision] = useState(0);
  const frozenSequence = useRef<number | null>(null);
  const pauseTransition = useRef(false);
  const viewport = useRef<HTMLDivElement>(null);
  const expandButton = useRef<HTMLButtonElement>(null);
  const expandedClose = useRef<HTMLButtonElement>(null);
  const following = useRef(true);
  const offset = useRef<number | null>(null);
  const anchor = useRef<string | null>(null);
  const pageRef = useRef(page); pageRef.current = page;
  const inputRef = useRef({ paused, visible, onError }); inputRef.current = { paused, visible, onError };
  const sources = page?.sources ?? initialPage?.sources ?? [];
  const sourceIds = fullId ? [fullId] : services !== null ? sources.filter(source => services.includes(source.serviceName ?? source.containerName)).map(source => source.sourceId) : [];
  const filterKey = JSON.stringify([sourceIds, keyword]);
  useEffect(() => { if (initialPage && !inputRef.current.paused && !fullId) setPage(initialWindow(initialPage)); }, [initialPage, fullId]);
  useEffect(() => {
    if (!observationApi.available() || !initialPage) return;
    let live = true; let reading = false; let timer: ReturnType<typeof setTimeout> | undefined;
    async function read() {
      if (reading || !live || !inputRef.current.visible || document.visibilityState === 'hidden') return;
      reading = true; clearTimeout(timer);
      try {
        const [ids, text] = JSON.parse(filterKey) as [string[], string];
        const result = await projectLogApi.query(sessionId, project, { sourceIds: ids, keyword: text, offset: following.current ? null : offset.current, limit: Math.min(PAGE_SIZE, Math.max(40, Math.ceil((viewport.current?.clientHeight ?? 400) / ROW_HEIGHT) + 24)), throughSequence: frozenSequence.current, anchorRowId: following.current ? null : anchor.current });
        if (!live) return;
        if (result.sessionId !== sessionId || result.project !== project) throw { code: 'InvalidProjectLogsResponse', message: 'Project log rows do not match the selected project.' };
        setPage(result); setError(result.error);
        if (result.error) inputRef.current.onError(result.error, result.error, sessionId);
      } catch (original) {
        if (!live) return; const failure = coreError(original); setError(failure); inputRef.current.onError(original, failure, sessionId);
      } finally { reading = false; if (live && !inputRef.current.paused) timer = setTimeout(() => void read(), 500); }
    }
    function visibility() { if (document.visibilityState !== 'hidden' && !inputRef.current.paused) void read(); }
    document.addEventListener('visibilitychange', visibility);
    if (pauseTransition.current) pauseTransition.current = false; else void read();
    return () => { live = false; clearTimeout(timer); document.removeEventListener('visibilitychange', visibility); };
  }, [sessionId, project, filterKey, paused, visible, queryRevision, !!initialPage]);
  const restoreScroll = useCallback(() => {
    const node = viewport.current; const current = pageRef.current;
    if (!node || !current || !inputRef.current.visible) return;
    let top = savedScroll.current;
    if (following.current && (!inputRef.current.paused || scrollToLatest.current)) top = Math.max(0, current.totalRows * ROW_HEIGHT - node.clientHeight);
    else if (anchor.current) {
      const index = current.rows.findIndex(row => row.rowId === anchor.current);
      if (index >= 0) top = (current.offset + index) * ROW_HEIGHT + anchorInset.current;
    }
    // Keep the intended position even when a taller viewport clamps the DOM
    // offset. Closing the expanded view can then restore the same frozen row.
    node.scrollTop = top; savedScroll.current = top;
    viewportGeometry.current = { node, height: node.clientHeight };
    restoredScroll.current = { node, top: node.scrollTop }; scrollToLatest.current = false;
  }, []);
  useLayoutEffect(restoreScroll, [page, paused, expanded, visible, restoreScroll]);
  useLayoutEffect(() => {
    const node = viewport.current;
    if (!node || !visible || typeof ResizeObserver === 'undefined') return;
    let height = 0;
    const observer = new ResizeObserver(() => {
      if (node.clientHeight <= 0 || node.clientHeight === height) return;
      height = node.clientHeight;
      restoreScroll();
      // A larger viewport needs a larger loaded window even while paused.
      // throughSequence keeps this display read inside the frozen collection.
      setQueryRevision(value => value + 1);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [expanded, visible, restoreScroll]);
  function toggleExpanded() { setExpanded(value => !value); }
  function togglePaused() {
    if (!paused) {
      const top = viewport.current?.scrollTop ?? 0; const index = Math.floor(top / ROW_HEIGHT);
      savedScroll.current = top; anchorInset.current = top - index * ROW_HEIGHT;
      anchor.current = page?.rows[index - page.offset]?.rowId ?? null;
    }
    frozenSequence.current = paused ? null : page?.maxSequence ?? 0;
    pauseTransition.current = !paused; setPaused(value => !value);
  }
  useEffect(() => {
    if (!expanded) return;
    const background = document.querySelector<HTMLElement>('.main-content');
    const wasInert = background?.inert; if (background) background.inert = true;
    expandedClose.current?.focus();
    return () => { if (background) background.inert = wasInert ?? false; expandButton.current?.focus(); };
  }, [expanded]);
  function resetFilter() { offset.current = null; anchor.current = null; anchorInset.current = 0; following.current = true; scrollToLatest.current = true; }
  function selectSources() { setSelectedIds(new Set(sources.filter(source => source.selected && source.status !== 'removed').map(source => source.fullId))); setSelecting(true); }
  const serviceOptions = [...new Set(sources.map(source => source.serviceName ?? source.containerName))].sort();
  const needSelection = page?.needsSelection || initialPage?.needsSelection;
  const failure = error ?? collectionError;
  const visibleSources = sources.filter(source => !fullId || source.fullId === fullId);
  const selectedSources = visibleSources.filter(source => source.selected && source.status !== 'removed');
  const hasFilters = keyword.length > 0 || services !== null;
  const emptyMessage = failure || visibleSources.some(source => source.error) ? 'logsUnavailable'
    : needSelection || (page && selectedSources.length === 0) ? (fullId ? 'sourceNotSelected' : 'noSources')
    : !page || selectedSources.some(source => source.status === 'starting' || source.status === 'retrying') ? 'logsLoading'
    : hasFilters ? 'noMatchingLogs' : 'noLogs';
  const content = <section className={`project-logs${expanded ? ' project-logs-expanded' : ''}`} aria-label={t('logs')}>
    <div className="project-log-toolbar">
      {!fullId && <details className="project-service-filter"><summary>{t('serviceFilter')}{services !== null ? ` (${services.length})` : ''}<ChevronDown className="project-service-chevron" size={14} aria-hidden="true" /></summary><div><button onClick={() => { setServices(null); resetFilter(); }}>{t('allServices')}</button>{serviceOptions.map(service => <label key={service}><input type="checkbox" checked={services === null || services.includes(service)} disabled={(services ?? serviceOptions).length === 1 && (services === null || services.includes(service))} onChange={event => { const base = services ?? serviceOptions; setServices(event.target.checked ? [...new Set([...base, service])] : base.filter(item => item !== service)); resetFilter(); }} />{service}</label>)}</div></details>}
      <label className="project-keyword"><Search size={14} aria-hidden="true" /><input type="search" aria-label={t('keyword')} placeholder={t('keywordHint')} value={keyword} onChange={event => { setKeyword(event.target.value); resetFilter(); }} /></label>
      <button onClick={togglePaused} aria-pressed={paused}>{paused ? <Play size={14} aria-hidden="true" /> : <Pause size={14} aria-hidden="true" />}{t(paused ? 'resume' : 'pause')}</button>
      <button onClick={() => { resetFilter(); frozenSequence.current = null; setPaused(false); setQueryRevision(value => value + 1); }}>{t('latest')}</button>
      <button disabled={!page?.rows.length} aria-label={t('copy')} title={t('copy')} onClick={() => void navigator.clipboard.writeText(logRowsText(page?.rows ?? [])).then(() => setCopyStatus('copied'), () => setCopyStatus('copyFailed'))}><Copy size={14} aria-hidden="true" /></button>
      <button ref={expanded ? expandedClose : expandButton} aria-label={t(expanded ? 'collapse' : 'expand')} onClick={toggleExpanded}>{expanded ? <Minimize2 size={14} aria-hidden="true" /> : <Maximize2 size={14} aria-hidden="true" />}</button>
      {!fullId && <button onClick={selectSources}>{t('changeSources')}</button>}
    </div>
    {copyStatus && <p className="observation-hint" role="status">{t(copyStatus)}</p>}
    {paused && <p className="observation-hint" role="status">{t('pausedHint')}</p>}
    {(failure || visibleSources.some(source => source.error)) && <div role="alert">{failure && <ErrorDetails error={failure} />}{sources.filter(source => source.error && (!fullId || source.fullId === fullId)).map(source => <div key={source.sourceId}><span>{source.containerName}</span><ErrorDetails error={source.error!} /></div>)}<button onClick={() => void projectLogApi.retry(sessionId).catch(original => { const next = coreError(original); setError(next); onError(original, next, sessionId); })}>{t('retry')}</button></div>}
    {(selecting || needSelection) && <fieldset className="project-source-selection"><legend>{t('selectSources')}</legend><p>{t('selectionHint')}</p><p>{t('selectionCount', { selected: selectedIds.size, total: sources.filter(source => source.status !== 'removed').length })}</p><div>{sources.filter(source => source.status !== 'removed').map(source => <label key={source.fullId}><input type="checkbox" checked={selectedIds.has(source.fullId)} disabled={!selectedIds.has(source.fullId) && selectedIds.size >= 64} onChange={event => setSelectedIds(previous => { const next = new Set(previous); if (event.target.checked) next.add(source.fullId); else next.delete(source.fullId); return next; })} />{source.serviceName ?? '—'} · {source.containerName}</label>)}</div><button onClick={() => { const handles = containers.filter(container => selectedIds.has(container.fullId)).map(container => container.handle); void configure(handles).then(() => { setSelecting(false); setQueryRevision(value => value + 1); }); }}>{t('apply')}</button></fieldset>}
    <div className="project-log-sources">{sources.filter(source => source.selected && (!fullId || source.fullId === fullId)).map(source => <span key={source.sourceId} data-status={source.status} title={source.error?.message}>{source.containerName} · {t(source.status)}</span>)}</div>
    <div className="project-log-meta"><span>{t('selectionCount', { selected: selectedSources.length, total: visibleSources.filter(source => source.status !== 'removed').length })} · {t('count', { count: page?.totalRows ?? 0 })}</span><span>{t('logCollectionHint')}</span>{!!page?.coverageGaps && <span className="observation-warning">{t('gap')} · {page.coverageGaps}</span>}{page?.anchorLost && <span className="observation-warning">{t('anchorLost')}</span>}{page?.retainedFrom && <span>{t('coverage')} (UTC): {page.retainedFrom.slice(0, 19).replace('T', ' ')} – {page.retainedTo?.slice(0, 19).replace('T', ' ') ?? '—'}</span>}{!!page?.droppedRows && <span className="observation-warning">{t('trimmed', { count: page.droppedRows })}</span>}</div>
    <div className="project-log-header" aria-hidden="true"><span>{t('utcTime')}</span><span>{t('service')}</span><span>{t('container')}</span><span>{t('message')}</span></div>
    <div ref={viewport} className="project-log-viewport" tabIndex={0} role="log" aria-label={t('logs')} aria-live="off" onScroll={event => {
      const node = event.currentTarget;
      // Resize can clamp scrollTop before ResizeObserver is delivered.
      const geometry = viewportGeometry.current;
      if (geometry?.node === node && geometry.height !== node.clientHeight) { restoreScroll(); return; }
      const restored = restoredScroll.current; restoredScroll.current = null;
      if (restored?.node === node && restored.top === node.scrollTop) return;
      savedScroll.current = node.scrollTop; const atEnd = node.scrollHeight - node.scrollTop - node.clientHeight < ROW_HEIGHT * 2;
      if (following.current && atEnd && !inputRef.current.paused) return;
      following.current = atEnd;
      const index = Math.floor(node.scrollTop / ROW_HEIGHT);
      const current = pageRef.current;
      anchor.current = current?.rows[index - current.offset]?.rowId ?? null;
      anchorInset.current = node.scrollTop - index * ROW_HEIGHT;
      offset.current = Math.max(0, index - 20);
      if (!current || index < current.offset + 10 || index + Math.ceil(node.clientHeight / ROW_HEIGHT) > current.offset + current.rows.length - 10) setQueryRevision(value => value + 1);
    }}>
      {!page?.totalRows ? <div className="project-log-empty"><p className="observation-hint" role="status">{t(emptyMessage)}</p>{emptyMessage === 'noMatchingLogs' && <button onClick={() => { setKeyword(''); setServices(null); resetFilter(); }}>{t('clearFilters')}</button>}</div> : <div className="project-log-spacer" style={{ height: page.totalRows * ROW_HEIGHT }}><div className="project-log-window" style={{ top: page.offset * ROW_HEIGHT }}>{page.rows.map(row => <div key={row.rowId} className="project-log-row" data-pipe={row.pipe} style={{ height: ROW_HEIGHT }}><time dateTime={row.timestamp ?? row.receivedAt} title={`${row.timestamp ?? `${t('received')}: ${row.receivedAt}`}`}>{(row.timestamp ?? row.receivedAt).slice(11, 23)}{!row.timestamp && '*'}</time><span title={row.serviceName ?? undefined}>{row.serviceName ?? '—'}</span><span title={row.fullId}>{row.containerName}</span><span>{row.text}{row.truncated && <em title={t('lineTrimmed')}> …</em>}</span></div>)}</div></div>}
    </div>
  </section>;
  if (!expanded) return content;
  return createPortal(<div className="project-log-modal" role="dialog" aria-modal="true" aria-label={t('logs')} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); toggleExpanded(); }
    if (event.key === 'Tab') { const elements = event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"], summary'); const first = elements[0]; const last = elements[elements.length - 1]; if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); } }
  }}>{content}</div>, document.body);
}
