import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ClipboardPaste, Copy, Plug, Unplug, X } from 'lucide-react';
import type { Container, ContainerList, CoreError } from './api';
import { ErrorDetails } from './components';
import { useI18n } from './i18n';
import { terminalMessages } from './messages/terminal';
import { TerminalRegistry, TERMINAL_LIMIT } from './terminalRegistry';
import type { TerminalShell } from './terminalApi';
import '@xterm/xterm/css/xterm.css';
import './terminal.css';

export function useTerminalRegistry(sessionId: string | null, onError?: (original: unknown, failure: CoreError, sessionId: string) => unknown) {
  const [registry] = useState(() => new TerminalRegistry());
  useEffect(() => { registry.onError = (error, session) => { onError?.(error, error, session); }; }, [registry, onError]);
  useEffect(() => { registry.setSession(sessionId); return () => registry.setSession(null); }, [registry, sessionId]);
  return registry;
}
export function ContainerTerminal({ registry, container, snapshot, enabled }: {
  registry: TerminalRegistry; container: Container | null; snapshot: ContainerList; enabled: boolean;
}) {
  const t = useI18n(terminalMessages);
  const entries = useSyncExternalStore(registry.subscribe, registry.getSnapshot);
  const [shell, setShell] = useState<TerminalShell>('sh');
  const [retainedId, setRetainedId] = useState<string | null>(null);
  const [clipboard, setClipboard] = useState<'copied' | 'noSelection' | 'clipboardError' | null>(null);
  const screen = useRef<HTMLDivElement>(null);
  const selectedId = container?.fullId ?? entries[0]?.containerId ?? '';
  const viewedId = retainedId && entries.some(entry => entry.containerId === retainedId) ? retainedId : selectedId;
  const entry = entries.find(item => item.containerId === viewedId);
  const viewingRetained = !!container && viewedId !== container.fullId;
  const running = entry?.status === 'running';
  useEffect(() => { setRetainedId(null); setShell('sh'); setClipboard(null); }, [container?.fullId]);
  useLayoutEffect(() => {
    const host = screen.current; if (!host || !entry) return;
    registry.attach(viewedId, host);
    const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(() => registry.fit(viewedId)) : null;
    resize?.observe(host);
    const theme = new MutationObserver(() => registry.theme(viewedId));
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => { resize?.disconnect(); theme.disconnect(); registry.detach(viewedId, host); };
  }, [registry, viewedId, !!entry]);
  useEffect(() => { if (running) registry.fit(viewedId); }, [registry, viewedId, running]);
  async function copy() {
    const text = registry.selection(viewedId);
    if (!text) { setClipboard('noSelection'); return; }
    try { await navigator.clipboard.writeText(text); setClipboard('copied'); } catch { setClipboard('clipboardError'); }
  }
  async function paste() {
    try { const text = await navigator.clipboard.readText(); registry.paste(viewedId, text); registry.focus(viewedId); setClipboard(null); }
    catch { setClipboard('clipboardError'); }
  }
  async function connect() {
    if (!container) return;
    await registry.connect(snapshot.sessionId, snapshot.generation, container, shell);
    if (screen.current?.dataset.containerId === container.fullId) registry.focus(container.fullId);
  }
  if (!container && !entry) return null;
  return <section className="container-terminal" aria-label={t('title')}>
    <header className="terminal-heading"><strong>{entry?.containerName ?? container?.name ?? ''}</strong><code title={viewedId}>{viewedId}</code>{viewingRetained && <button type="button" onClick={() => setRetainedId(null)}>{t('current')}</button>}</header>
    <div className="terminal-toolbar"><span className="terminal-status" role="status" data-status={entry?.status ?? 'ready'}>{t(entry?.status ?? 'ready')}{entry?.exitCode !== null && entry?.exitCode !== undefined && <> · {t('exitCode', { code: entry.exitCode })}</>}</span>
      {!entry && container ? <><label>{t('shell')}<select aria-label={t('shell')} value={shell} onChange={event => setShell(event.target.value as TerminalShell)}><option value="sh">/bin/sh</option><option value="bash">/bin/bash</option></select></label><button type="button" className="primary-button terminal-connect" disabled={!enabled || snapshot.stale || container.state !== 'running' || entries.length >= TERMINAL_LIMIT} onClick={() => void connect()}><Plug size={14} aria-hidden="true" />{t('connect')}</button></>
      : entry ? <><code className="terminal-shell">/bin/{entry.shell}</code><button type="button" disabled={!running || entry.pending} onClick={() => void registry.disconnect(viewedId)}><Unplug size={14} aria-hidden="true" />{t('disconnect')}</button><button type="button" className="terminal-close" disabled={entry.pending} onClick={() => void registry.close(viewedId)}><X size={14} aria-hidden="true" />{t('close')}</button><button type="button" onClick={() => void copy()}><Copy size={14} aria-hidden="true" />{t('copy')}</button><button type="button" disabled={!running} onClick={() => void paste()}><ClipboardPaste size={14} aria-hidden="true" />{t('paste')}</button></> : null}
    </div>
    {!entry && container && <p className="terminal-hint">{t(!enabled || snapshot.stale ? 'disabled' : container.state !== 'running' ? 'stopped' : entries.length >= TERMINAL_LIMIT ? 'limit' : 'connectHint')}</p>}
    {entry && <p className="terminal-hint">{t(running || entry.status === 'connecting' ? 'disconnectHint' : 'ended')}</p>}
    {entry?.error && <div role="alert"><ErrorDetails error={entry.error} /></div>}
    {clipboard && <p className="terminal-hint" role="status">{t(clipboard)}</p>}
    <div className="terminal-screen" data-container-id={viewedId} hidden={!entry} ref={screen} aria-label={`${t('title')} · ${entry?.containerName ?? container?.name ?? ''}`} />
    {!!entries.length && <details className="terminal-retained"><summary>{t('retained', { count: entries.length })}</summary><ul>{entries.map(item => <li key={item.containerId}><span><strong>{item.containerName}</strong><code>{item.containerId.slice(0, 12)}</code><span>{t(item.status)}</span></span><button type="button" aria-label={`${t('view')} ${item.containerName}`} onClick={() => setRetainedId(item.containerId)}>{t('view')}</button><button type="button" aria-label={`${t('close')} ${item.containerName}`} disabled={item.pending} onClick={() => void registry.close(item.containerId)}>{t('close')}</button></li>)}</ul></details>}
  </section>;
}
