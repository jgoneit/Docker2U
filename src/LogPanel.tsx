import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDownToLine, ChevronDown, ChevronUp, Copy, FileText, Info, Maximize2, RefreshCw, Search, X } from 'lucide-react';
import type { Container, ContainerList, CoreError } from './api';
import { ErrorDetails, formatTime, readableStates, type CopyText } from './components';
import { useI18n } from './i18n';
import { findLogMatches } from './logSearch';
import type { LogSnapshot } from './logSnapshot';
import { logMessages } from './messages/logs';
import { usePreferences } from './preferences';

export function LogPanel({ container, snapshot, logs, logsError, loadingLogs, refreshing, mutating, loadLogs, clearLogs, copy, copyFeedback, expanded, onExpandedChange }: {
  container: Container; snapshot: ContainerList; logs: LogSnapshot | null; logsError: CoreError | null;
  loadingLogs: boolean; refreshing: boolean; mutating: boolean; loadLogs: () => void; clearLogs: () => void; copy: CopyText; copyFeedback?: string;
  expanded: boolean; onExpandedChange: (expanded: boolean) => void;
}) {
  const t = useI18n(logMessages);
  const { language } = usePreferences();
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
  const scrollPosition = useRef(0);
  const beforeExpandPosition = useRef(0);
  const modalInitialPosition = useRef(0);
  const wasExpanded = useRef(false);
  const copyAttempt = useRef(0);
  const [showCopyFeedback, setShowCopyFeedback] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchFocusVersion, setSearchFocusVersion] = useState(0);
  const [query, setQuery] = useState('');
  const [matchIndex, setMatchIndex] = useState(0);
  const [navigationVersion, setNavigationVersion] = useState(0);
  // Inventory generations rotate handles; a reload of the same container keeps the search.
  const target = `${snapshot.sessionId}/${container.fullId}`;
  const text = !loadingLogs && !logsError ? logs?.text ?? '' : '';
  const matches = useMemo(() => findLogMatches(text, query), [text, query]);
  const activeIndex = matches.length ? Math.min(matchIndex, matches.length - 1) : 0;
  const activeStart = matches[activeIndex];
  useEffect(() => { ++copyAttempt.current; setShowCopyFeedback(false); }, [expanded, target]);
  useLayoutEffect(() => {
    if (!expanded) return;
    const focused = document.activeElement;
    if (!(focused instanceof HTMLElement) || !dialog.current?.contains(focused) || focused.matches(':disabled')) closeButton.current?.focus();
  }, [expanded, logs, logsError, loadingLogs]);
  useLayoutEffect(() => {
    setSearchOpen(false); setQuery(''); setMatchIndex(0); scrollPosition.current = 0;
    if (inlineContent.current) inlineContent.current.scrollTop = 0;
  }, [target]);
  useLayoutEffect(() => { setMatchIndex(0); }, [logs?.text]);
  useLayoutEffect(() => {
    const content = expanded ? modalContent.current : inlineContent.current;
    if (content) {
      content.scrollTop = scrollPosition.current;
      if (expanded) modalInitialPosition.current = content.scrollTop;
    }
  }, [expanded]);
  useLayoutEffect(() => {
    const content = expanded ? modalContent.current : inlineContent.current;
    const match = expanded ? modalMatch.current : inlineMatch.current;
    if (!searchOpen || !content || !match) return;
    const viewport = content.getBoundingClientRect();
    const position = match.getBoundingClientRect();
    content.scrollTop += position.top - viewport.top - (content.clientHeight - position.height) / 2;
    content.scrollIntoView?.({ block: 'nearest' });
    scrollPosition.current = content.scrollTop;
  }, [expanded, searchOpen, activeIndex, query, text, navigationVersion, language]);
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
  }, [expanded, onExpandedChange, searchOpen]);
  async function copyLogs(inModal: boolean) {
    if (!logs) return;
    const attempt = ++copyAttempt.current;
    setShowCopyFeedback(false);
    await copy(logs.text, 'logs');
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
    setSearchOpen(true);
    setSearchFocusVersion(version => version + 1);
  }
  function closeSearch(inModal: boolean) {
    setSearchOpen(false);
    (inModal ? modalSearchToggle.current : inlineSearchToggle.current)?.focus();
  }
  function moveMatch(direction: number) {
    if (matches.length) {
      setMatchIndex((activeIndex + direction + matches.length) % matches.length);
      setNavigationVersion(version => version + 1);
    }
  }
  function bottom(inModal: boolean) {
    const content = inModal ? modalContent.current : inlineContent.current;
    if (!content) return;
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
      <div className="section-heading"><h3 id={id}><FileText size={16} aria-hidden="true" />{t('title')}</h3><div className="compact-actions">
        <button disabled={snapshot.stale || loadingLogs || refreshing || mutating || !readableStates.has(container.state)} onClick={loadLogs}><RefreshCw size={13} className={loadingLogs ? 'spin' : ''} aria-hidden="true" />{t('fetch')}</button>
        <button disabled={!logs?.text} onClick={() => void copyLogs(inModal)} aria-label={t('copy')} title={t('copy')}><Copy size={13} aria-hidden="true" /></button>
        <button disabled={!logs && !logsError && !loadingLogs} onClick={() => {
          // Clearing disables this button; keep keyboard focus on an enabled target.
          if (inModal) closeButton.current?.focus();
          else (inlineContent.current ?? expandButton.current)?.focus();
          setSearchOpen(false); setQuery(''); setMatchIndex(0); clearLogs();
        }} aria-label={t('clear')} title={t('clear')}><X size={13} aria-hidden="true" /></button>
        <button ref={inModal ? modalSearchToggle : inlineSearchToggle} className="log-search-toggle" aria-label={t(searchOpen ? 'closeSearch' : 'openSearch')} title={`${t('search')} (${mac ? '⌘F' : 'Ctrl+F'})`} aria-keyshortcuts={mac ? 'Meta+F' : 'Control+F'} aria-expanded={searchOpen} aria-controls={inModal ? 'expanded-log-search-row' : 'log-search-row'} onClick={() => searchOpen ? closeSearch(inModal) : openSearch()}><Search size={13} aria-hidden="true" /></button>
        <button disabled={!text} onClick={() => bottom(inModal)}><ArrowDownToLine size={13} aria-hidden="true" />{t('bottom')}</button>
        {!inModal && <button ref={expandButton} onClick={expand} aria-label={t('expand')} title={t('expand')}><Maximize2 size={13} aria-hidden="true" /></button>}
      </div></div>
      <div className="log-meta"><span title={t('limitDetails')}>{t('limits')}</span><span className="log-sensitive" role="img" aria-label={t('sensitive')} title={t('sensitive')}><Info size={13} aria-hidden="true" /></span>{logs && <span className="log-fetched-at">{t('fetchedAt')} <time dateTime={logs.fetchedAt}>{formatTime(logs.fetchedAt, language)}</time></span>}</div>
      <div id={inModal ? 'expanded-log-search-row' : 'log-search-row'} className="log-search" role="search" aria-label={t('searchArea')} hidden={!searchOpen}>
        <label htmlFor={searchId}>{t('search')}</label>
        <div className="log-search-field"><input ref={inModal ? modalSearch : inlineSearch} id={searchId} className="log-search-input" type="search" value={query} autoComplete="off" spellCheck={false} onChange={event => { setQuery(event.target.value); setMatchIndex(0); }} onKeyDown={event => {
          if (event.key === 'Enter') { event.preventDefault(); moveMatch(event.shiftKey ? -1 : 1); }
        }} />{query && <button className="log-search-clear" onClick={() => { (inModal ? modalSearch.current : inlineSearch.current)?.focus(); setQuery(''); setMatchIndex(0); }} aria-label={t('clearSearch')} title={t('clearSearch')}><X size={14} aria-hidden="true" /></button>}</div>
        <span className="log-search-count" aria-live="polite" aria-atomic="true">{matches.length ? t('matchCount', { current: activeIndex + 1, total: matches.length }) : t('zeroMatches')}</span>
        <button disabled={!matches.length} onClick={() => moveMatch(-1)} aria-label={t('previousMatch')} title={t('previousMatch')}><ChevronUp size={14} aria-hidden="true" /></button>
        <button disabled={!matches.length} onClick={() => moveMatch(1)} aria-label={t('nextMatch')} title={t('nextMatch')}><ChevronDown size={14} aria-hidden="true" /></button>
      </div>
      {logs?.truncated && <p className="truncation-notice" role="status">{t('truncated')}</p>}
      {logsError ? <div className="log-error" role="alert"><p>{t('failed')}</p><ErrorDetails error={logsError} /></div> : <pre ref={inModal ? modalContent : inlineContent} tabIndex={0} className={`log-content ${!logs?.text ? 'log-placeholder' : ''}`} aria-label={t('content')} aria-busy={loadingLogs} onScroll={event => { if (inModal || !expanded) scrollPosition.current = event.currentTarget.scrollTop; }}>{loadingLogs ? t('loading') : text ? !searchOpen || activeStart === undefined ? text : <>{text.slice(0, activeStart)}<mark ref={inModal ? modalMatch : inlineMatch} className="log-search-match">{text.slice(activeStart, activeStart + query.length)}</mark>{text.slice(activeStart + query.length)}</> : snapshot.stale ? t('stale') : !readableStates.has(container.state) ? t('unreadable') : logs ? t('empty') : t('initial')}</pre>}
    </section>;
  }
  return <>{content(false)}{expanded && createPortal(<div className="modal-backdrop"><div ref={dialog} className="logs-modal" role="dialog" aria-modal="true" aria-labelledby="logs-dialog-title" onKeyDown={keyDown}>
    <div className="logs-dialog-heading section-heading"><h2 id="logs-dialog-title">{t('expandedTitle', { name: container.name })}</h2><button ref={closeButton} className="icon-button" onClick={close} aria-label={t('close')}><X size={18} aria-hidden="true" /></button></div>
    {content(true)}
    {showCopyFeedback && copyFeedback && <p className="log-copy-feedback" role="status" aria-live="polite">{copyFeedback}</p>}
  </div></div>, document.body)}</>;
}
