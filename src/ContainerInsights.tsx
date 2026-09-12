import { Copy, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import type { ContainerDetails, ContainerPort } from './containerDetailsTypes';
import type { ContainerDetailsState } from './useContainerDetails';
import { displayErrorMessage } from './frontendErrors';
import { translate, useI18n } from './i18n';
import { componentMessages } from './messages/components';
import { containerInsightsMessages } from './messages/containerInsights';
import { usePreferences } from './preferences';
import { formatDisplayTime, formatExactTime, parseTimestamp } from './time';
import './containerInsights.css';

export interface ContainerInsightsProps extends ContainerDetailsState {
  tab: 'diagnostics' | 'connectivity';
  disabled?: boolean;
  copy: (text: string, label: 'address' | 'healthOutput') => void | Promise<unknown>;
}
type CopyInsight = ContainerInsightsProps['copy'];

function ObservationTime({ value }: { value: string | null }) {
  const { language } = usePreferences();
  const t = useI18n(containerInsightsMessages);
  const time = parseTimestamp(value ?? undefined);
  return time ? <time dateTime={value!} title={formatExactTime(time, language)}>{formatDisplayTime(time, language)}</time> : <span>{t('unavailable')}</span>;
}

export function ContainerInsights({ tab, details, loading, error, stale, reload, disabled = false, copy }: ContainerInsightsProps) {
  const t = useI18n(containerInsightsMessages);
  const { language } = usePreferences();
  return <section className="container-insights" aria-label={t(tab)} aria-busy={loading}>
    <div className="insights-toolbar">
      <p>{details && <>{t('observed')} <ObservationTime value={details.observedAt} /></>}</p>
      <button type="button" disabled={disabled || loading} onClick={reload}><RefreshCw size={13} aria-hidden="true" />{t('reload')}</button>
    </div>
    {loading && <p className="insights-notice" role="status">{t('loading')}</p>}
    {stale && <p className="insights-warning" role="status">{t('stale')}</p>}
    {error && <div className="insights-error" role="alert"><p>{t('failed')}</p><details><summary>{error.code}</summary><p>{error.code === 'InvalidDetailsResponse' ? t('invalid') : displayErrorMessage(error, language)}</p></details></div>}
    {!details && !loading && !error && <p className="insights-notice">{t('empty')}</p>}
    {details && (tab === 'diagnostics' ? <ContainerDiagnostics details={details} copy={copy} /> : <ContainerConnectivity details={details} copy={copy} />)}
  </section>;
}

export function ContainerDiagnostics({ details, copy }: { details: ContainerDetails; copy: CopyInsight }) {
  const t = useI18n(containerInsightsMessages);
  const { language } = usePreferences();
  const data = details.diagnostics;
  const stateKey = (['created', 'running', 'paused', 'restarting', 'removing', 'exited', 'dead'] as const).find(value => value === data.state) ?? 'unknown';
  const stateText = translate(componentMessages, language, stateKey);
  const terminated = data.state === 'exited' || data.state === 'dead';
  const healthKey = data.health?.status === 'healthy' ? 'healthy' : data.health?.status === 'unhealthy' ? 'unhealthy' : data.health?.status === 'starting' ? 'healthStarting' : 'healthUnknown';
  const summary = data.oomKilled === true ? t('summaryOom', { state: stateText })
    : data.healthAvailable && data.health?.status === 'unhealthy' ? t('summaryHealth', { state: stateText })
    : terminated && data.exitCode !== null ? t('summaryExit', { state: stateText, code: data.exitCode })
    : t('summaryState', { state: stateText });
  return <div className="insights-body">
    <p className="insights-summary">{summary}</p>
    <dl className="insights-facts">
      <div><dt>{t('state')}</dt><dd>{translate(componentMessages, language, stateKey)}</dd></div>
      {terminated && <div><dt>{t('exitCode')}</dt><dd>{data.exitCode ?? t('unavailable')}</dd></div>}
      <div><dt>{t('started')}</dt><dd><ObservationTime value={data.startedAt} /></dd></div>
      {terminated && <div><dt>{t('finished')}</dt><dd><ObservationTime value={data.finishedAt} /></dd></div>}
      <div><dt>{t('restarts')}</dt><dd>{data.restartCount ?? t('unavailable')}</dd></div>
      {data.oomKilled === true && <div><dt>{t('oom')}</dt><dd className="insights-warning-text">{t('oomTrue')}</dd></div>}
    </dl>
    {terminated && data.exitCode === 137 && data.oomKilled !== true && <p className="insights-hint">{t('exit137')}</p>}
    <section className="insights-section" aria-label={t('health')}><h3>{t('health')}</h3>
      {!data.healthAvailable ? <p className="insights-hint">{t('healthUnavailable')}</p>
        : data.healthConfigured === false ? <p className="insights-hint">{t('healthNotConfigured')}</p>
        : !data.health ? <p className="insights-hint">{t(data.healthConfigured === true ? 'healthNoResults' : 'noHealth')}</p> : <>
        <dl className="insights-facts"><div><dt>{t('healthStatus')}</dt><dd>{translate(componentMessages, language, healthKey)}</dd></div><div><dt>{t('failingStreak')}</dt><dd>{data.health.failingStreak ?? t('unavailable')}</dd></div></dl>
        <h4>{t('failures')}</h4>
        <p className="insights-hint">{t('retained')}</p>
        {!data.health.recentFailures.length && <p className="insights-hint">{t('noFailures')}</p>}
        <ol className="insights-health-failures">{data.health.recentFailures.map((failure, index) => <li key={index}>
          <dl className="insights-facts"><div><dt>{t('started')}</dt><dd><ObservationTime value={failure.startedAt} /></dd></div><div><dt>{t('finished')}</dt><dd><ObservationTime value={failure.finishedAt} /></dd></div><div><dt>{t('exitCode')}</dt><dd>{failure.exitCode}</dd></div></dl>
          <details className="insights-output-disclosure"><summary>{t('showOutput')}</summary>
            <div className="insights-output-heading"><span>{t('output')}</span><button type="button" disabled={!failure.output} onClick={() => { void copy(failure.output, 'healthOutput'); }}><Copy size={13} aria-hidden="true" />{t('copyOutput')}</button></div>
            <pre className="insights-health-output" tabIndex={0}>{failure.output || t('noOutput')}</pre>
          </details>
          {failure.truncated && <p className="insights-warning">{t('truncated')}</p>}
        </li>)}</ol>
      </>}
    </section>
  </div>;
}

function normalizedHost(value: string): string { return value.replace(/^\[|\]$/g, '').trim(); }
function wildcardFamily(host: string): 4 | 6 | null {
  return host === '0.0.0.0' ? 4 : host.includes(':') && /^[0:]+$/.test(host) ? 6 : null;
}
function hostAndPort(host: string, port: number): string { return `${host.includes(':') ? `[${host}]` : host}:${port}`; }
/** Copy a concrete candidate, never an unspecified Engine bind address. */
export function connectionCandidate(binding: ContainerPort['bindings'][number]): string | null {
  const host = normalizedHost(binding.hostIp);
  if (!host || binding.hostPort === null || !Number.isInteger(binding.hostPort) || binding.hostPort < 1 || binding.hostPort > 65535) return null;
  const family = wildcardFamily(host);
  return hostAndPort(family === 4 ? '127.0.0.1' : family === 6 ? '::1' : host, binding.hostPort);
}

export function ContainerConnectivity({ details, copy }: { details: ContainerDetails; copy: CopyInsight }) {
  const t = useI18n(containerInsightsMessages);
  const data = details.connectivity;
  const [portKey, setPortKey] = useState('');
  const ordinaryMode = !!data.networkMode && data.networkMode !== 'host' && data.networkMode !== 'none' && !data.networkMode.startsWith('container:');
  const portOptions = data.portsAvailable && ordinaryMode ? data.ports : [];
  const selectedPort = portOptions.find(port => `${port.containerPort}/${port.protocol}` === portKey);
  const addressRow = (address: string, index: number) => {
    const host = normalizedHost(address);
    if (!host || wildcardFamily(host)) return <span key={index}>{t('unavailable')}</span>;
    const candidate = selectedPort ? hostAndPort(host, selectedPort.containerPort) : address;
    return <span className="insights-address" key={index}><code>{candidate}</code><button type="button" aria-label={t('copyAddress', { address: candidate })} title={t('copyAddress', { address: candidate })} onClick={() => { void copy(candidate, 'address'); }}><Copy size={13} aria-hidden="true" /></button></span>;
  };
  return <div className="insights-body">
    <dl className="insights-facts"><div><dt>{t('networkMode')}</dt><dd>{data.networkMode ?? t('unavailable')}</dd></div></dl>
    {data.networkMode === 'host' && <p className="insights-hint">{t('hostMode')}</p>}
    {data.networkMode === 'none' && <p className="insights-hint">{t('noneMode')}</p>}
    {data.networkMode?.startsWith('container:') && <p className="insights-hint">{t('sharedMode')}</p>}
    {!ordinaryMode && <p className="insights-hint">{t('specialCandidates')}</p>}
    <section className="insights-section" aria-label={t('ports')}><h3>{t('ports')}</h3>
      <p className="insights-hint">{t('candidateHint')}</p>
      {!data.portsAvailable ? <p className="insights-hint">{t('portsUnavailable')}</p> : !data.ports.length ? <p className="insights-hint">{t('noPorts')}</p> : <ul className="insights-port-list">{data.ports.map((port, index) => <li key={index}>
        <strong>{port.containerPort}/{port.protocol.toUpperCase()}</strong>
        {!port.bindings.length && <span className="insights-hint">{t('notPublished')}</span>}
        {port.bindings.map((binding, bindingIndex) => {
          const host = normalizedHost(binding.hostIp);
          const family = wildcardFamily(host);
          const candidate = ordinaryMode ? connectionCandidate(binding) : null;
          const reportedBinding = host && binding.hostPort !== null ? hostAndPort(host, binding.hostPort) : `${host || t('unavailable')} · ${t('unavailable')}`;
          return <div className="insights-port-binding" key={bindingIndex}>
            <div><span>{t('engineBinding')}</span><code>{reportedBinding}</code>{family && <span>{t(family === 4 ? 'allIpv4' : 'allIpv6')}</span>}</div>
            {candidate && <div><span>{t('candidate')}</span><div className="insights-address"><code>{candidate}</code><button type="button" aria-label={t('copyAddress', { address: candidate })} title={t('copyAddress', { address: candidate })} onClick={() => { void copy(candidate, 'address'); }}><Copy size={13} aria-hidden="true" /></button></div></div>}
          </div>;
        })}
      </li>)}</ul>}
    </section>
    <section className="insights-section" aria-label={t('networks')}><h3>{t('networks')}</h3>
      <p className="insights-hint">{t('aliasHint')}</p>
      {data.networksAvailable && data.networks.length > 0 && ordinaryMode && <label className="insights-port-choice">{t('internalPort')}
        <select value={selectedPort ? portKey : ''} onChange={event => setPortKey(event.target.value)}><option value="">{t('addressOnly')}</option>
          {portOptions.map((port, index) => <option key={index} value={`${port.containerPort}/${port.protocol}`}>{port.containerPort}/{port.protocol.toUpperCase()}</option>)}
        </select>
      </label>}
      {selectedPort && <p className="insights-hint">{t('internalCandidate')} · {selectedPort.protocol.toUpperCase()}</p>}
      {!data.networksAvailable ? <p className="insights-hint">{t('networksUnavailable')}</p> : !data.networks.length ? <p className="insights-hint">{t('noNetworks')}</p> : <ul className="insights-network-list">{data.networks.map((network, index) => <li key={index}>
        <strong>{network.name}</strong>
        <dl className="insights-facts"><div><dt>{t('aliases')}</dt><dd>{network.aliases.length ? network.aliases.map(addressRow) : t('noAliases')}</dd></div>
          <div><dt>{t('internalAddress')} (IPv4)</dt><dd>{network.ipv4Address ? addressRow(network.ipv4Address, 0) : t('unavailable')}</dd></div>
          <div><dt>{t('internalAddress')} (IPv6)</dt><dd>{network.ipv6Address ? addressRow(network.ipv6Address, 0) : t('unavailable')}</dd></div>
        </dl>
      </li>)}</ul>}
    </section>
  </div>;
}
