import { Copy, ExternalLink, RefreshCw } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { Container } from './api';
import { State } from './components';
import { displayErrorMessage } from './frontendErrors';
import { useI18n } from './i18n';
import { mountKey, type ContainerMount, type MountInventory } from './mountApi';
import { storageMessages } from './messages/storage';
import { usePreferences } from './preferences';
import { formatDisplayTime, formatExactTime, parseTimestamp } from './time';
import type { MountInventoryState } from './useMountInventory';
import './storage.css';

export interface StoragePanelProps extends MountInventoryState {
  containers: Container[];
  target: { kind: 'container'; fullId: string } | { kind: 'project'; name: string };
  disabled?: boolean;
  highlightMountKey?: string | null;
  onNavigate: (fullId: string, mountKey: string) => void;
  copy: (text: string) => void | Promise<unknown>;
}
export interface MountUsage { container: Container; mount: ContainerMount; key: string; index: number }

export function storageUsages(inventory: MountInventory, containers: Container[]): MountUsage[] {
  const metadata = new Map(containers.map(container => [container.fullId, container]));
  return inventory.containers.flatMap(item => {
    const container = metadata.get(item.fullId);
    return container && item.mountsAvailable ? item.mounts.map((mount, index) => ({ container, mount, index, key: mountKey(mount, item.fullId, index) })) : [];
  });
}

export function StoragePanel({ inventory, error, loading, stale, reload, containers, target, disabled = false, highlightMountKey, onNavigate, copy }: StoragePanelProps) {
  const t = useI18n(storageMessages);
  const { language } = usePreferences();
  const highlighted = useRef<HTMLLIElement>(null);
  const focusedHighlight = useRef<string | null>(null);
  const targetKey = target.kind === 'container' ? target.fullId : target.name;
  const scope = containers.filter(container => target.kind === 'container' ? container.fullId === target.fullId : container.composeProject === target.name);
  const selectedIds = new Set(scope.map(container => container.fullId));
  const usages = inventory ? storageUsages(inventory, containers) : [];
  const usagesByKey = new Map<string, MountUsage[]>();
  for (const usage of usages) {
    const related = usagesByKey.get(usage.key);
    if (related) related.push(usage); else usagesByKey.set(usage.key, [usage]);
  }
  const scoped = usages.filter(usage => selectedIds.has(usage.container.fullId));
  const groups = new Map<string, MountUsage[]>();
  for (const usage of scoped) {
    const key = target.kind === 'project' ? usage.key : JSON.stringify([usage.key, usage.index]);
    const existing = groups.get(key);
    if (existing) existing.push(usage); else groups.set(key, [usage]);
  }
  const availableIds = new Set(inventory?.containers.filter(item => item.mountsAvailable).map(item => item.fullId));
  const unavailable = inventory ? scope.filter(container => !availableIds.has(container.fullId)) : [];
  const timestamp = parseTimestamp(inventory?.observedAt);
  useEffect(() => {
    const focusKey = JSON.stringify([targetKey, highlightMountKey]);
    if (!highlightMountKey) { focusedHighlight.current = null; return; }
    if (!highlighted.current || focusedHighlight.current === focusKey) return;
    focusedHighlight.current = focusKey;
    highlighted.current.scrollIntoView?.({ block: 'nearest' });
  }, [highlightMountKey, targetKey, inventory]);

  const path = (value: string | null) => <span className="storage-path"><code>{value || t('unavailable')}</code>{value && <button type="button" aria-label={t('copy', { value })} title={t('copy', { value })} onClick={() => { void copy(value); }}><Copy size={13} aria-hidden="true" /></button>}</span>;
  const access = (mount: ContainerMount) => <span className="storage-access" data-readonly={mount.readOnly === true}>{t(mount.readOnly === true ? 'readOnly' : mount.readOnly === false ? 'readWrite' : 'accessUnknown')}</span>;
  const usageRow = (usage: MountUsage, navigable: boolean) => <li key={JSON.stringify([usage.container.fullId, usage.index])} className="storage-usage">
    <div className="storage-usage-heading">
      <span><strong>{usage.container.name}</strong><State value={usage.container.state} /><span className="storage-hint">{usage.container.composeProject ?? t('standalone')}{usage.container.composeService ? ` / ${usage.container.composeService}` : ''} · {usage.container.shortId}</span></span>
      {navigable && <button type="button" aria-label={t('openContainer', { name: usage.container.name })} title={t('openContainer', { name: usage.container.name })} disabled={disabled || stale} onClick={() => onNavigate(usage.container.fullId, usage.key)}><ExternalLink size={13} aria-hidden="true" /></button>}
    </div>
    <div className="storage-destination"><span>{t('destination')}</span>{path(usage.mount.destination)}{access(usage.mount)}</div>
  </li>;

  return <section className="storage-panel" aria-label={t('storage')} aria-busy={loading}>
    <div className="storage-toolbar"><p>{inventory && <>{t('observed')} {timestamp ? <time dateTime={inventory.observedAt} title={formatExactTime(timestamp, language)}>{formatDisplayTime(timestamp, language)}</time> : t('unavailable')}</>}</p>
      <button type="button" disabled={disabled || loading} onClick={reload}><RefreshCw size={13} aria-hidden="true" />{t('reload')}</button></div>
    <p className="storage-hint">{t('engineHint')}</p>
    {loading && <p className="storage-notice" role="status">{t('loading')}</p>}
    {stale && <p className="storage-warning" role="status">{t('stale')}</p>}
    {error && <div className="storage-error" role="alert"><p>{t('failed')}</p><details><summary>{error.code}</summary><p>{error.code === 'InvalidMountResponse' ? t('invalid') : displayErrorMessage(error, language)}</p></details></div>}
    {inventory?.coverage === 'partial' && <p className="storage-warning" role="status">{t('partial')}</p>}
    {!scope.length ? <p className="storage-notice">{t(target.kind === 'project' ? 'notStarted' : 'containerMissing')}</p>
      : !inventory && !loading && !error ? <p className="storage-notice">{t('waiting')}</p> : null}
    {unavailable.map(container => <p key={container.fullId} className="storage-warning">{t('mountsUnavailable', { name: container.name })}</p>)}
    {!!scope.length && inventory && !scoped.length && !unavailable.length && <p className="storage-notice">{t('noMounts')}</p>}
    <ul className="storage-mounts">{[...groups.entries()].map(([key, members]) => {
      const first = members[0]!;
      const mount = first.mount;
      const related = usagesByKey.get(first.key)!;
      const sharedIdentity = (mount.type === 'volume' && !!mount.volumeName) || (mount.type === 'bind' && !!mount.source);
      const isHighlighted = first.key === highlightMountKey;
      return <li key={key} className="storage-mount" data-highlighted={isHighlighted} tabIndex={-1} ref={isHighlighted ? highlighted : undefined}>
        <div className="storage-mount-heading"><span className="storage-type">{mount.type || t('unavailable')}</span>{target.kind === 'container' && access(mount)}</div>
        <dl className="storage-facts"><div><dt>{t(mount.type === 'volume' ? 'volume' : 'source')}</dt><dd>{mount.type === 'tmpfs' ? t('memory') : path(mount.type === 'volume' ? mount.volumeName : mount.source)}</dd></div>
          {mount.type === 'volume' && mount.source && <div><dt>{t('enginePath')}</dt><dd>{path(mount.source)}</dd></div>}
          {target.kind === 'container' && <div><dt>{t('destination')}</dt><dd>{path(mount.destination)}</dd></div>}
        </dl>
        {target.kind === 'project' && <><p className="storage-hint">{t('projectUse')}</p><ul className="storage-usages">{members.map(usage => usageRow(usage, true))}</ul></>}
        {sharedIdentity ? <details className="storage-sharing"><summary>{t('related', { count: new Set(related.map(usage => usage.container.fullId)).size })}</summary><ul className="storage-usages">{related.map(usage => usageRow(usage, true))}</ul></details>
          : <p className="storage-hint">{t(mount.type === 'tmpfs' ? 'local' : 'sharingUnknown')}</p>}
      </li>;
    })}</ul>
  </section>;
}
