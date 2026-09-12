import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, Check, FileCode2, FolderOpen, LoaderCircle, Play, Settings, Square, Terminal, X } from 'lucide-react';
import { coreError, type Container, type CoreError, type ConnectionTarget } from './api';
import { composeApi, type ComposeAction, type ComposeOperation, type ComposePreparation, type ComposeProject, type ComposeProjectInput, type ComposeProjectPreview, type ComposeServicePreview } from './composeApi';
import { ErrorDetails } from './components';
import { useI18n } from './i18n';
import { composeMessages } from './messages/compose';

function ComposeModal({ title, children, onClose, closeDisabled = false }: { title: string; children: ReactNode; onClose: () => void; closeDisabled?: boolean }) {
  const t = useI18n(composeMessages);
  const id = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const trigger = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  useLayoutEffect(() => {
    const active = document.activeElement;
    if (!dialog.current?.contains(active) || (active instanceof HTMLElement && active.matches(':disabled'))) dialog.current?.querySelector<HTMLElement>('input:not(:disabled), button:not(:disabled)')?.focus();
  });
  useEffect(() => () => { if (trigger.current?.isConnected) trigger.current.focus(); }, []);
  return <div className="modal-backdrop"><div ref={dialog} className="compose-dialog" role="dialog" aria-modal="true" aria-labelledby={id} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!closeDisabled) onClose(); }
    if (event.key !== 'Tab') return;
    const controls = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), summary, [tabindex="0"]') ?? [])].filter(control => !control.closest('details:not([open])') || control.tagName === 'SUMMARY');
    const first = controls[0]; const last = controls.at(-1);
    if (event.shiftKey && (document.activeElement === first || !dialog.current?.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }}><div className="compose-dialog-heading"><h2 id={id}><FolderOpen size={20} aria-hidden="true" />{title}</h2><button className="icon-button" disabled={closeDisabled} aria-label={t('close')} onClick={onClose}><X size={18} aria-hidden="true" /></button></div>{children}</div></div>;
}
function ServicePreview({ services }: { services: ComposeServicePreview[] }) {
  const t = useI18n(composeMessages);
  return <div className="compose-service-preview"><h3>{t('services', { count: services.length })}</h3><ul>{services.map(service => <li key={service.name}><strong>{service.name}</strong><span>{service.image ?? (service.build ? t('build') : '—')}</span>{service.build && service.image && <small>{t('build')}</small>}{!!service.profiles.length && <small>{service.profiles.join(', ')}</small>}</li>)}</ul></div>;
}
export function ComposeEditorDialog({ project, initialName = '', sessionId, engine, onClose, onSaved, onRegistryChanged, onForget, onError }: {
  project: ComposeProject | null; initialName?: string; sessionId: string | null; engine: ConnectionTarget; onClose: () => void;
  onSaved: (project: ComposeProject) => void; onRegistryChanged: () => void; onForget?: () => void; onError: (error: CoreError, sessionId: string) => void;
}) {
  const t = useI18n(composeMessages);
  const [input, setInput] = useState<ComposeProjectInput>(() => project ? { id: project.id, expectedRevision: project.revision, name: project.name, composeFile: project.composeFile, workingDirectory: project.workingDirectory, envFile: project.envFile } : { name: initialName, composeFile: '', workingDirectory: '', envFile: null });
  const [preview, setPreview] = useState<ComposeProjectPreview | null>(null);
  const [error, setError] = useState<CoreError | null>(null);
  const [busy, setBusy] = useState<'preview' | 'save' | 'picker' | null>(null);
  const mounted = useRef(true);
  const request = useRef(0);
  const session = useRef(sessionId); session.current = sessionId;
  const busyRef = useRef(busy); busyRef.current = busy;
  const envOmitted = useRef(!!project && !project.envFile);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; ++request.current; }; }, []);
  useEffect(() => { ++request.current; setPreview(null); setBusy(null); busyRef.current = null; setError(null); }, [sessionId]);
  function change(update: Partial<ComposeProjectInput>) { if (Object.hasOwn(update, 'envFile')) envOmitted.current = !update.envFile; ++request.current; setPreview(null); setError(null); setInput(previous => ({ ...previous, ...update })); }
  async function pick(kind: 'file' | 'directory' | 'env') {
    if (busyRef.current) return;
    const attempt = ++request.current;
    busyRef.current = 'picker'; setBusy('picker');
    try {
      const value = await composeApi.pick(kind);
      if (!mounted.current || request.current !== attempt || !value) return;
      const update: Partial<ComposeProjectInput> = kind === 'file' ? { composeFile: value } : kind === 'directory' ? { workingDirectory: value } : { envFile: value };
      if (kind === 'file' && !input.workingDirectory) update.workingDirectory = value.slice(0, Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'))) || '/';
      if (kind === 'env') envOmitted.current = false;
      setPreview(null); setError(null); setInput(previous => ({ ...previous, ...update }));
    } catch (original) { if (mounted.current && attempt === request.current) setError(coreError(original)); }
    finally { if (mounted.current && attempt === request.current) { busyRef.current = null; setBusy(null); } }
  }
  async function review() {
    if (!sessionId || busyRef.current || !input.composeFile || !input.workingDirectory) return;
    const attempt = ++request.current;
    busyRef.current = 'preview'; setBusy('preview'); setError(null);
    try {
      const result = await composeApi.preview(sessionId, envOmitted.current ? { ...input, envFile: '' } : input);
      if (!mounted.current || request.current !== attempt || session.current !== sessionId) return;
      if (!result.previewId || !result.project.name || (!!input.name && result.project.name !== input.name) || (result.project.id ?? null) !== (input.id ?? null)) throw { code: 'MalformedOutput', message: t('invalidResponse') };
      setInput(result.project); setPreview(result);
    } catch (original) { if (mounted.current && request.current === attempt && session.current === sessionId) { const failure = coreError(original); setError(failure); onError(failure, sessionId); } }
    finally { if (mounted.current && request.current === attempt) { busyRef.current = null; setBusy(null); } }
  }
  async function save() {
    if (!preview || !sessionId || busyRef.current) return;
    const attempt = ++request.current;
    busyRef.current = 'save'; setBusy('save'); setError(null);
    try {
      const result = await composeApi.save(preview.previewId);
      // Registry writes are independent of the Engine session. A late success
      // must refresh saved metadata without reviving its old editor/selection.
      if (!mounted.current || request.current !== attempt || session.current !== sessionId) { onRegistryChanged(); return; }
      if (result.name !== preview.project.name || (project && result.id !== project.id)) throw { code: 'MalformedOutput', message: t('invalidResponse') };
      onSaved(result);
    } catch (original) { if (mounted.current && request.current === attempt) { const failure = coreError(original); setError(failure); onError(failure, sessionId); } }
    finally { if (mounted.current && request.current === attempt) { busyRef.current = null; setBusy(null); } }
  }
  return <ComposeModal title={t(project ? 'setup' : 'register')} onClose={onClose} closeDisabled={busy === 'save'}>
    <p className="compose-hint">{t('setupHint')}</p>
    <div className="compose-editor-engine"><span>{t('currentEngine')}</span><strong>{engine.contextName ?? '—'}</strong><code>{engine.endpoint ?? '—'}</code></div>
    <form onSubmit={event => { event.preventDefault(); if (preview) void save(); else void review(); }}>
      <label className="compose-field"><span>{t('name')}</span><input aria-label={t('name')} value={input.name} disabled={!!busy} spellCheck={false} onChange={event => change({ name: event.target.value })} /></label>
      {([{ field: 'composeFile', kind: 'file', label: 'file', choose: 'chooseFile' }, { field: 'workingDirectory', kind: 'directory', label: 'cwd', choose: 'chooseCwd' }, { field: 'envFile', kind: 'env', label: 'env', choose: 'chooseEnv' }] as const).map(item => <label key={item.field} className="compose-field"><span>{t(item.label)}</span><span className="compose-path-field"><FileCode2 size={15} aria-hidden="true" /><input aria-label={t(item.label)} value={input[item.field] ?? ''} required={item.field !== 'envFile'} disabled={!!busy} spellCheck={false} onChange={event => change({ [item.field]: event.target.value })} /><button type="button" disabled={!!busy} aria-label={t(item.choose)} onClick={() => void pick(item.kind)}><FolderOpen size={14} aria-hidden="true" />{t('browse')}</button>{item.field === 'envFile' && input.envFile && <button type="button" className="icon-button" disabled={!!busy} aria-label={t('removeEnv')} onClick={() => change({ envFile: '' })}><X size={14} aria-hidden="true" /></button>}</span></label>)}
      {!sessionId && <p className="compose-hint" role="status">{t('requiresConnect')}</p>}
      {preview && <section className="compose-reviewed" aria-label={t('validated')}><h3><Check size={16} aria-hidden="true" />{t('validated')} <small>{preview.composeVersion}</small></h3><p>{t(preview.provenance === 'matched' ? 'matched' : 'newProject')}</p><ServicePreview services={preview.services} /></section>}
      {error && <div className="inline-error" role="alert"><p>{error.message}</p><ErrorDetails error={error} /></div>}
      <div className="dialog-actions compose-dialog-actions">{onForget && <button type="button" className="compose-forget" disabled={!!busy} onClick={onForget}>{t('forget')}</button>}<button type="button" disabled={busy === 'save'} onClick={onClose}>{t('cancel')}</button><button className="primary-button" type="submit" disabled={!!busy || !sessionId || !input.composeFile || !input.workingDirectory}>{busy && <LoaderCircle size={14} className="spin" aria-hidden="true" />}{t(busy === 'preview' ? 'previewing' : busy === 'save' ? 'saving' : preview ? project ? 'saveChanges' : 'save' : 'preview')}</button></div>
    </form>
  </ComposeModal>;
}
export function ComposePrepareDialog({ project, action, preparation, engine, loading, starting, error, onClose, onRetry, onStart }: {
  project: ComposeProject; action: ComposeAction; preparation: ComposePreparation | null; engine: ConnectionTarget; loading: boolean; starting: boolean;
  error: CoreError | null; onClose: () => void; onRetry: () => void; onStart: () => void;
}) {
  const t = useI18n(composeMessages);
  return <ComposeModal title={t(action === 'up' ? 'prepareUp' : 'prepareStop')} onClose={onClose}>
    <h3 className="compose-project-name">{project.name}</h3>
    <dl className="compose-facts"><div><dt>{t('currentEngine')}</dt><dd><strong>{engine.contextName ?? '—'}</strong><code>{engine.endpoint ?? '—'}</code><small>{engine.engineId ?? '—'}</small></dd></div><div><dt>{t('file')}</dt><dd>{project.composeFile}</dd></div><div><dt>{t('cwd')}</dt><dd>{project.workingDirectory}</dd></div>{project.envFile && <div><dt>{t('env')}</dt><dd>{project.envFile}</dd></div>}</dl>
    {loading && <p className="compose-hint" role="status"><LoaderCircle size={15} className="spin" />{t('preparing')}</p>}
    {preparation && <><p className="compose-hint">{preparation.composeVersion} · {t('existing', { count: preparation.existingContainers })}</p><ServicePreview services={preparation.services} /><p className="compose-warning"><AlertTriangle size={16} aria-hidden="true" />{t(action === 'stop' ? 'stopHint' : 'recreate')}</p></>}
    {error && <div className="inline-error" role="alert"><p>{error.message}</p><ErrorDetails error={error} /></div>}
    <div className="dialog-actions"><button onClick={onClose}>{t('cancel')}</button>{error && <button disabled={loading || starting} onClick={onRetry}>{t('retry')}</button>}<button className={action === 'up' ? 'primary-button' : 'danger-button'} disabled={!preparation || loading || starting || !!error} onClick={onStart}>{starting ? <LoaderCircle className="spin" size={14} aria-hidden="true" /> : action === 'up' ? <Play size={14} aria-hidden="true" /> : <Square size={14} aria-hidden="true" />}{t(action === 'up' ? 'runConfirm' : 'stopConfirm')}</button></div>
  </ComposeModal>;
}
export function ComposeProgressDialog({ operation, recentOperations, onSelectOperation, text, truncated, readError, previousSession, services, containers, cancelling, refreshFailed, onClose, onCancel, onRetry }: {
  operation: ComposeOperation; recentOperations: ComposeOperation[]; onSelectOperation: (id: string) => void; text: string; truncated: boolean; readError: CoreError | null; previousSession: boolean; services: ComposeServicePreview[]; containers: Container[];
  cancelling: boolean; refreshFailed: boolean; onClose: () => void; onCancel: () => void; onRetry: () => void;
}) {
  const t = useI18n(composeMessages);
  const output = useRef<HTMLPreElement>(null);
  const follows = useRef(true);
  useLayoutEffect(() => { if (follows.current && output.current) output.current.scrollTop = output.current.scrollHeight; }, [text]);
  const observedServices = services.length ? services : [...new Set(containers.filter(item => item.composeProject === operation.projectName).map(item => item.composeService).filter((name): name is string => !!name))].map(name => ({ name, image: null, build: false, profiles: [] }));
  const state = operation.outcome ?? (operation.phase === 'reconciling' ? 'reconciling' : 'running');
  return <ComposeModal title={t('operation')} onClose={onClose}>
    {recentOperations.length > 1 && <nav className="compose-recent-list" aria-label={t('recentList')}>{recentOperations.map(item => <button key={item.id} aria-pressed={item.id === operation.id} onClick={() => onSelectOperation(item.id)}>{item.projectName} · {t(item.action === 'up' ? 'up' : 'stop')} · {t(item.outcome ?? 'running')}</button>)}</nav>}
    <div className="compose-operation-heading"><h3>{operation.projectName}</h3><span className={`compose-outcome compose-${state}`} role="status">{t(state)}</span></div>
    <p className="compose-hint">{t(operation.action === 'up' ? 'up' : 'stop')} · {t('closeHint')}</p>
    {previousSession && <p className="compose-warning" role="status">{t('previousSession')}</p>}
    {!previousSession && <section className="compose-service-preview"><h3>{t('observedServices')}</h3><ul>{observedServices.map(service => { const observed = containers.filter(item => item.composeProject === operation.projectName && item.composeService === service.name); return <li key={service.name}><strong>{service.name}</strong><span>{observed.length ? observed.map(item => `${item.name}: ${item.state}`).join(', ') : t('pendingService')}</span></li>; })}</ul></section>}
    <div className="compose-output-heading"><Terminal size={15} aria-hidden="true" /><h3>{t('output')}</h3></div><pre ref={output} tabIndex={0} className="compose-output" aria-label={t('output')} onScroll={() => { const node = output.current; if (node) follows.current = node.scrollHeight - node.clientHeight - node.scrollTop < 24; }}>{text || t('waitingOutput')}</pre>
    {truncated && <p className="compose-hint">{t('outputTrimmed')}</p>}
    {operation.error && <div className="inline-error" role="alert"><p>{operation.error.message}</p><ErrorDetails error={operation.error} /></div>}
    {readError && <div className="inline-error" role="alert"><p>{t('readFailed')}</p><ErrorDetails error={readError} />{!previousSession && <button onClick={onRetry}>{t('retry')}</button>}</div>}
    {refreshFailed && <p className="compose-warning" role="status">{t('refreshFailed')}</p>}
    {operation.cancelRequested && operation.phase !== 'finished' && <p className="compose-hint" role="status">{t('cancelRequested')}</p>}
    <div className="dialog-actions">{operation.phase !== 'finished' && !previousSession && <button className="danger-button" disabled={cancelling || operation.cancelRequested} onClick={onCancel}>{t('cancelOperation')}</button>}<button onClick={onClose}>{t('close')}</button></div>
  </ComposeModal>;
}
export function ComposeForgetDialog({ project, busy, error, onClose, onConfirm }: { project: ComposeProject; busy: boolean; error: CoreError | null; onClose: () => void; onConfirm: () => void }) {
  const t = useI18n(composeMessages);
  return <ComposeModal title={t('forgetTitle')} onClose={onClose} closeDisabled={busy}><h3 className="compose-project-name">{project.name}</h3><p className="compose-hint">{t('forgetHint')}</p>{error && <div className="inline-error" role="alert"><p>{error.message}</p><ErrorDetails error={error} /></div>}<div className="dialog-actions"><button disabled={busy} onClick={onClose}>{t('cancel')}</button><button disabled={busy} className="danger-button" onClick={onConfirm}>{t('forget')}</button></div></ComposeModal>;
}
export function ComposeProjectControls({ project, name, count, disabled, editDisabled, onPrepare, onEdit }: { project: ComposeProject | null; name: string; count: number; disabled: boolean; editDisabled: boolean; onPrepare: (action: ComposeAction) => void; onEdit: () => void }) {
  const t = useI18n(composeMessages);
  return <div className="compose-project-controls">{project ? <><div className="compose-project-path"><FileCode2 size={14} aria-hidden="true" /><span title={project.composeFile}>{project.composeFile}</span></div><div className="compose-project-actions"><button className="primary-button" disabled={disabled} onClick={() => onPrepare('up')}><Play size={13} aria-hidden="true" />{t('up')}</button><button disabled={disabled || count === 0} onClick={() => onPrepare('stop')}><Square size={13} aria-hidden="true" />{t('stop')}</button><button disabled={editDisabled} onClick={onEdit} aria-label={`${t('setup')} · ${name}`}><Settings size={14} aria-hidden="true" />{t('setup')}</button></div>{count === 0 && <p className="compose-hint"><strong>{t('empty')}</strong> · {t('emptyHint')}</p>}</> : <><p className="compose-hint">{t('discovered')}</p><button disabled={editDisabled} onClick={onEdit}><FolderOpen size={14} aria-hidden="true" />{t('link')}</button></>}</div>;
}
