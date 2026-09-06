import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8');
const blocks = css.match(/:root(?:, :root\[data-theme="light"\])?\s*\{[^}]+\}|:root\[data-theme="dark"\]\s*\{[^}]+\}/g)!;
const palettes = blocks.slice(0, 2).map(block => Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[\da-f]+);/g)].map(match => [match[1]!, match[2]!])));
function luminance(hex: string) {
  const channels = [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}
function contrast(a: string, b: string) {
  const values = [luminance(a), luminance(b)].sort((left, right) => left - right);
  return (values[1]! + 0.05) / (values[0]! + 0.05);
}

describe.each(['light', 'dark'])('%s semantic palette', theme => {
  const palette = palettes[theme === 'light' ? 0 : 1]!;
  const normalSurfaces = ['page', 'surface', 'sidebar', 'raised', 'inset', 'input', 'hover', 'selected', 'selected-hover', 'technical-bg'];
  it('keeps every normal, secondary, status and link text color readable across its container states', () => {
    for (const foreground of ['text', 'text-muted', 'link', 'success', 'danger', 'warning']) {
      for (const background of normalSurfaces) {
        expect(contrast(palette[foreground]!, palette[background]!), `${theme}: ${foreground} on ${background}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
  it('keeps action, disabled, warning, error, and result text at least 4.5:1', () => {
    const pairs = [
      ['on-action', 'primary'], ['on-action', 'primary-hover'], ['on-action', 'danger-action'], ['on-action', 'danger-action-hover'],
      ['on-action', 'start-action'], ['on-action', 'start-action-hover'], ['on-action', 'stop-action'], ['on-action', 'stop-action-hover'], ['on-action', 'restart-action'], ['on-action', 'restart-action-hover'],
      ['disabled-text', 'disabled-bg'], ['warning', 'warning-bg'], ['danger', 'danger-bg'], ['success', 'success-bg'],
      ['text', 'warning-bg'], ['text-muted', 'warning-bg'], ['text', 'danger-bg'], ['text-muted', 'danger-bg'],
      ['text', 'success-bg'], ['text-muted', 'success-bg'], ['log-match-text', 'log-match-bg'],
    ];
    for (const [foreground, background] of pairs) expect(contrast(palette[foreground!]!, palette[background!]!), `${foreground} on ${background}`).toBeGreaterThanOrEqual(4.5);
  });
  it('keeps identifying icons, borders and focus outlines at least 3:1', () => {
    for (const foreground of ['border', 'focus', 'neutral']) {
      for (const background of normalSurfaces) expect(contrast(palette[foreground]!, palette[background]!), `${foreground} on ${background}`).toBeGreaterThanOrEqual(3);
    }
  });
});

it('defines every color token in both palettes and keeps literals out of component styles', () => {
  expect(Object.keys(palettes[0]!).sort()).toEqual(Object.keys(palettes[1]!).sort());
  const componentStyles = css.slice(css.indexOf('* {'));
  for (const match of css.matchAll(/var\(--([\w-]+)\)/g)) expect(palettes[0]).toHaveProperty(match[1]!);
  expect(componentStyles).not.toMatch(/#[\da-f]{3,8}\b/i);
  expect(componentStyles).not.toMatch(/opacity:\s*\./);
});
