import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { Copy, Download, LoaderCircle, X } from 'lucide-react';
import { ErrorDetails } from './components';
import { useI18n } from './i18n';
import { imageExportMessages } from './messages/imageExport';
import type { ImageExportSource } from './imageExportApi';
import type { useImageExports } from './useImageExports';
import type { CoreError } from './api';
import './imageExport.css';

type Exports = ReturnType<typeof useImageExports>;
function ExportError({ error, preparing = false }: { error: CoreError; preparing?: boolean }) {
  const t = useI18n(imageExportMessages);
  const key = error.code === 'ImageExportPreparationExpired' ? 'expiredError' : error.code === 'ImageExportDestinationExists' ? 'existsError'
    : error.code.startsWith('ImageExportDestination') ? 'destinationError' : error.code === 'ImageExportBusy' ? 'busyError'
      : error.code === 'StaleSession' || error.code === 'StaleHandle' || error.code.includes('Source') || error.code.includes('ImageMissing') ? 'sourceError' : preparing ? 'preparationError' : 'exportError';
  return <div role="alert"><p>{t(key)}</p><ErrorDetails error={error} /></div>;
}
function Source({ source }: { source: ImageExportSource }) {
  const t = useI18n(imageExportMessages);
  return <dl className="image-export-facts">{([
    ['container', source.containerName], ['containerId', source.containerId], ['image', source.imageReference], ['imageId', source.imageId],
    ['engine', source.engineName], ['engineId', source.engineId], ['endpoint', source.engineEndpoint],
  ] as const).map(([label, value]) => <div key={label}><dt>{t(label)}</dt><dd>{value}</dd></div>)}</dl>;
}
export function ImageExportDialog({ exports, sessionId, current, returnFocus, fallbackFocus }: {
  exports: Exports; sessionId: string | null; current: boolean; returnFocus: RefObject<HTMLElement | null>; fallbackFocus: RefObject<HTMLButtonElement | null>;
}) {
  const t = useI18n(imageExportMessages);
  const id = useId(), dialog = useRef<HTMLDivElement>(null);
  const [copyStatus, setCopyStatus] = useState<'copied' | 'copyFailed' | null>(null);
  const copyAttempt = useRef(0);
  const { modal, preview, destination, operation, unresolved, failedStart } = exports;
  const source = modal === 'review' ? preview : unresolved?.source ?? failedStart?.source ?? operation;
  const path = modal === 'review' ? destination?.path : unresolved?.path ?? failedStart?.path ?? operation?.path;
  const previous = !!source && source.sessionId !== sessionId;
  const running = !failedStart && !!operation && operation.phase !== 'finished';
  const reviewBlocked = !current || previous || exports.loading || exports.picking || exports.starting;
  useLayoutEffect(() => { if (!dialog.current?.contains(document.activeElement) || (document.activeElement instanceof HTMLElement && document.activeElement.matches(':disabled'))) dialog.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus(); });
  useEffect(() => () => {
    ++copyAttempt.current;
    const trigger = returnFocus.current;
    if (trigger?.isConnected && !trigger.matches(':disabled') && !trigger.closest('[inert]')) trigger.focus();
    else fallbackFocus.current?.focus();
  }, [returnFocus, fallbackFocus]);
  useEffect(() => { ++copyAttempt.current; setCopyStatus(null); }, [path]);
  async function copyPath() {
    if (!path) return;
    const attempt = ++copyAttempt.current;
    try { await navigator.clipboard.writeText(path); if (copyAttempt.current === attempt) setCopyStatus('copied'); }
    catch { if (copyAttempt.current === attempt) setCopyStatus('copyFailed'); }
  }
  return <div className="modal-backdrop"><div ref={dialog} className="image-export-dialog" role="dialog" aria-modal="true" aria-labelledby={id} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!exports.picking) exports.close(); }
    if (event.key !== 'Tab') return;
    const controls = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), summary, [tabindex="0"]') ?? [])].filter(control => !control.closest('details:not([open])') || control.tagName === 'SUMMARY');
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && (document.activeElement === first || !dialog.current?.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }}>
    <div className="image-export-heading"><h2 id={id}><Download size={20} aria-hidden="true" />{t(modal === 'review' ? 'review' : 'progress')}</h2><button className="icon-button" aria-label={t('close')} disabled={exports.picking} onClick={exports.close}><X size={18} aria-hidden="true" /></button></div>
    {modal === 'progress' && exports.recent.length > 1 && <nav className="image-export-recent" aria-label={t('recentList')}>{exports.recent.map(item => <button key={item.requestId} aria-pressed={!unresolved && !failedStart && operation?.requestId === item.requestId} onClick={() => exports.selectOperation(item)}>{item.containerName} · {t(item.outcome ?? (item.phase === 'finished' ? 'failed' : item.phase))}</button>)}</nav>}
    {exports.loading && <p role="status"><LoaderCircle className="spin" size={16} aria-hidden="true" /> {t('loading')}</p>}
    {previous && <p className="image-export-warning">{t('previous')}</p>}
    {modal === 'review' && !current && <p className="image-export-warning">{t('stale')}</p>}
    {source && <Source source={source} />}
    {modal === 'review' && <><p className="image-export-hint">{t('scope')}</p><p className="image-export-hint">{t('tags')}</p></>}
    <section className="image-export-destination"><h3>{t('path')}</h3>{path ? <p className="image-export-path">{path}</p> : <p>{t('noPath')}</p>}
      {modal === 'review' && <><p className="image-export-hint">{t('localPath')}</p><button disabled={!preview || reviewBlocked} onClick={() => void exports.pick()}>{t(exports.picking ? 'choosing' : 'choose')}</button></>}
      {modal === 'progress' && operation?.outcome === 'succeeded' && !unresolved && !failedStart && <button onClick={() => void copyPath()}><Copy size={13} aria-hidden="true" />{t('copyPath')}</button>}
      {copyStatus && <p role="status">{t(copyStatus)}</p>}
    </section>
    {modal === 'review' && exports.error && <ExportError error={exports.error} preparing />}
    {modal === 'progress' && unresolved && <div role="status"><strong>{t('unresolved')}</strong><p>{t('unresolvedHelp')}</p></div>}
    {modal === 'progress' && failedStart && <p role="status">{t('notStarted')}</p>}
    {modal === 'progress' && operation && !unresolved && !failedStart && <>
      <p className="image-export-state" role="status">{running && <LoaderCircle className="spin" size={16} aria-hidden="true" />}{t(operation.outcome ?? (operation.phase === 'finished' ? 'failed' : operation.phase))}</p>
      <dl className="image-export-metrics"><div><dt>{t('bytes')}</dt><dd>{t('bytesValue', { bytes: operation.bytesWritten.toLocaleString() })}</dd></div><div><dt>{t('elapsed')}</dt><dd>{t('elapsedValue', { seconds: (operation.elapsedMs / 1000).toFixed(1) })}</dd></div></dl>
      {running && <p className="image-export-hint">{t('noPercent')}</p>}
      {operation.error && <ExportError error={operation.error} />}
      {operation.cleanupWarning && <div className="image-export-warning" role="alert"><strong>{t('cleanup')}</strong><p>{operation.cleanupWarning}</p></div>}
      {(operation.stderr || operation.exitCode !== null) && <details className="technical-details"><summary>{t('details')}</summary>{operation.exitCode !== null && <p>{t('exitCode', { code: operation.exitCode })}</p>}{operation.stderr && <pre tabIndex={0} aria-label={t('stderr')}>{operation.stderr}</pre>}{operation.stderrTruncated && <p>{t('truncated')}</p>}</details>}
    </>}
    {modal === 'progress' && exports.readError && <div role="alert">{!failedStart && <p>{t('readFailed')}</p>}<ErrorDetails error={exports.readError} />{!failedStart && <button onClick={exports.retry}>{t('retry')}</button>}</div>}
    {modal === 'progress' && (running || unresolved) && <p className="image-export-hint">{t('continues')}</p>}
    <div className="dialog-actions"><button disabled={exports.picking} onClick={exports.close}>{t('close')}</button>
      {modal === 'review' && <button className="primary-button" disabled={!preview || !destination || reviewBlocked} onClick={() => void exports.start()}>{t(exports.starting ? 'starting' : 'start')}</button>}
      {modal === 'progress' && running && !unresolved && !previous && <button disabled={exports.cancelling || !current} onClick={() => void exports.cancel()}>{t(exports.cancelling ? 'cancelling' : 'cancel')}</button>}
    </div>
  </div></div>;
}
