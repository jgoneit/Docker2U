import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { terminalApi } from '../../terminalApi';
import { terminalRoundtripProbe } from './terminalProbes';

const native = vi.hoisted(() => ({ start: vi.fn(), ack: vi.fn() }));
vi.mock('../../terminalApi', () => ({ terminalApi: { start: native.start, ack: native.ack } }));
vi.mock('./observationProbes', () => ({ captureObservationBaseline: vi.fn().mockResolvedValue({ runId: 'fixture', binarySha256: 'a'.repeat(64), startedAtMs: 1 }) }));

beforeEach(() => {
  vi.useFakeTimers();
  native.start.mockReset();
  document.body.innerHTML = `<div class="project-tree-item" aria-expanded="true"><span class="project-tree-name">native-smoke-project</span></div>
    <button class="container-row" title="native-smoke-1" aria-selected="false"></button>
    <button data-detail-tab="terminal" aria-selected="false"></button>
    <section class="container-terminal"><button class="terminal-connect">Connect</button></section>`;
  for (const selector of ['.container-row', '[data-detail-tab="terminal"]']) {
    const button = document.querySelector<HTMLButtonElement>(selector)!;
    button.onclick = () => button.setAttribute('aria-selected', 'true');
  }
});
afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ''; });

it('reports a direct start rejection immediately with its original code/message and no retry', async () => {
  const failure = { code: 'StaleHandle', message: 'Select the container from the latest list' };
  native.start.mockRejectedValueOnce(failure);
  const rejected = vi.fn();
  document.querySelector<HTMLButtonElement>('.terminal-connect')!.onclick = () => {
    // Product registry handles this rejection; it emits no native descriptor.
    void terminalApi.start('session', 7, 'handle', 'sh', 80, 24, () => {}).catch(rejected);
  };
  const started = Date.now();
  const result = terminalRoundtripProbe(vi.fn());
  const assertion = expect(result).rejects.toThrow(`Native terminal failed: ${failure.code}: ${failure.message}`);
  await vi.advanceTimersByTimeAsync(100);
  await assertion;
  expect(Date.now() - started).toBeLessThan(15_000);
  expect(native.start).toHaveBeenCalledTimes(1);
  expect(rejected).toHaveBeenCalledWith(failure);
  expect(native.ack).not.toHaveBeenCalled();
});
