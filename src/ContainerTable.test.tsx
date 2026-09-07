import { createRef } from 'react';
import type { KeyboardEvent } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Container } from './api';
import { ContainerTable } from './ContainerTable';
import type { ContainerTableProps } from './ContainerTable';
import { PreferencesProvider } from './preferences';
import type { Language } from './preferences';
import { groupContainers } from './projects';
import type { ResourceSample } from './useContainerStats';

const api: Container = { handle: 'api-handle', fullId: 'a'.repeat(64), shortId: 'a'.repeat(12), name: 'api', image: 'api:1',
  state: 'running', health: 'healthy', ports: ['0.0.0.0:8080→8080/tcp'], composeProject: 'backend', composeService: 'api', createdAt: '2026-09-07T00:00:00Z' };
const worker: Container = { ...api, handle: 'worker-handle', fullId: 'b'.repeat(64), shortId: 'b'.repeat(12), name: 'worker', ports: [], health: 'unhealthy' };
const standalone: Container = { ...api, handle: 'solo-handle', fullId: 'c'.repeat(64), shortId: 'c'.repeat(12), name: 'standalone', composeProject: null, health: null, state: 'exited', ports: [] };

function sample(container: Container, values: Partial<ResourceSample> = {}): ResourceSample {
  return { handle: container.handle, fullId: container.fullId, cpuPercent: 0, memoryUsage: '64MiB / 2GiB', memoryPercent: 3.125,
    available: true, sampledAt: '2026-09-07T00:00:05Z', stale: false, ...values };
}

function setup(overrides: Partial<ContainerTableProps> = {}, language: Language = 'ko') {
  const props: ContainerTableProps = { groups: groupContainers([standalone, worker, api]), selectedId: api.fullId,
    checkedHandles: new Set(), checkboxDisabled: false, sampleFor: () => undefined,
    inventoryRef: createRef<HTMLTableSectionElement>(), onSelect: vi.fn(), onToggle: vi.fn(), onRowKeyDown: vi.fn(), busy: false, ...overrides };
  const view = render(<PreferencesProvider initialPreferences={{ theme: 'light', language }}><ContainerTable {...props} /></PreferencesProvider>);
  return { ...view, props };
}

function row(name: string, language: Language = 'ko') {
  return screen.getByRole('button', { name: language === 'ko' ? `${name} 상세` : `${name} details` }).closest('tr')!;
}

describe('container table', () => {
  it.each(['ko', 'en'] as const)('exposes labelled columns, grouped counts and tbody inventory in %s', language => {
    const { props } = setup({}, language);
    const table = screen.getByRole('table', { name: language === 'ko' ? '컨테이너 목록' : 'Container list' });
    expect(within(table).getAllByRole('columnheader')).toHaveLength(6);
    for (const name of language === 'ko' ? ['컨테이너', '상태', 'CPU', '메모리', '포트'] : ['Container', 'State', 'CPU', 'Memory', 'Ports']) {
      expect(within(table).getByRole('columnheader', { name })).toBeVisible();
    }
    const project = screen.getByRole('heading', { name: 'backend' }).closest('tr')!;
    expect(within(project).getByText('2')).toHaveAccessibleName(language === 'ko' ? '2개 컨테이너' : '2 containers');
    const ungrouped = screen.getByRole('heading', { name: language === 'ko' ? '프로젝트 없음' : 'No project' }).closest('tr')!;
    expect(within(ungrouped).getByText('1')).toBeVisible();
    expect(props.inventoryRef.current?.tagName).toBe('TBODY');
    expect(props.inventoryRef.current?.querySelectorAll('.container-row')).toHaveLength(3);
    expect(within(table).getAllByRole('checkbox')).toHaveLength(3);
  });

  it('keeps checkbox actions separate from details and respects disabled action selection', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn(); const onToggle = vi.fn();
    const { unmount } = setup({ onSelect, onToggle, checkedHandles: new Set([worker.handle]) });
    expect(screen.getByRole('checkbox', { name: 'worker 작업 대상으로 선택' })).toBeChecked();
    await user.click(screen.getByRole('checkbox', { name: 'api 작업 대상으로 선택' }));
    expect(onToggle).toHaveBeenCalledExactlyOnceWith(api);
    expect(onSelect).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'api 상세' }));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(api);
    expect(onToggle).toHaveBeenCalledTimes(1);
    unmount();
    setup({ checkboxDisabled: true, onSelect, onToggle });
    expect(screen.getByRole('checkbox', { name: 'api 작업 대상으로 선택' })).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: 'api 작업 대상으로 선택' }));
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'api 상세' })).toBeEnabled();
  });

  it('preserves roving focus and forwards keyboard navigation indexes across project headers', async () => {
    const user = userEvent.setup();
    const keys = vi.fn((event: KeyboardEvent<HTMLButtonElement>, index: number) => ({ key: event.key, index }));
    const { props } = setup({ selectedId: worker.fullId, onRowKeyDown: keys });
    const buttons = props.inventoryRef.current!.querySelectorAll<HTMLButtonElement>('.container-row');
    expect([...buttons].map(button => button.tabIndex)).toEqual([-1, 0, -1]);
    expect(buttons[1]).toHaveAttribute('aria-current', 'true');
    fireEvent.keyDown(buttons[2]!, { key: 'Home' });
    expect(keys.mock.results[0]?.value).toEqual({ key: 'Home', index: 2 });
    fireEvent.keyDown(buttons[1]!, { key: 'ArrowDown' });
    expect(keys.mock.results[1]?.value).toEqual({ key: 'ArrowDown', index: 1 });
    buttons[1]!.focus();
    await user.keyboard('{Enter}');
    expect(props.onSelect).toHaveBeenCalledExactlyOnceWith(worker);
    expect(props.onToggle).not.toHaveBeenCalled();
  });

  it.each([null, 'filtered-out-id'])('makes the first visible name keyboard reachable without a visible selection (%s)', selectedId => {
    const { props } = setup({ selectedId });
    expect([...props.inventoryRef.current!.querySelectorAll<HTMLButtonElement>('.container-row')].map(button => button.tabIndex)).toEqual([0, -1, -1]);
    expect(props.inventoryRef.current!.querySelector('[aria-current]')).toBeNull();
  });

  it('uses current sample values without hiding zero or clamping multi-core CPU, and abbreviates memory', () => {
    setup({ sampleFor: container => container.fullId === api.fullId ? sample(container) :
      container.fullId === worker.fullId ? sample(container, { cpuPercent: 125.5, memoryUsage: '1.25GiB / 8GiB' }) : undefined });
    expect(within(row('api')).getByText('0.00%')).toBeVisible();
    expect(within(row('worker')).getByText('125.50%')).toBeVisible();
    expect(within(row('api')).getByText('64MiB')).toHaveAttribute('title', '64MiB / 2GiB');
    expect(within(row('worker')).getByText('1.25GiB')).toBeVisible();
    expect(row('standalone').querySelector('.container-cpu-value')).toHaveTextContent('—');
    expect(row('standalone').querySelector('.container-memory-value')).toHaveTextContent('—');
  });

  it.each(['ko', 'en'] as const)('marks old values visibly and associates the warning with both metrics in %s', language => {
    setup({ sampleFor: container => sample(container, { stale: container.fullId === api.fullId }) }, language);
    const selectedRow = row('api', language);
    const warning = within(selectedRow).getByText(language === 'ko' ? '오래된 값' : 'Stale sample');
    expect(warning).toBeVisible();
    expect(warning).toHaveClass('resource-stale');
    for (const selector of ['.container-cpu-value', '.container-memory-value']) {
      expect(selectedRow.querySelector(selector)).toHaveAccessibleDescription(language === 'ko' ? '오래된 값' : 'Stale sample');
    }
    expect(row('worker', language).querySelector('.resource-stale')).toBeNull();
  });

  it('shows unavailable values as em dashes even if a failed sample retains numbers', () => {
    setup({ sampleFor: container => sample(container, { available: false, cpuPercent: 37, stale: true }) });
    expect(screen.queryByText('37.00%')).not.toBeInTheDocument();
    expect(screen.queryByText('64MiB')).not.toBeInTheDocument();
    expect(row('api').querySelector('.container-cpu-value')).toHaveTextContent('—');
    expect(row('api').querySelector('.container-memory-value')).toHaveTextContent('—');
    expect(within(row('api')).getByText('오래된 값')).toBeVisible();
  });

  it('distinguishes a health issue from the process state without repeating healthy and absent checks', () => {
    setup();
    expect(within(row('worker')).getByText('실행 중')).toBeVisible();
    expect(within(row('worker')).getByText('비정상')).toBeVisible();
    expect(row('worker').querySelector('.container-table-health')).toHaveTextContent('헬스: 비정상');
    expect(row('api').querySelector('.container-table-health')).toBeNull();
    expect(row('standalone').querySelector('.container-table-health')).toBeNull();
    expect(screen.queryByText('정상')).not.toBeInTheDocument();
    expect(screen.queryByText('상태 검사 없음')).not.toBeInTheDocument();
  });

  it('retains full names and ports for assistive text and hover while exposing list busy state', () => {
    const long = { ...api, name: 'company-backend-long-development-container-name', ports: ['127.0.0.1:8080→8080/tcp', '[::]:9000→9000/tcp'] };
    setup({ groups: groupContainers([long]), busy: true }, 'en');
    expect(screen.getByRole('table')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: `${long.name} details` })).toHaveAttribute('title', long.name);
    expect(screen.getByText(long.ports.join(', '))).toHaveAttribute('title', long.ports.join(', '));
    expect(screen.getByRole('checkbox', { name: `Select ${long.name} for an action` })).toBeVisible();
  });
});
