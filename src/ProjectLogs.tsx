import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Copy, Maximize2, Minimize2, Pause, Play, Search, X } from 'lucide-react';
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
  const errorScope = useRef({ sessionId, project });
  const current = useRef({ sessionId, project, onError }); current.current = { sessionId, project, onError };
  const work = useRef<Promise<unknown>>(Promise.resolve());
  const requestSequence = useRef(0);
  const configureFor = useCallback(async (input: typeof current.current, handles: string[] | null, request: number) => {
    if (!input.sessionId || !input.project) return;
    const isCurrent = () => requestSequence.current === request && current.current.sessionId === input.sessionId && current.current.project === input.project;
    try {
      const result = await projectLogApi.configure(input.sessionId, input.project, handles);
      if (!isCurrent()) return;
      if (result.sessionId !== input.sessionId || result.project !== input.project) throw { code: 'InvalidProjectLogsResponse', message: 'Project log sources do not match the selected project.' };
      if (result.error) throw result.error;
      setPage(result); setError(null);
    } catch (original) {
      if (!isCurrent()) return;
      const failure = coreError(original); errorScope.current = input; setError(failure); input.onError(original, failure, input.sessionId);
      throw original;
    }
  }, []);
  const configure = useCallback((handles: string[] | null = null) => {
    const input = current.current, request = ++requestSequence.current;
    const operation = work.current.catch(() => {}).then(() => {
      if (request !== requestSequence.current || current.current.sessionId !== input.sessionId || current.current.project !== input.project) return;
      return configureFor(input, handles, request);
    });
    work.current = operation.catch(() => {});
    return operation;
  }, [configureFor]);
  useEffect(() => {
    if (!enabled || !sessionId || !observationApi.available()) return;
    setPage(null); setError(null);
    const input = current.current;
    const request = ++requestSequence.current;
    // Serialize project switches so a late old stop cannot terminate a new scope.
    work.current = work.current.catch(() => {}).then(() => {
      if (request !== requestSequence.current) return;
      return project ? configureFor(input, null, request) : projectLogApi.stop(sessionId);
    }).catch(() => {});
    return () => { ++requestSequence.current; work.current = work.current.catch(() => {}).then(() => projectLogApi.stop(sessionId)).catch(() => {}); };
  }, [sessionId, project, enabled, configureFor]);
  return { page: page?.sessionId === sessionId && page.project === project ? page : null,
    error: errorScope.current.sessionId === sessionId && errorScope.current.project === project ? error : null, configure };
}

const ROW_HEIGHT = 26;
const PAGE_SIZE = 160;
const QUERY_TIMEOUT_MS = 10_000;
export const PROJECT_LOG_VIEW_PAGE_BUDGET = 8 * 1024 * 1024;
interface ProjectLogViewState {
  page: ProjectLogPage | null; keyword: string; services: string[] | null; paused: boolean;
  frozenSequence: number | null; savedScroll: number; anchorInset: number; following: boolean;
  offset: number | null; anchor: string | null; delayed: boolean;
}
export interface ProjectLogViewCache {
  sessionId: string | null; version: number; views: Map<string, ProjectLogViewState>; retainedPageBytes: number;
  save: (key: string, state: ProjectLogViewState) => void; read: (key: string) => ProjectLogViewState | undefined; clear: () => void;
}
function estimatedPageBytes(page: ProjectLogPage): number {
  // Count UTF-16 strings and conservative record/reference overhead without
  // allocating another serialized copy of potentially megabyte-sized logs.
  const recordBytes = (record: object) => 128 + Object.values(record).reduce<number>((total, value) => total + (typeof value === 'string' ? value.length * 2 : value && typeof value === 'object' ? JSON.stringify(value).length * 2 : 8), 0);
  return 512 + page.rows.reduce((total, row) => total + recordBytes(row), 0) + page.sources.reduce((total, source) => total + recordBytes(source), 0);
}
/** Owned by App, retained only for its current Engine session. */
export function createProjectLogViewCache(): ProjectLogViewCache {
  const pageBytes = new Map<string, number>(), recentPages = new Map<string, true>();
  let measuredPages = new WeakMap<ProjectLogPage, number>();
  const cache: ProjectLogViewCache = {
    sessionId: null, version: 0, views: new Map(), retainedPageBytes: 0,
    read(key) {
      if (recentPages.has(key)) { recentPages.delete(key); recentPages.set(key, true); }
      return cache.views.get(key);
    },
    save(key, state) {
      let bytes = state.page ? measuredPages.get(state.page) : 0;
      if (bytes === undefined && state.page) { bytes = estimatedPageBytes(state.page); measuredPages.set(state.page, bytes); }
      if ((bytes ?? 0) > PROJECT_LOG_VIEW_PAGE_BUDGET) { state = { ...state, page: null }; bytes = 0; }
      cache.retainedPageBytes += (bytes ?? 0) - (pageBytes.get(key) ?? 0);
      cache.views.set(key, state); pageBytes.set(key, bytes ?? 0); recentPages.delete(key);
      if (state.page) recentPages.set(key, true);
      while (cache.retainedPageBytes > PROJECT_LOG_VIEW_PAGE_BUDGET) {
        const oldest = recentPages.keys().next().value;
        if (oldest === undefined) break;
        const previous = cache.views.get(oldest)!;
        cache.views.set(oldest, { ...previous, page: null });
        cache.retainedPageBytes -= pageBytes.get(oldest) ?? 0;
        pageBytes.delete(oldest); recentPages.delete(oldest);
      }
    },
    clear() { cache.sessionId = null; cache.views.clear(); pageBytes.clear(); recentPages.clear(); measuredPages = new WeakMap(); cache.retainedPageBytes = 0; cache.version++; },
  };
  return cache;
}
function initialWindow(page: ProjectLogPage | null): ProjectLogPage | null {
  if (!page || page.rows.length <= PAGE_SIZE) return page;
  const skipped = page.rows.length - PAGE_SIZE;
  return { ...page, offset: page.offset + skipped, rows: page.rows.slice(skipped) };
}
export function logRowsText(rows: ProjectLogRow[]) {
  return rows.map(row => `${row.timestamp ?? row.receivedAt}\t${row.serviceName ?? '—'}\t${row.containerName}\t${row.text}`).join('\n');
}
interface ProjectLogsProps {
  sessionId: string; project: string; containers: Container[]; initialPage: ProjectLogPage | null; fullId?: string;
  configure: (handles: string[] | null) => Promise<void>; error: CoreError | null; visible?: boolean;
  viewCache?: ProjectLogViewCache;
  onError: (original: unknown, failure: CoreError, sessionId: string) => void;
}
export function ProjectLogs(props: ProjectLogsProps) {
  const localCache = useRef(createProjectLogViewCache());
  const cache = props.viewCache ?? localCache.current;
  if (cache.sessionId !== props.sessionId) { cache.clear(); cache.sessionId = props.sessionId; }
  const scopeKey = JSON.stringify([props.project, props.fullId ?? null]);
  return <ProjectLogView key={`${cache.version}/${scopeKey}`} {...props} cache={cache} cacheVersion={cache.version} scopeKey={scopeKey} />;
}
function ProjectLogView({ sessionId, project, containers, initialPage, fullId, configure, error: collectionError, visible = true, onError, cache, cacheVersion, scopeKey }: ProjectLogsProps & { cache: ProjectLogViewCache; cacheVersion: number; scopeKey: string }) {
  const t = useI18n(observationMessages);
  const saved = useState(() => cache.read(scopeKey))[0];
  const [page, setPage] = useState<ProjectLogPage | null>(saved ? saved.page : (fullId ? null : initialWindow(initialPage)));
  const [error, setError] = useState<CoreError | null>(null);
  const [keyword, setKeyword] = useState(saved?.keyword ?? '');
  const [services, setServices] = useState<string[] | null>(saved?.services ?? null);
  const [paused, setPaused] = useState(saved?.paused ?? false);
  const [delayed, setDelayed] = useState(saved?.delayed ?? false);
  const [expanded, setExpanded] = useState(false);
  const [selecting, setSelecting] = useState(!!initialPage?.needsSelection);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set((initialPage?.sources ?? []).filter(source => source.selected && source.status !== 'removed').map(source => source.fullId)));
  const [applying, setApplying] = useState(false);
  const [selectionError, setSelectionError] = useState<CoreError | null>(null);
  const selectionRequest = useRef(0);
  const [copyStatus, setCopyStatus] = useState<'copied' | 'copyFailed' | null>(null);
  const savedScroll = useRef(saved?.savedScroll ?? 0);
  const restoredScroll = useRef<{ node: HTMLDivElement; top: number } | null>(null);
  const viewportGeometry = useRef<{ node: HTMLDivElement; height: number } | null>(null);
  const anchorInset = useRef(saved?.anchorInset ?? 0);
  const scrollToLatest = useRef(false);
  const [queryRevision, setQueryRevision] = useState(0);
  const frozenSequence = useRef<number | null>(saved?.frozenSequence ?? null);
  const pauseTransition = useRef(false);
  const viewport = useRef<HTMLDivElement>(null);
  const sourceButton = useRef<HTMLButtonElement>(null);
  const sourcePicker = useRef<HTMLFieldSetElement>(null);
  const expandButton = useRef<HTMLButtonElement>(null);
  const expandedClose = useRef<HTMLButtonElement>(null);
  const following = useRef(saved?.following ?? true);
  const offset = useRef<number | null>(saved?.offset ?? null);
  const anchor = useRef<string | null>(saved?.anchor ?? null);
  const pageRef = useRef(page); pageRef.current = page;
  const inputRef = useRef({ paused, visible, onError, keyword, services, delayed }); inputRef.current = { paused, visible, onError, keyword, services, delayed };
  const mounted = useRef(true);
  const querySequence = useRef(0);
  const pendingQuery = useRef<{ id: number; deadline: ReturnType<typeof setTimeout> } | null>(null);
  const queuedRead = useRef(false);
  const readNow = useRef<() => void>(() => {});
  const delayedRef = useRef(delayed);
  const saveView = useCallback(() => {
    if (cache.version !== cacheVersion || cache.sessionId !== sessionId) return;
    const input = inputRef.current;
    cache.save(scopeKey, { page: pageRef.current, keyword: input.keyword, services: input.services, paused: input.paused,
      frozenSequence: frozenSequence.current, savedScroll: savedScroll.current, anchorInset: anchorInset.current,
      following: following.current, offset: offset.current, anchor: anchor.current, delayed: delayedRef.current });
  }, [cache, cacheVersion, scopeKey, sessionId]);
  useLayoutEffect(saveView);
  useEffect(() => {
    mounted.current = true;
    return () => { saveView(); mounted.current = false; ++selectionRequest.current; ++querySequence.current; clearTimeout(pendingQuery.current?.deadline); pendingQuery.current = null; };
  }, [saveView]);
  const sources = page?.sources ?? initialPage?.sources ?? [];
  const sourceIds = fullId ? [fullId] : services !== null ? sources.filter(source => services.includes(source.serviceName ?? source.containerName)).map(source => source.sourceId) : [];
  const filterKey = JSON.stringify([sourceIds, keyword, !fullId && services !== null && sourceIds.length === 0]);
  // Configure describes collection startup, not the user's filtered/frozen view.
  // A returning view must keep its last page until its own query succeeds.
  useEffect(() => { if (initialPage && !saved && !pageRef.current && !inputRef.current.paused && !fullId) setPage(initialWindow(initialPage)); }, [initialPage, fullId, saved]);
  useEffect(() => {
    if (!observationApi.available() || !initialPage) return;
    let live = true; let timer: ReturnType<typeof setTimeout> | undefined;
    async function read() {
      if (!live || delayedRef.current || !inputRef.current.visible || document.visibilityState === 'hidden') return;
      if (pendingQuery.current) { queuedRead.current = true; return; }
      clearTimeout(timer); queuedRead.current = false;
      const id = ++querySequence.current;
      const deadline = setTimeout(() => {
        if (!mounted.current || pendingQuery.current?.id !== id) return;
        ++querySequence.current; pendingQuery.current = null; queuedRead.current = false;
        delayedRef.current = true; setDelayed(true);
      }, QUERY_TIMEOUT_MS);
      pendingQuery.current = { id, deadline };
      try {
        const [ids, text, missingServices] = JSON.parse(filterKey) as [string[], string, boolean];
        const queried = await projectLogApi.query(sessionId, project, { sourceIds: ids, keyword: text, offset: following.current ? null : offset.current, limit: Math.min(PAGE_SIZE, Math.max(40, Math.ceil((viewport.current?.clientHeight ?? 400) / ROW_HEIGHT) + 24)), throughSequence: frozenSequence.current, anchorRowId: following.current ? null : anchor.current });
        if (!live || id !== querySequence.current) return;
        // An empty sourceIds list means "all" in IPC. A saved service filter
        // whose sources disappeared must remain empty instead of showing all.
        const result = missingServices ? { ...queried, rows: [], totalRows: 0, offset: 0 } : queried;
        if (result.sessionId !== sessionId || result.project !== project) throw { code: 'InvalidProjectLogsResponse', message: 'Project log rows do not match the selected project.' };
        setPage(previous => !missingServices && previous?.rows.length && !result.totalRows && (result.error || result.sources.some(source => source.selected && (source.status === 'starting' || source.status === 'retrying')))
          ? { ...previous, sources: result.sources, error: result.error, needsSelection: result.needsSelection } : result);
        setError(result.error);
        if (result.error) inputRef.current.onError(result.error, result.error, sessionId);
      } catch (original) {
        if (!live || id !== querySequence.current) return; const failure = coreError(original); setError(failure); inputRef.current.onError(original, failure, sessionId);
      } finally {
        clearTimeout(deadline);
        if (pendingQuery.current?.id === id) {
          pendingQuery.current = null;
          if (queuedRead.current) { queuedRead.current = false; readNow.current(); }
          else if (live && !inputRef.current.paused && !delayedRef.current) timer = setTimeout(() => void read(), 500);
        }
      }
    }
    readNow.current = () => { void read(); };
    function visibility() { if (document.visibilityState !== 'hidden' && !inputRef.current.paused) void read(); }
    document.addEventListener('visibilitychange', visibility);
    if (pauseTransition.current) pauseTransition.current = false; else void read();
    return () => { live = false; clearTimeout(timer); document.removeEventListener('visibilitychange', visibility); };
  }, [sessionId, project, filterKey, paused, visible, queryRevision, !!initialPage]);
  function retryQuery() {
    ++querySequence.current; clearTimeout(pendingQuery.current?.deadline); pendingQuery.current = null; queuedRead.current = false;
    delayedRef.current = false; setDelayed(false); setQueryRevision(value => value + 1);
  }
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
  function selectSources() { setSelectedIds(new Set(sources.filter(source => source.selected && source.status !== 'removed').map(source => source.fullId))); setSelectionError(null); setSelecting(true); }
  function closeSources() { ++selectionRequest.current; setSelecting(false); setApplying(false); setSelectionError(null); sourceButton.current?.focus(); }
  async function applySources() {
    const request = ++selectionRequest.current;
    setApplying(true); setSelectionError(null);
    const handles = containers.filter(container => selectedIds.has(container.fullId)).map(container => container.handle);
    try {
      await configure(handles);
      if (!mounted.current || request !== selectionRequest.current) return;
      setSelecting(false); sourceButton.current?.focus(); retryQuery();
    } catch (original) {
      if (mounted.current && request === selectionRequest.current) setSelectionError(coreError(original));
    } finally { if (mounted.current && request === selectionRequest.current) setApplying(false); }
  }
  const serviceOptions = [...new Set(sources.map(source => source.serviceName ?? source.containerName))].sort();
  const needSelection = page?.needsSelection ?? initialPage?.needsSelection ?? false;
  useEffect(() => { if (needSelection) selectSources(); }, [!!needSelection]);
  useEffect(() => { if (selecting) sourcePicker.current?.querySelector<HTMLElement>('input:not(:disabled), button')?.focus(); }, [selecting]);
  const failure = error ?? (selecting && selectionError ? null : collectionError);
  const visibleSources = sources.filter(source => !fullId || source.fullId === fullId);
  const selectedSources = visibleSources.filter(source => source.selected && source.status !== 'removed');
  const hasFilters = keyword.length > 0 || services !== null;
  const emptyMessage = failure || visibleSources.some(source => source.error) ? 'logsUnavailable'
    : needSelection || (page && selectedSources.length === 0) ? (fullId ? 'sourceNotSelected' : 'noSources')
    : !page || selectedSources.some(source => source.status === 'starting' || source.status === 'retrying') ? 'logsLoading'
    : hasFilters ? 'noMatchingLogs' : 'noLogs';
  const sourceCounts = new Map<string, number>();
  for (const source of selectedSources) sourceCounts.set(source.status, (sourceCounts.get(source.status) ?? 0) + 1);
  const content = <section className={`project-logs${expanded ? ' project-logs-expanded' : ''}`} aria-label={t('logs')} onKeyDown={event => {
    if (event.key === 'Escape' && selecting) { event.preventDefault(); event.stopPropagation(); closeSources(); }
  }}>
    <div className="project-log-toolbar">
      {!fullId && <details className="project-service-filter"><summary>{t('serviceFilter')}{services !== null ? ` (${services.length})` : ''}<ChevronDown className="project-service-chevron" size={14} aria-hidden="true" /></summary><div><button onClick={() => { setServices(null); resetFilter(); }}>{t('allServices')}</button>{serviceOptions.map(service => <label key={service}><input type="checkbox" checked={services === null || services.includes(service)} disabled={(services ?? serviceOptions).length === 1 && (services === null || services.includes(service))} onChange={event => { const base = services ?? serviceOptions; setServices(event.target.checked ? [...new Set([...base, service])] : base.filter(item => item !== service)); resetFilter(); }} />{service}</label>)}</div></details>}
      <label className="project-keyword"><Search size={14} aria-hidden="true" /><input type="search" aria-label={t('keyword')} placeholder={t('keywordHint')} value={keyword} onChange={event => { setKeyword(event.target.value); resetFilter(); }} /></label>
      <button onClick={togglePaused} aria-pressed={paused}>{paused ? <Play size={14} aria-hidden="true" /> : <Pause size={14} aria-hidden="true" />}{t(paused ? 'resume' : 'pause')}</button>
      <button onClick={() => { resetFilter(); frozenSequence.current = null; setPaused(false); retryQuery(); }}>{t('latest')}</button>
      <button disabled={!page?.rows.length} aria-label={t('copy')} title={t('copy')} onClick={() => void navigator.clipboard.writeText(logRowsText(page?.rows ?? [])).then(() => setCopyStatus('copied'), () => setCopyStatus('copyFailed'))}><Copy size={14} aria-hidden="true" /></button>
      <button ref={expanded ? expandedClose : expandButton} aria-label={t(expanded ? 'collapse' : 'expand')} onClick={toggleExpanded}>{expanded ? <Minimize2 size={14} aria-hidden="true" /> : <Maximize2 size={14} aria-hidden="true" />}</button>
      {!fullId && <button ref={sourceButton} onClick={selectSources}>{t('changeSources')}</button>}
    </div>
    {copyStatus && <p className="observation-hint" role="status">{t(copyStatus)}</p>}
    {paused && <p className="observation-hint" role="status">{t('pausedHint')}</p>}
    {delayed && <div className="project-log-delay" role="status"><span>{t(page?.rows.length ? 'queryDelayedWithData' : 'queryDelayed')}</span><button onClick={retryQuery}>{t('retryQuery')}</button></div>}
    {(failure || visibleSources.some(source => source.error)) && <div role="alert">{failure && <ErrorDetails error={failure} />}{sources.filter(source => source.error && (!fullId || source.fullId === fullId)).map(source => <div key={source.sourceId}><span>{source.containerName}</span><ErrorDetails error={source.error!} /></div>)}<button onClick={() => void projectLogApi.retry(sessionId).then(() => { if (mounted.current) retryQuery(); }).catch(original => { if (!mounted.current) return; const next = coreError(original); setError(next); onError(original, next, sessionId); })}>{t('retry')}</button></div>}
    {selecting && <fieldset ref={sourcePicker} className="project-source-selection" aria-busy={applying}><legend>{t('selectSources')}</legend><div className="project-source-heading"><p>{t('selectionHint')}</p><button className="icon-button" aria-label={t('closeSources')} onClick={closeSources}><X size={16} aria-hidden="true" /></button></div><p>{t('selectionCount', { selected: selectedIds.size, total: sources.filter(source => source.status !== 'removed').length })}</p><div className="project-source-options">{sources.filter(source => source.status !== 'removed').map(source => <label key={source.fullId}><input type="checkbox" checked={selectedIds.has(source.fullId)} disabled={applying || (!selectedIds.has(source.fullId) && selectedIds.size >= 64)} onChange={event => setSelectedIds(previous => { const next = new Set(previous); if (event.target.checked) next.add(source.fullId); else next.delete(source.fullId); return next; })} />{source.serviceName ?? '—'} · {source.containerName}</label>)}</div>{selectionError && <div role="alert"><ErrorDetails error={selectionError} /></div>}<div className="project-source-actions"><button onClick={closeSources}>{t('cancel')}</button><button disabled={applying} onClick={() => void applySources()}>{t(applying ? 'applying' : 'apply')}</button></div></fieldset>}
    <details className="project-log-sources"><summary><span>{t('selectionCount', { selected: selectedSources.length, total: visibleSources.filter(source => source.status !== 'removed').length })}</span><span className="project-source-counts">{[...sourceCounts].map(([status, count]) => <span key={status} data-status={status}>{t(status as typeof selectedSources[number]['status'])} {count}</span>)}</span><span>{t('sourceDetails')}</span><ChevronDown size={12} aria-hidden="true" /></summary><div>{sources.filter(source => source.selected && (!fullId || source.fullId === fullId)).map(source => <span key={source.sourceId} data-status={source.status} title={source.error?.message}>{source.containerName} · {t(source.status)}</span>)}</div></details>
    <div className="project-log-meta"><span>{t('count', { count: page?.totalRows ?? 0 })}</span><span>{t('logCollectionHint')}</span>{!!page?.coverageGaps && <span className="observation-warning">{t('gap')} · {page.coverageGaps}</span>}{page?.anchorLost && <span className="observation-warning">{t('anchorLost')}</span>}{page?.retainedFrom && <span>{t('coverage')} (UTC): {page.retainedFrom.slice(0, 19).replace('T', ' ')} – {page.retainedTo?.slice(0, 19).replace('T', ' ') ?? '—'}</span>}{!!page?.droppedRows && <span className="observation-warning">{t('trimmed', { count: page.droppedRows })}</span>}</div>
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
      {!page?.totalRows ? <div className="project-log-empty">{!delayed && <p className="observation-hint" role="status">{t(emptyMessage)}</p>}{emptyMessage === 'noMatchingLogs' && <button onClick={() => { setKeyword(''); setServices(null); resetFilter(); }}>{t('clearFilters')}</button>}</div> : <div className="project-log-spacer" style={{ height: page.totalRows * ROW_HEIGHT }}><div className="project-log-window" style={{ top: page.offset * ROW_HEIGHT }}>{page.rows.map(row => <div key={row.rowId} className="project-log-row" data-pipe={row.pipe} style={{ height: ROW_HEIGHT }}><time dateTime={row.timestamp ?? row.receivedAt} title={`${row.timestamp ?? `${t('received')}: ${row.receivedAt}`}`}>{(row.timestamp ?? row.receivedAt).slice(11, 23)}{!row.timestamp && '*'}</time><span title={row.serviceName ?? undefined}>{row.serviceName ?? '—'}</span><span title={row.fullId}>{row.containerName}</span><span>{row.text}{row.truncated && <em title={t('lineTrimmed')}> …</em>}</span></div>)}</div></div>}
    </div>
  </section>;
  if (!expanded) return content;
  return createPortal(<div className="project-log-modal" role="dialog" aria-modal="true" aria-label={t('logs')} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); toggleExpanded(); }
    if (event.key === 'Tab') { const elements = event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"], summary'); const first = elements[0]; const last = elements[elements.length - 1]; if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); } }
  }}>{content}</div>, document.body);
}
