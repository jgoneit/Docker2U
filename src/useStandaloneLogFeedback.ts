import { useEffect, useRef, useState } from 'react';
import type { CopyLabel } from './components';

type Message = { id: number; highlightUntil: number; highlighted: boolean } & (
  { key: 'copied'; label: CopyLabel } | { key: 'copyFailure' | 'logsCleared' }
);
/** Standalone group and child views retain independent feedback, within one Engine session. */
export function useStandaloneLogFeedback(sessionId: string | null, viewKey: string | null) {
  const [messages, setMessages] = useState<Record<string, Message>>({});
  const current = useRef({ sessionId, viewKey }); current.current = { sessionId, viewKey };
  const epoch = useRef(0), sequence = useRef(0), attempts = useRef(new Map<string, number>());
  useEffect(() => { ++epoch.current; attempts.current.clear(); setMessages({}); }, [sessionId]);
  const message = viewKey ? messages[viewKey] ?? null : null;
  useEffect(() => {
    if (!message?.highlighted || !viewKey) return;
    const timer = setTimeout(() => setMessages(previous => previous[viewKey]?.id === message.id
      ? { ...previous, [viewKey]: { ...previous[viewKey]!, highlighted: false } } : previous), Math.max(0, message.highlightUntil - Date.now()));
    return () => clearTimeout(timer);
  }, [message, viewKey]);
  function reserve() {
    const input = current.current, generation = epoch.current, id = ++sequence.current;
    if (input.viewKey) attempts.current.set(input.viewKey, id);
    return (value: { key: 'copied'; label: CopyLabel } | { key: 'copyFailure' | 'logsCleared' }) => {
      if (!input.sessionId || !input.viewKey || generation !== epoch.current || current.current.sessionId !== input.sessionId || attempts.current.get(input.viewKey) !== id) return;
      setMessages(previous => ({ ...previous, [input.viewKey!]: { ...value, id, highlightUntil: Date.now() + 2_000, highlighted: true } }));
    };
  }
  async function copy(text: string, label: CopyLabel) {
    const publish = reserve();
    try { await navigator.clipboard.writeText(text); publish({ key: 'copied', label }); }
    catch { publish({ key: 'copyFailure' }); }
  }
  function beginClear() { const publish = reserve(); return () => publish({ key: 'logsCleared' }); }
  return { message: message ? { ...message, highlighted: message.highlighted && message.highlightUntil > Date.now() } : null, copy, beginClear };
}
