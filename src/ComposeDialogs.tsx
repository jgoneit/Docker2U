import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { AlertTriangle, Check, FileCode2, FolderOpen, LoaderCircle, Play, Settings, Square, Terminal, RefreshCw, X } from 'lucide-react';
import { coreError, type Container, type CoreError, type ConnectionTarget } from './api';
import { composeApi, type ComposeAction, type ComposeApplyPreview, type ComposeApplySelection, type ComposeImagePreparation, type ComposeWarning, type ComposeOperation, type ComposePreparation, type ComposeProject, type ComposeProjectInput, type ComposeProjectPreview, type ComposeServicePreview } from './composeApi';
import { ErrorDetails, Health, State, formatTime } from './components';
import { useI18n } from './i18n';
import { composeMessages } from './messages/compose';
import { usePreferences } from './preferences';
import { SelectControl } from './SelectControl';
import './composeProgress.css';

function ComposeModal({ title, children, onClose, closeDisabled = false, restoreFocus }: { title: string; children: ReactNode; onClose: () => void; closeDisabled?: boolean; restoreFocus?: RefObject<boolean> }) {
  const t = useI18n(composeMessages);
  const id = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const trigger = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  useLayoutEffect(() => {
    const active = document.activeElement;
    if (!dialog.current?.contains(active) || (active instanceof HTMLElement && active.matches(':disabled'))) dialog.current?.querySelector<HTMLElement>('input:not(:disabled), select:not(:disabled), button:not(:disabled)')?.focus();
  });
  useEffect(() => () => { if (restoreFocus?.current !== false && trigger.current?.isConnected) trigger.current.focus(); }, [restoreFocus]);
  return <div className="modal-backdrop"><div ref={dialog} className="compose-dialog" role="dialog" aria-modal="true" aria-labelledby={id} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!closeDisabled) onClose(); }
    if (event.key !== 'Tab') return;
    const controls = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), summary, [tabindex="0"]') ?? [])].filter(control => !control.closest('details:not([open])') || control.tagName === 'SUMMARY');
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
const preparationLabel = { pull: 'preparationPull', build: 'preparationBuild', none: 'preparationNone' } as const;
function ApplyWarnings({ warnings, selections = [] }: { warnings: ComposeWarning[]; selections?: ComposeApplySelection[] }) {
  const t = useI18n(composeMessages);
  const localConsumers = new Set(selections.filter(selection => selection.preparation === 'none').map(selection => selection.service));
  const imagePreparations = new Set(selections.filter(selection => selection.preparation !== 'none').map(selection => selection.service));
  const sharesPreparation = warnings.some(warning => warning.code === 'sharedImage' && warning.services.some(service => localConsumers.has(service)) && warning.services.some(service => imagePreparations.has(service)));
  return <>{warnings.map((warning, index) => <p key={index} className="compose-warning">{t(warning.code === 'sharedImage' ? 'sharedImage' : 'applyWarning', { image: warning.image, services: warning.services.join(', ') })}</p>)}{sharesPreparation && <p className="compose-warning">{t('sharedPreparation')}</p>}</>;
}
export function ComposeApplyDialog({ project, preview, loading, error, onClose, onRetry, onReview }: {
  project: ComposeProject; preview: ComposeApplyPreview | null; loading: boolean; error: CoreError | null;
  onClose: () => void; onRetry: () => void; onReview: (selections: ComposeApplySelection[]) => void;
}) {
  const t = useI18n(composeMessages);
  const [choices, setChoices] = useState<Record<string, ComposeImagePreparation | ''>>({});
  const services = preview?.services ?? [];
  const selected = services.filter(service => Object.hasOwn(choices, service.name));
  const ready = selected.length > 0 && selected.every(service => !service.blockedReason && service.preparations.includes(choices[service.name] as ComposeImagePreparation));
  useEffect(() => { setChoices({}); }, [preview]);
  return <ComposeModal title={t('selectApply')} onClose={onClose}>
    <h3 className="compose-project-name">{project.name}</h3><p className="compose-hint">{t('applySelectHint')}</p>
    {loading && <p className="compose-hint" role="status"><LoaderCircle size={15} className="spin" />{t('preparing')}</p>}
    {preview && <ul className="compose-apply-services">{services.map(service => {
      const chosen = Object.hasOwn(choices, service.name);
      const blocked = !!service.blockedReason || !service.preparations.length;
      return <li key={service.name}>
        <label className="compose-apply-check"><input type="checkbox" checked={chosen} disabled={blocked} aria-label={t('selectService', { name: service.name })} onChange={event => setChoices(previous => {
          if (event.target.checked) return { ...previous, [service.name]: '' };
          const next = { ...previous }; delete next[service.name]; return next;
        })} /><strong>{service.name}</strong></label>
        <span className="compose-apply-image">{service.image ?? '—'}</span>
        {!!service.profiles.length && <small className="compose-apply-image">{t('profileNames', { profiles: service.profiles.join(', ') })}</small>}
        <label className="compose-field"><span>{t('preparationFor', { name: service.name })}</span><SelectControl value={choices[service.name] ?? ''} disabled={!chosen || blocked} onChange={event => setChoices(previous => ({ ...previous, [service.name]: event.target.value as ComposeImagePreparation }))}>
          <option value="" disabled>{t('choosePreparation')}</option>{(['pull', 'build', 'none'] as const).map(mode => <option key={mode} value={mode} disabled={!service.preparations.includes(mode)}>{t(preparationLabel[mode])}</option>)}
        </SelectControl></label>
        {blocked && <p className="compose-hint">{t(service.blockedReason === 'imageMountUnsupported' ? 'blockedImageMount' : service.blockedReason === 'providerUnsupported' ? 'blockedProvider' : 'blockedService')}</p>}
      </li>;
    })}</ul>}
    <p className="compose-warning">{t('applyScope')}</p>
    {error && <div className="inline-error" role="alert"><p>{error.message}</p><ErrorDetails error={error} /></div>}
    <div className="dialog-actions"><button onClick={onClose}>{t('cancel')}</button>{error && <button disabled={loading} onClick={onRetry}>{t('retry')}</button>}<button className="primary-button" disabled={!ready || loading || !!error} onClick={() => onReview(selected.map(service => ({ service: service.name, preparation: choices[service.name] as ComposeImagePreparation })))}>{t('reviewApply')}</button></div>
  </ComposeModal>;
}
export function ComposePrepareDialog({ project, action, preparation, engine, loading, starting, error, onClose, onRetry, onStart, containers = [], inventoryFresh = false }: {
  containers?: Container[]; inventoryFresh?: boolean;
  project: ComposeProject; action: ComposeAction; preparation: ComposePreparation | null; engine: ConnectionTarget; loading: boolean; starting: boolean;
  error: CoreError | null; onClose: () => void; onRetry: () => void; onStart: () => void;
}) {
  const t = useI18n(composeMessages);
  return <ComposeModal title={t(action === 'apply' ? 'prepareApply' : action === 'up' ? 'prepareUp' : 'prepareStop')} onClose={onClose}>
    <h3 className="compose-project-name">{project.name}</h3>
    <dl className="compose-facts"><div><dt>{t('currentEngine')}</dt><dd><strong>{engine.contextName ?? '—'}</strong><code>{engine.endpoint ?? '—'}</code><small>{engine.engineId ?? '—'}</small></dd></div><div><dt>{t('file')}</dt><dd>{project.composeFile}</dd></div><div><dt>{t('cwd')}</dt><dd>{project.workingDirectory}</dd></div>{project.envFile && <div><dt>{t('env')}</dt><dd>{project.envFile}</dd></div>}</dl>
    {loading && <p className="compose-hint" role="status"><LoaderCircle size={15} className="spin" />{t('preparing')}</p>}
    {preparation && <><p className="compose-hint">{preparation.composeVersion} · {t('existing', { count: preparation.existingContainers })}</p>{action === 'apply' ? <><ul className="compose-apply-review">{preparation.selections?.map(selection => {
      const replicas = containers.filter(container => container.composeProject === project.name && container.composeService === selection.service);
      const profiles = preparation.services.find(service => service.name === selection.service)?.profiles ?? [];
      return <li key={selection.service}><strong>{selection.service}</strong><span>{t(preparationLabel[selection.preparation])}</span>{!!profiles.length && <small>{t('profileNames', { profiles: profiles.join(', ') })}</small>}<small>{!inventoryFresh ? t('inventoryUnavailable') : replicas.length ? t('replicas', { count: replicas.length }) : t('noReplica')}</small>{inventoryFresh && replicas.map(container => <code key={container.fullId} title={container.fullId}>{container.name} · {container.shortId}</code>)}</li>;
    })}</ul><ApplyWarnings warnings={preparation.warnings ?? []} selections={preparation.selections} /><p className="compose-warning">{t('applyScope')}</p><p className="compose-hint">{t('applyCodeHint')}</p><p className="compose-hint">{t('applyPartial')}</p></> : <><ServicePreview services={preparation.services} /><p className="compose-warning"><AlertTriangle size={16} aria-hidden="true" />{t(action === 'stop' ? 'stopHint' : 'recreate')}</p></>}</>}
    {error && <div className="inline-error" role="alert"><p>{error.message}</p><ErrorDetails error={error} /></div>}
    <div className="dialog-actions"><button onClick={onClose}>{t('cancel')}</button>{error && <button disabled={loading || starting} onClick={onRetry}>{t('retry')}</button>}<button className={action === 'stop' ? 'danger-button' : 'primary-button'} disabled={!preparation || loading || starting || !!error} onClick={onStart}>{starting ? <LoaderCircle className="spin" size={14} aria-hidden="true" /> : action === 'apply' ? <RefreshCw size={14} aria-hidden="true" /> : action === 'up' ? <Play size={14} aria-hidden="true" /> : <Square size={14} aria-hidden="true" />}{t(action === 'apply' ? 'applyConfirm' : action === 'up' ? 'runConfirm' : 'stopConfirm')}</button></div>
  </ComposeModal>;
}
export function ComposeProgressDialog({ operation, recentOperations, onSelectOperation, text, truncated, readError, previousSession, services, containers, observedAt, stale, cancelling, refreshFailed, onClose, onCancel, onRetry, onInspect }: {
  operation: ComposeOperation; recentOperations: ComposeOperation[]; onSelectOperation: (id: string) => void; text: string; truncated: boolean; readError: CoreError | null; previousSession: boolean; services: ComposeServicePreview[]; containers: Container[];
  observedAt: string | null; stale: boolean; cancelling: boolean; refreshFailed: boolean; onClose: () => void; onCancel: () => void; onRetry: () => void; onInspect: (fullId: string, tab: 'logs' | 'diagnostics') => void;
}) {
  const t = useI18n(composeMessages);
  const { language } = usePreferences();
  const output = useRef<HTMLPreElement>(null);
  const follows = useRef(true);
  const restoreFocus = useRef(true);
  useLayoutEffect(() => { if (follows.current && output.current) output.current.scrollTop = output.current.scrollHeight; }, [text]);
  const selectedNames = operation.action === 'apply' ? new Set(operation.selections?.map(item => item.service) ?? []) : null;
  const projectContainers = containers.filter(item => item.composeProject === operation.projectName && (!selectedNames || (item.composeService && selectedNames.has(item.composeService))));
  const observedServices = [...new Set([...(selectedNames ? [...selectedNames] : services.map(service => service.name)), ...projectContainers.map(item => item.composeService).filter((name): name is string => !!name)])];
  const hasObservation = !!observedAt && Number.isFinite(Date.parse(observedAt));
  const canInspect = !previousSession && !stale && hasObservation;
  const state = operation.outcome ?? (operation.phase === 'reconciling' ? 'reconciling' : 'running');
  function close() { restoreFocus.current = true; onClose(); }
  function inspect(fullId: string, tab: 'logs' | 'diagnostics') {
    if (!canInspect || !projectContainers.some(container => container.fullId === fullId)) return;
    // The destination owns focus when navigation closes this view.
    restoreFocus.current = false;
    onInspect(fullId, tab);
  }
  function health(container: Container) {
    if (container.healthConfigured === false) return <span className="health health-none">{t('healthUnconfigured')}</span>;
    if (container.healthConfigured !== true) return <span className="health health-unknown">{t('healthConfigurationUnknown')}</span>;
    if (!container.health || container.health === 'none') return <span className="health health-unknown">{t('healthNoResult')}</span>;
    return <Health value={container.health} />;
  }
  return <ComposeModal title={t('operation')} onClose={close} restoreFocus={restoreFocus}>
    {recentOperations.length > 1 && <nav className="compose-recent-list" aria-label={t('recentList')}>{recentOperations.map(item => <button key={item.id} aria-pressed={item.id === operation.id} onClick={() => onSelectOperation(item.id)}>{item.projectName} · {t(item.action)} · {t(item.outcome ?? 'running')}</button>)}</nav>}
    <div className="compose-operation-heading"><h3>{operation.projectName}</h3><span className={'compose-outcome compose-' + state} role="status">{t(state)}</span></div>
    <p className="compose-hint">{t(operation.action)} · {t('closeHint')}</p>
    {!previousSession && <p className="compose-hint">{t('commandResultHint')}</p>}
    {operation.action === 'apply' && <><section className="compose-stage-results" aria-label={t('stages')}><h3>{t('stages')}</h3><ol>{operation.stages?.map((stage, index) => <li key={index} data-stage-kind={stage.kind}>
      <div><strong>{t(stage.kind === 'pull' ? 'stagePull' : stage.kind === 'build' ? 'stageBuild' : 'stageRecreate')}</strong><span className={'compose-outcome compose-' + stage.status}>{t(stage.status)}</span></div>
      {!!stage.services.length && <p>{stage.services.join(', ')}</p>}{stage.exitCode !== null && <small>{t('stageExit', { code: stage.exitCode })}</small>}{stage.error && <p className="compose-warning">{stage.error.message}</p>}
    </li>)}<li aria-label={t('stateRefresh')}><div><strong>{t('stateRefresh')}</strong><span className={'compose-outcome compose-' + operation.reconciliation}>{t(operation.reconciliation === 'succeeded' ? 'stateRefreshSucceeded' : operation.reconciliation === 'failed' ? 'stateRefreshFailed' : operation.reconciliation === 'skipped' ? 'skipped' : operation.phase === 'reconciling' ? 'reconciling' : 'pending')}</span></div></li></ol></section><ApplyWarnings warnings={operation.warnings ?? []} selections={operation.selections} /><p className="compose-hint">{t('applyPartial')}</p></>}
    {previousSession && <p className="compose-warning" role="status">{t('previousSession')}</p>}
    {!previousSession && <section className="compose-service-observations" aria-label={t('observedServices')}>
      <div className="compose-observation-heading"><h3>{t('observedServices')}</h3>{hasObservation && <p>{t('observedAt')} <time dateTime={observedAt!} title={observedAt!}>{formatTime(observedAt!, language)}</time></p>}</div>
      {!hasObservation ? <p className="compose-warning" role="status">{t('inventoryUnavailable')}</p> : stale && <p className="compose-warning" role="status">{t('inventoryStale')}</p>}
      {!observedServices.length && <p className="compose-hint">{t('noObservedServices')}</p>}
      <ul className="compose-observed-services">{observedServices.map(service => {
        const observed = projectContainers.filter(container => container.composeService === service);
        return <li className="compose-observed-service" key={service}><h4>{service}</h4>{!observed.length ? <p className="compose-hint">{t('pendingService')}</p> : <ul className="compose-observed-containers">{observed.map(container => <li key={container.fullId} data-container-id={container.fullId} aria-label={t('containerStatus', { name: container.name })}>
          <div className="compose-container-observation"><strong title={container.fullId}>{container.name}</strong><div className="compose-container-status"><State value={container.state} />{health(container)}</div></div>
          <div className="compose-container-links"><button type="button" disabled={!canInspect} aria-label={t('inspectLogsFor', { name: container.name })} onClick={() => inspect(container.fullId, 'logs')}>{t('inspectLogs')}</button><button type="button" disabled={!canInspect} aria-label={t('inspectDiagnosticsFor', { name: container.name })} onClick={() => inspect(container.fullId, 'diagnostics')}>{t('inspectDiagnostics')}</button></div>
        </li>)}</ul>}</li>;
      })}</ul>
    </section>}
    <div className="compose-output-heading"><Terminal size={15} aria-hidden="true" /><h3>{t('output')}</h3></div><pre ref={output} tabIndex={0} className="compose-output" aria-label={t('output')} onScroll={() => { const node = output.current; if (node) follows.current = node.scrollHeight - node.clientHeight - node.scrollTop < 24; }}>{text || t('waitingOutput')}</pre>
    {truncated && <p className="compose-hint">{t('outputTrimmed')}</p>}
    {operation.error && <div className="inline-error" role="alert"><p>{operation.error.message}</p><ErrorDetails error={operation.error} /></div>}
    {readError && <div className="inline-error" role="alert"><p>{t('readFailed')}</p><ErrorDetails error={readError} />{!previousSession && <button onClick={onRetry}>{t('retry')}</button>}</div>}
    {refreshFailed && <p className="compose-warning" role="status">{t('refreshFailed')}</p>}
    {operation.cancelRequested && operation.phase !== 'finished' && <p className="compose-hint" role="status">{t('cancelRequested')}</p>}
    <div className="dialog-actions">{operation.phase !== 'finished' && !previousSession && <button className="danger-button" disabled={cancelling || operation.cancelRequested} onClick={onCancel}>{t('cancelOperation')}</button>}<button onClick={close}>{t('close')}</button></div>
  </ComposeModal>;
}
export function ComposeForgetDialog({ project, busy, error, onClose, onConfirm }: { project: ComposeProject; busy: boolean; error: CoreError | null; onClose: () => void; onConfirm: () => void }) {
  const t = useI18n(composeMessages);
  return <ComposeModal title={t('forgetTitle')} onClose={onClose} closeDisabled={busy}><h3 className="compose-project-name">{project.name}</h3><p className="compose-hint">{t('forgetHint')}</p>{error && <div className="inline-error" role="alert"><p>{error.message}</p><ErrorDetails error={error} /></div>}<div className="dialog-actions"><button disabled={busy} onClick={onClose}>{t('cancel')}</button><button disabled={busy} className="danger-button" onClick={onConfirm}>{t('forget')}</button></div></ComposeModal>;
}
export function ComposeProjectControls({ project, name, count, disabled, editDisabled, onPrepare, onEdit }: { project: ComposeProject | null; name: string; count: number; disabled: boolean; editDisabled: boolean; onPrepare: (action: ComposeAction) => void; onEdit: () => void }) {
  const t = useI18n(composeMessages);
  return <div className="compose-project-controls">{project ? <><div className="compose-project-path"><FileCode2 size={14} aria-hidden="true" /><span title={project.composeFile}>{project.composeFile}</span></div><div className="compose-project-actions"><button className="primary-button" disabled={disabled} onClick={() => onPrepare('up')}><Play size={13} aria-hidden="true" />{t('up')}</button><button disabled={disabled} onClick={() => onPrepare('apply')}><RefreshCw size={13} aria-hidden="true" />{t('apply')}</button><button disabled={disabled || count === 0} onClick={() => onPrepare('stop')}><Square size={13} aria-hidden="true" />{t('stop')}</button><button disabled={editDisabled} onClick={onEdit} aria-label={`${t('setup')} · ${name}`}><Settings size={14} aria-hidden="true" />{t('setup')}</button></div>{count === 0 && <p className="compose-hint"><strong>{t('empty')}</strong> · {t('emptyHint')}</p>}</> : <><p className="compose-hint">{t('discovered')}</p><button disabled={editDisabled} onClick={onEdit}><FolderOpen size={14} aria-hidden="true" />{t('link')}</button></>}</div>;
}
