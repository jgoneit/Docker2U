import { useI18n } from './i18n';
import { usePreferences } from './preferences';
import { formatTime } from './components';
import type { ResourceSample } from './useContainerStats';

const messages = {
  title: { ko: '자원 사용량', en: 'Resource usage' },
  memory: { ko: '메모리', en: 'Memory' },
  stale: { ko: '오래된 값', en: 'Stale sample' },
  observed: { ko: '관측 시각', en: 'Observed at' },
  pending: { ko: '수집된 값 없음', en: 'No sample available' },
  hint: { ko: '약 5초 간격으로 조회합니다. 메모리 한도는 Docker Engine 기준이며 Mac 전체 메모리와 다를 수 있습니다.', en: 'Samples approximately every 5 seconds. The memory limit comes from Docker Engine and may differ from your Mac’s physical memory.' },
};
export function ResourceUsage({ sample, compact = false }: { sample?: ResourceSample; compact?: boolean }) {
  const t = useI18n(messages);
  const cpu = sample?.available && sample.cpuPercent !== null ? `${sample.cpuPercent.toFixed(2)}%` : '—';
  const memory = sample?.available ? sample.memoryUsage ?? '—' : '—';
  if (compact) return <span className="resource-compact" aria-label={t('title')} title={sample?.stale ? t('stale') : undefined}>
    <span>CPU {cpu}</span><span>{t('memory')} {memory.split(' / ')[0]}</span>{sample?.stale && <span className="resource-stale">{t('stale')}</span>}
  </span>;
  return <section className="resource-summary" aria-label={t('title')}><div className="resource-values"><div><span className="field-label">CPU</span><strong>{cpu}</strong></div><div><span className="field-label">{t('memory')}</span><strong>{memory}</strong></div></div>
    {sample?.stale && <span className="resource-stale" role="status">{t('stale')}</span>}
  </section>;
}
export function ResourceMetadata({ sample }: { sample?: ResourceSample }) {
  const t = useI18n(messages);
  const { language } = usePreferences();
  return <div className="resource-metadata">
    <p className="muted small">{sample?.available ? <>{t('observed')} <time dateTime={sample.sampledAt}>{formatTime(sample.sampledAt, language)}</time></> : t('pending')}</p>
    <p className="muted small">{t('hint')}</p>
  </div>;
}
