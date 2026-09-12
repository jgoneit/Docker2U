import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDownToLine, ChevronDown, ChevronUp, Copy, FileText, Info, Maximize2, Pause, Play, RefreshCw, Search, Trash2, X } from 'lucide-react';
import type { Container, ContainerList, CoreError } from './api';
import { ErrorDetails, formatTime, readableStates, type CopyText } from './components';
import { CopyFeedback, type CopyFeedbackTone } from './CopyFeedback';
import { useI18n } from './i18n';
import { useLogSearch } from './useLogSearch';
import type { LogSnapshot } from './logSnapshot';
import { logMessages } from './messages/logs';
import { usePreferences } from './preferences';
import type { LiveLogStatus } from './liveLogController';
import type { StandaloneLogViewCache } from './standaloneLogViewCache';
import './liveLogs.css';

const followStates = new Set(['running', 'paused', 'restarting']);

interface LogPanelProps {
  container: Container; snapshot: ContainerList; logs: LogSnapshot | null; logsError: CoreError | null;
  loadingLogs: boolean; logRequestPending?: boolean; liveStatus?: LiveLogStatus; refreshing: boolean; mutating: boolean; loadLogs: () => void; clearLogs: () => void; copy: CopyText; copyFeedback?: string; copyFeedbackTone?: CopyFeedbackTone; copyFeedbackId?: number; copyFeedbackHighlighted?: boolean; copyFeedbackHighlightUntil?: number;
  expanded: boolean; onExpandedChange: (expanded: boolean) => void;
  visible?: boolean; operationFeedback?: ReactNode; viewCache?: StandaloneLogViewCache;
}
export function LogPanel(props: LogPanelProps) {
  const cache = props.viewCache;
  if (cache && cache.sessionId !== props.snapshot.sessionId) { cache.clear(); cache.sessionId = props.snapshot.sessionId; }
  return <LogPanelView key={cache ? `${cache.version}/${props.snapshot.sessionId}/${props.container.fullId}` : undefined} {...props} cacheVersion={cache?.version} />;
}
function LogPanelView({ container, snapshot, logs: incomingLogs, logsError, loadingLogs, logRequestPending = false, liveStatus, refreshing, mutating, loadLogs, clearLogs, copy, copyFeedback, copyFeedbackTone, copyFeedbackId, copyFeedbackHighlighted, copyFeedbackHighlightUntil, expanded, onExpandedChange, visible = true, operationFeedback, viewCache, cacheVersion }: LogPanelProps & { cacheVersion?: number }) {
  const t = useI18n(logMessages);
  const { language } = usePreferences();
  const saved = useState(() => viewCache?.read(container.fullId))[0];
  const target = `${snapshot.sessionId}/${container.fullId}`;
  const lastSuccessfulLogs = useRef<LogSnapshot | null>(saved?.lastLogs ?? null);
  const clearedInput = useRef<LogSnapshot | null>(null);
  const known = lastSuccessfulLogs.current;
  // A pinned follow can deliver its first frame after inventory rotates its handle.
  const targetHandles = useRef(new Set([container.handle]));
  targetHandles.current.add(container.handle);
  const ownsIncoming = !viewCache || !!incomingLogs && incomingLogs.sessionId === snapshot.sessionId
    && (targetHandles.current.has(incomingLogs.handle) || incomingLogs === known
      || !!incomingLogs.streamId && incomingLogs.streamId === known?.streamId
      || incomingLogs.handle === known?.handle && incomingLogs.generation === known?.generation);
  const unreadable = !snapshot.stale && !readableStates.has(container.state);
  const received = !unreadable && ownsIncoming && incomingLogs && incomingLogs !== clearedInput.current
    && (incomingLogs.source !== 'live' || (incomingLogs.sequence ?? -1) >= 0 || liveStatus === 'ended' && !logsError) ? incomingLogs : null;
  if (viewCache && unreadable) lastSuccessfulLogs.current = null;
  else if (viewCache && received) lastSuccessfulLogs.current = received;
  // Navigation clears/restarts the transport before the new target has a frame.
  // Keep its own last successful display until a real replacement arrives.
  const logs = viewCache ? received ?? lastSuccessfulLogs.current : incomingLogs;
  const inlinePanel = useRef<HTMLElement>(null);
  const inlineContent = useRef<HTMLPreElement>(null);
  const modalContent = useRef<HTMLPreElement>(null);
  const inlineMatch = useRef<HTMLElement>(null);
  const modalMatch = useRef<HTMLElement>(null);
  const inlineSearchToggle = useRef<HTMLButtonElement>(null);
  const modalSearchToggle = useRef<HTMLButtonElement>(null);
  const inlineSearch = useRef<HTMLInputElement>(null);
  const modalSearch = useRef<HTMLInputElement>(null);
  const expandButton = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const scrollPosition = useRef(saved?.scrollTop ?? 0);
  const beforeExpandPosition = useRef(0);
  const modalInitialPosition = useRef(0);
  const wasExpanded = useRef(false);
  const copyAttempt = useRef(0);
  const [showCopyFeedback, setShowCopyFeedback] = useState(false);
  const [searchOpen, setSearchOpen] = useState(saved?.searchOpen ?? false);
  const [searchFocusVersion, setSearchFocusVersion] = useState(0);
  const [query, setQuery] = useState(saved?.query ?? '');
  const [manuallyPaused, setManuallyPaused] = useState(saved?.manuallyPaused ?? false);
  const [frozenLogs, setFrozenLogs] = useState<LogSnapshot | null>(saved?.frozenLogs ?? null);
  const frozenTarget = useRef(viewCache ? target : '');
  const restoringSearchScroll = useRef(!!saved?.searchOpen);
  const awaitingRestoredSnapshot = useRef(!!saved && (saved.manuallyPaused || saved.searchOpen) && !saved.frozenLogs);
  const awaitingReadableSnapshot = useRef(false);
  const awaitingLiveSnapshot = useRef(false);
  const followingBottom = useRef(saved?.followingBottom ?? true);
  const [atBottom, setAtBottom] = useState(saved?.atBottom ?? true);
  const [resumeDropped, setResumeDropped] = useState(false);
  const [payloadEvicted, setPayloadEvicted] = useState(saved?.payloadEvicted ?? false);
  const [navigationVersion, setNavigationVersion] = useState(0);
  // Inventory generations rotate handles; a reload of the same container keeps the search.
  const hasLiveControls = logs?.source === 'live' || (liveStatus !== undefined && followStates.has(container.state));
  const previousLiveMode = useRef(hasLiveControls);
  const frozen = hasLiveControls && (manuallyPaused || searchOpen) && frozenTarget.current === target;
  const displayedLogs = !snapshot.stale && !readableStates.has(container.state) ? null : frozen ? frozenLogs : logs;
  const text = hasLiveControls || viewCache ? displayedLogs?.text ?? '' : !loadingLogs && !logsError ? logs?.text ?? '' : '';
  const displayDropped = !!displayedLogs?.truncated;
  const hasReceipt = displayedLogs && (displayedLogs.source !== 'live' || (displayedLogs.receivedBytes ?? displayedLogs.byteCount) > 0);
  const droppedWhileFrozen = frozen && !!logs && (!!frozenLogs && logs.streamId !== frozenLogs.streamId || (logs.droppedBatches ?? 0) > (frozenLogs?.droppedBatches ?? 0) || (logs.droppedBytes ?? 0) > (frozenLogs?.droppedBytes ?? 0) || (!frozenLogs?.truncated && logs.truncated));
  const canCopy = text.length > 0;
  const { status: searchStatus, total, activeIndex, activeStart, activeLength, move } = useLogSearch({ target, text, query });
  const stateToSave = useRef({ query, searchOpen, manuallyPaused, frozenLogs, lastLogs: displayedLogs, atBottom, payloadEvicted });
  stateToSave.current = { query, searchOpen, manuallyPaused, frozenLogs: manuallyPaused || searchOpen ? frozenLogs : null, lastLogs: displayedLogs, atBottom, payloadEvicted };
  useLayoutEffect(() => {
    if (viewCache && viewCache.version === cacheVersion && viewCache.sessionId === snapshot.sessionId) viewCache.save(container.fullId, { ...stateToSave.current, scrollTop: scrollPosition.current, followingBottom: followingBottom.current });
  });
  useEffect(() => () => {
    if (viewCache && viewCache.version === cacheVersion && viewCache.sessionId === snapshot.sessionId) viewCache.save(container.fullId, { ...stateToSave.current, scrollTop: scrollPosition.current, followingBottom: followingBottom.current });
  }, [viewCache, cacheVersion, snapshot.sessionId, container.fullId]);
  useEffect(() => { ++copyAttempt.current; setShowCopyFeedback(false); }, [expanded, target]);
  useLayoutEffect(() => {
    if (!expanded) return;
    const focused = document.activeElement;
    if (!(focused instanceof HTMLElement) || !dialog.current?.contains(focused) || focused.matches(':disabled')) closeButton.current?.focus();
  }, [expanded, logs, logsError, loadingLogs]);
  useLayoutEffect(() => {
    if (viewCache) return;
    setSearchOpen(false); setQuery(''); setManuallyPaused(false); setFrozenLogs(null); setResumeDropped(false);
    awaitingLiveSnapshot.current = false;
    followingBottom.current = true; setAtBottom(true); frozenTarget.current = target; scrollPosition.current = 0;
    if (inlineContent.current) inlineContent.current.scrollTop = 0;
  }, [target, viewCache]);
  useLayoutEffect(() => {
    if (!awaitingRestoredSnapshot.current || !received) return;
    awaitingRestoredSnapshot.current = false;
    if (hasLiveControls && (manuallyPaused || searchOpen)) { frozenTarget.current = target; setFrozenLogs(received); }
  }, [received, hasLiveControls, manuallyPaused, searchOpen, target]);
  useLayoutEffect(() => {
    if (previousLiveMode.current === hasLiveControls) return;
    previousLiveMode.current = hasLiveControls;
    // Pause belongs to a follow display. A replacement one-shot snapshot must
    // update an open search instead of retaining the previous stream's text.
    setManuallyPaused(false); setFrozenLogs(null); setResumeDropped(false);
    awaitingLiveSnapshot.current = hasLiveControls && searchOpen;
  }, [hasLiveControls, searchOpen]);
  useLayoutEffect(() => {
    if (!awaitingLiveSnapshot.current) return;
    if (!hasLiveControls || !searchOpen) { awaitingLiveSnapshot.current = false; return; }
    // A retained snapshot/search may precede the new follow's first frame.
    // Capture that frame once instead of freezing an empty connecting buffer.
    if (logs?.source === 'live' && (logs.sequence ?? -1) >= 0) {
      awaitingLiveSnapshot.current = false;
      frozenTarget.current = target; setFrozenLogs(logs);
    }
  }, [hasLiveControls, searchOpen, logs, target]);
  useLayoutEffect(() => {
    if (!snapshot.stale && !readableStates.has(container.state)) {
      awaitingReadableSnapshot.current = true; setFrozenLogs(null); setResumeDropped(false);
    } else if (awaitingReadableSnapshot.current && logs && (logs.source !== 'live' || (logs.sequence ?? -1) >= 0)) {
      awaitingReadableSnapshot.current = false; setFrozenLogs(logs);
    }
  }, [container.state, snapshot.stale, logs]);
  useLayoutEffect(() => {
    if (!visible && !expanded) return;
    const content = expanded ? modalContent.current : inlineContent.current;
    if (content) {
      content.scrollTop = scrollPosition.current;
      if (expanded) modalInitialPosition.current = content.scrollTop;
    }
  }, [expanded, visible]);
  useLayoutEffect(() => {
    if ((!visible && !expanded) || !hasLiveControls || frozen || !followingBottom.current) return;
    const content = expanded ? modalContent.current : inlineContent.current;
    if (content) { content.scrollTop = content.scrollHeight; scrollPosition.current = content.scrollTop; }
  }, [text, frozen, hasLiveControls, visible, expanded]);
  useLayoutEffect(() => {
    const viewport = inlineContent.current;
    if (!visible || expanded || !viewport || !hasLiveControls || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (!viewport.clientHeight || frozen || !followingBottom.current) return;
      // Resizing the pane changes the bottom offset without receiving new text.
      viewport.scrollTop = viewport.scrollHeight;
      scrollPosition.current = viewport.scrollTop;
      setAtBottom(true);
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [expanded, hasLiveControls, frozen, !!logsError, visible]);
  useLayoutEffect(() => {
    const content = expanded ? modalContent.current : inlineContent.current;
    const match = expanded ? modalMatch.current : inlineMatch.current;
    if ((!visible && !expanded) || !searchOpen || !content || !match || restoringSearchScroll.current) return;
    const viewport = content.getBoundingClientRect();
    const position = match.getBoundingClientRect();
    content.scrollTop += position.top - viewport.top - (content.clientHeight - position.height) / 2;
    content.scrollIntoView?.({ block: 'nearest' });
    scrollPosition.current = content.scrollTop;
  }, [expanded, searchOpen, activeIndex, query, text, activeStart, activeLength, navigationVersion]);
  useLayoutEffect(() => {
    if (!searchOpen || !searchFocusVersion) return;
    const input = expanded ? modalSearch.current : inlineSearch.current;
    input?.focus();
    input?.select();
  }, [searchOpen, searchFocusVersion]);
  useEffect(() => {
    if (expanded) closeButton.current?.focus();
    else if (wasExpanded.current) expandButton.current?.focus();
    wasExpanded.current = expanded;
  }, [expanded]);
  useEffect(() => {
    function documentKeyDown(event: globalThis.KeyboardEvent) {
      if (event.defaultPrevented) return;
      const panel = expanded ? dialog.current : inlinePanel.current;
      // Settings and confirmation make the inline panel inert. The expanded
      // portal has its own active surface outside that inert background.
      if (!panel || panel.closest('[inert], [hidden]')) return;
      const mac = /mac/i.test(navigator.platform);
      const findModifier = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
      if (event.key.toLowerCase() === 'f' && findModifier && !event.altKey && !event.shiftKey && !event.isComposing) {
        event.preventDefault(); openSearch(); return;
      }
      // macOS WebView button clicks can leave focus on the document instead of
      // inside the dialog. Escape and Tab must still reach the active modal.
      if (expanded && (event.key === 'Escape' || (event.key === 'Tab' && !dialog.current?.contains(document.activeElement)))) keyDown(event);
      else if (!expanded && searchOpen && event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); closeSearch(false);
      }
    }
    document.addEventListener('keydown', documentKeyDown);
    return () => document.removeEventListener('keydown', documentKeyDown);
  }, [expanded, onExpandedChange, searchOpen, hasLiveControls, manuallyPaused, logs, frozen, droppedWhileFrozen, target]);
  function reloadLogs() {
    // Explicit reload keeps the existing one-shot loading/clear behavior. Only
    // navigation and a new follow's initial buffer restore a cached display.
    lastSuccessfulLogs.current = null;
    clearedInput.current = incomingLogs;
    loadLogs();
  }
  async function copyLogs(inModal: boolean) {
    if (!canCopy) return;
    const attempt = ++copyAttempt.current;
    await copy(text, 'logs');
    if (inModal && copyAttempt.current === attempt) setShowCopyFeedback(true);
  }
  function expand() {
    scrollPosition.current = inlineContent.current?.scrollTop ?? scrollPosition.current;
    beforeExpandPosition.current = scrollPosition.current;
    onExpandedChange(true);
  }
  function close() {
    const current = modalContent.current?.scrollTop ?? scrollPosition.current;
    // A taller viewport can clamp the initial position at the end of the log.
    // Restore the original inline position when the user has not moved it.
    scrollPosition.current = current === modalInitialPosition.current ? beforeExpandPosition.current : current;
    onExpandedChange(false);
  }
  function openSearch() {
    restoringSearchScroll.current = false;
    if (hasLiveControls && !frozen) { setFrozenLogs(logs); frozenTarget.current = target; }
    setSearchOpen(true);
    setSearchFocusVersion(version => version + 1);
  }
  function closeSearch(inModal: boolean) {
    restoringSearchScroll.current = false;
    if (!manuallyPaused && droppedWhileFrozen) setResumeDropped(true);
    setSearchOpen(false);
    (inModal ? modalSearchToggle.current : inlineSearchToggle.current)?.focus();
  }
  function togglePause() {
    if (manuallyPaused) {
      if (!searchOpen && droppedWhileFrozen) setResumeDropped(true);
      setManuallyPaused(false);
    } else {
      if (!frozen) { setFrozenLogs(logs); frozenTarget.current = target; }
      setManuallyPaused(true);
    }
  }
  function moveMatch(direction: 1 | -1) {
    restoringSearchScroll.current = false;
    if (searchStatus === 'ready' && total) {
      move(direction);
      setNavigationVersion(version => version + 1);
    }
  }
  function bottom(inModal: boolean) {
    const content = inModal ? modalContent.current : inlineContent.current;
    if (!content) return;
    followingBottom.current = true; setAtBottom(true);
    content.scrollTop = content.scrollHeight;
    content.scrollIntoView?.({ block: 'nearest' });
    scrollPosition.current = content.scrollTop;
  }
  function keyDown(event: KeyboardEvent<HTMLDivElement> | globalThis.KeyboardEvent) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key !== 'Tab') return;
    const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"], summary') ?? []).filter(control => {
      if (control.closest('[hidden], [inert]')) return false;
      // Closed details expose only their first summary; their scrollable pre elements
      // must not become the trap boundary until the user expands the disclosure.
      for (let ancestor = control.parentElement; ancestor && ancestor !== dialog.current; ancestor = ancestor.parentElement) {
        if (ancestor instanceof HTMLDetailsElement && !ancestor.open) {
          const summary = Array.from(ancestor.children).find(child => child.tagName === 'SUMMARY');
          if (!summary?.contains(control)) return false;
        }
      }
      return true;
    });
    const first = controls?.[0];
    const last = controls?.[controls.length - 1];
    if (!dialog.current?.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first)?.focus(); }
    else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
  function content(inModal: boolean) {
    const id = inModal ? 'expanded-logs-title' : 'logs-title';
    const searchId = inModal ? 'expanded-logs-search' : 'logs-search';
    const mac = /mac/i.test(navigator.platform);
    return <section ref={inModal ? undefined : inlinePanel} className="logs-panel" aria-labelledby={id} hidden={!inModal && expanded}>
      <div className="section-heading log-toolbar-heading"><h3 id={id}><FileText size={16} aria-hidden="true" />{t('title')}</h3><div className="compact-actions log-toolbar">
        <div className="log-toolbar-group">
          {hasLiveControls && <button className="log-pause-toggle" aria-pressed={manuallyPaused} onClick={togglePause} title={t(manuallyPaused ? 'resumeDetails' : 'pauseDetails')}>{manuallyPaused ? <Play size={13} aria-hidden="true" /> : <Pause size={13} aria-hidden="true" />}{t(manuallyPaused ? 'resume' : 'pause')}</button>}
          <button className="log-tool-icon log-tool-quiet" aria-label={t('fetch')} title={logRequestPending ? t('requestPending') : t('fetch')} aria-describedby={logRequestPending && !loadingLogs ? `${id}-pending` : undefined} disabled={snapshot.stale || logRequestPending || loadingLogs || refreshing || mutating || !readableStates.has(container.state)} onClick={reloadLogs}><RefreshCw size={13} className={loadingLogs ? 'spin' : ''} aria-hidden="true" /></button>
        </div>
        <div className="log-toolbar-group">
          <button ref={inModal ? modalSearchToggle : inlineSearchToggle} className="log-tool-icon log-tool-quiet log-search-toggle" aria-label={t(searchOpen ? 'closeSearch' : 'openSearch')} title={`${t('search')} (${mac ? '⌘F' : 'Ctrl+F'})`} aria-keyshortcuts={mac ? 'Meta+F' : 'Control+F'} aria-expanded={searchOpen} aria-controls={inModal ? 'expanded-log-search-row' : 'log-search-row'} onClick={() => searchOpen ? closeSearch(inModal) : openSearch()}><Search size={13} aria-hidden="true" /></button>
          <button className={`log-tool-icon log-tool-quiet${hasLiveControls && !atBottom ? ' log-latest-button' : ''}`} hidden={hasLiveControls && atBottom} disabled={!text} onClick={event => {
            bottom(inModal);
            if (hasLiveControls) (inModal ? modalContent.current : inlineContent.current)?.focus();
            else event.currentTarget.focus();
          }} aria-label={t(hasLiveControls ? 'latest' : 'bottom')} title={t(hasLiveControls ? 'latest' : 'bottom')}><ArrowDownToLine size={13} aria-hidden="true" /></button>
          {!inModal && <button className="log-tool-icon log-tool-quiet" ref={expandButton} onClick={expand} aria-label={t('expand')} title={t('expand')}><Maximize2 size={13} aria-hidden="true" /></button>}
          <button className="log-tool-icon log-tool-quiet" disabled={!canCopy} onClick={() => void copyLogs(inModal)} aria-label={t('copy')} title={t('copy')}><Copy size={13} aria-hidden="true" /></button>
          <button className="log-tool-icon log-tool-quiet" disabled={unreadable || !logs && !(ownsIncoming && incomingLogs) && !logsError && !loadingLogs} onClick={() => {
            // Clearing disables this button; keep keyboard focus on an enabled target.
            if (inModal) closeButton.current?.focus();
            else (inlineContent.current ?? expandButton.current)?.focus();
            ++copyAttempt.current;
            clearedInput.current = incomingLogs; lastSuccessfulLogs.current = null; awaitingRestoredSnapshot.current = false; restoringSearchScroll.current = false;
            setShowCopyFeedback(inModal);
            setSearchOpen(false); setQuery(''); setFrozenLogs(null); setResumeDropped(false); setPayloadEvicted(false); clearLogs();
          }} aria-label={t('clear')} title={t('clear')}><Trash2 size={13} aria-hidden="true" /></button>
        </div>
      </div></div>
      <div className="log-meta">{logRequestPending && !loadingLogs && <span id={`${id}-pending`} role="status">{t('requestPending')}</span>}{hasLiveControls && liveStatus && <span className={`log-stream-status log-stream-${liveStatus}`}>{t(liveStatus === 'following' && frozen ? searchOpen ? 'searchPaused' : 'displayPaused' : liveStatus === 'following' ? 'following' : liveStatus === 'connecting' ? 'connecting' : liveStatus === 'ended' ? 'ended' : liveStatus === 'error' ? 'streamError' : 'idle')}</span>}<span title={t(hasLiveControls ? 'liveLimitDetails' : 'limitDetails')}>{t(hasLiveControls ? 'liveLimits' : 'limits')}</span><span className="log-sensitive" role="img" aria-label={t('sensitive')} title={t('sensitive')}><Info size={13} aria-hidden="true" /></span>{hasReceipt && <span className="log-fetched-at">{t(hasLiveControls ? 'lastReceived' : 'fetchedAt')} <time dateTime={displayedLogs.fetchedAt}>{formatTime(displayedLogs.fetchedAt, language)}</time></span>}</div>
      <div id={inModal ? 'expanded-log-search-row' : 'log-search-row'} className="log-search" role="search" aria-label={t('searchArea')} hidden={!searchOpen}>
        <label htmlFor={searchId}>{t('search')}</label>
        <div className="log-search-field"><input ref={inModal ? modalSearch : inlineSearch} id={searchId} className="log-search-input" type="search" value={query} autoComplete="off" spellCheck={false} onChange={event => { restoringSearchScroll.current = false; setQuery(event.target.value); }} onKeyDown={event => {
          if (event.key === 'Enter') { event.preventDefault(); moveMatch(event.shiftKey ? -1 : 1); }
        }} />{query && <button className="log-search-clear" onClick={() => { (inModal ? modalSearch.current : inlineSearch.current)?.focus(); setQuery(''); }} aria-label={t('clearSearch')} title={t('clearSearch')}><X size={14} aria-hidden="true" /></button>}</div>
        <span className="log-search-count" aria-live="polite" aria-atomic="true">{searchStatus === 'searching' ? t('searching') : searchStatus === 'error' ? t('searchFailed') : total ? t('matchCount', { current: activeIndex + 1, total }) : t('zeroMatches')}</span>
        <button disabled={searchStatus !== 'ready' || !total} onClick={() => moveMatch(-1)} aria-label={t('previousMatch')} title={t('previousMatch')}><ChevronUp size={14} aria-hidden="true" /></button>
        <button disabled={searchStatus !== 'ready' || !total} onClick={() => moveMatch(1)} aria-label={t('nextMatch')} title={t('nextMatch')}><ChevronDown size={14} aria-hidden="true" /></button>
      </div>
      {displayDropped && <p className="truncation-notice" role="status">{t('truncated')}</p>}
      {payloadEvicted && displayedLogs && <p className="truncation-notice" role="status">{t('cacheRangeReplaced')}</p>}
      {(droppedWhileFrozen || resumeDropped) && <p className="truncation-notice" role="status">{t(droppedWhileFrozen ? 'pendingDropped' : 'resumedDropped')}</p>}
      {logsError && <div className={`log-error ${hasLiveControls ? 'log-stream-error' : ''}`} role="alert"><p>{t('failed')}</p><ErrorDetails error={logsError} /></div>}
      {(!logsError || hasLiveControls || !!viewCache && !!text) && <pre ref={inModal ? modalContent : inlineContent} tabIndex={0} className={`log-content ${!text ? 'log-placeholder' : ''}`} aria-label={t('content')} aria-busy={loadingLogs} onScroll={event => { if (inModal || (!expanded && visible)) {
        const element = event.currentTarget; scrollPosition.current = element.scrollTop;
        if (hasLiveControls && element.scrollHeight - element.clientHeight - element.scrollTop > 24) {
          // Resizing can clamp a scrolled-up viewport onto its new bottom. A scroll
          // event may stop following, but only Latest logs explicitly resumes it.
          followingBottom.current = false; setAtBottom(false);
        }
      } }}>{loadingLogs && !text ? t('loading') : text ? !searchOpen || activeStart === undefined ? text : <>{text.slice(0, activeStart)}<mark ref={inModal ? modalMatch : inlineMatch} className="log-search-match">{text.slice(activeStart, activeStart + activeLength)}</mark>{text.slice(activeStart + activeLength)}</> : snapshot.stale ? t('stale') : !readableStates.has(container.state) ? t('unreadable') : logs ? t('empty') : t('initial')}</pre>}
    </section>;
  }
  return <>{content(false)}{expanded && createPortal(<div className="modal-backdrop"><div ref={dialog} className="logs-modal" role="dialog" aria-modal="true" aria-labelledby="logs-dialog-title" onKeyDown={keyDown}>
    <div className="logs-dialog-heading section-heading"><h2 id="logs-dialog-title">{t('expandedTitle', { name: container.name })}</h2><button ref={closeButton} className="icon-button" onClick={close} aria-label={t('close')}><X size={18} aria-hidden="true" /></button></div>
    {content(true)}
    <div className="operation-statusbar">{operationFeedback}<CopyFeedback className="log-copy-feedback" message={showCopyFeedback ? copyFeedback ?? '' : ''} tone={copyFeedbackTone} notificationId={copyFeedbackId} highlighted={copyFeedbackHighlighted} highlightUntil={copyFeedbackHighlightUntil} /></div>
  </div></div>, document.body)}</>;
}
