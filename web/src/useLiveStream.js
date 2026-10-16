import { useEffect, useRef, useState } from 'react';

const LINGER_MS = 60_000;
const parse = text => { try { return JSON.parse(text); } catch { return null; } };

/** Server push for refresh hints and reply drafts. Polling remains the fallback while disconnected. */
export function useLiveStream(enabled, onChange) {
  const [connected, setConnected] = useState(false);
  const [drafts, setDrafts] = useState({});
  const changed = useRef(onChange); changed.current = onChange;
  useEffect(() => {
    if (!enabled || typeof EventSource === 'undefined') return undefined;
    let source; let retry; let stopped = false;
    const open = () => {
      source = new EventSource('/api/events/stream');
      source.addEventListener('ready', event => {
        const data = parse(event.data); setConnected(true);
        setDrafts(Object.fromEntries((data?.drafts || []).map(draft => [draft.task_id, { ...draft, state: 'live' }])));
        changed.current?.();
      });
      source.addEventListener('changed', () => changed.current?.());
      source.addEventListener('draft', event => {
        const draft = parse(event.data); if (!draft?.task_id) return;
        setDrafts(current => ({ ...current, [draft.task_id]: { ...draft, state: 'live' } }));
      });
      source.addEventListener('draft_end', event => {
        const end = parse(event.data); if (!end?.task_id) return;
        setDrafts(current => {
          const draft = current[end.task_id]; if (!draft) return current;
          // A finished call keeps its text until the posted message replaces it; failures disappear at once.
          if (end.reason === 'completed' && draft.text) return { ...current, [end.task_id]: { ...draft, state: 'sending', ended_at: Date.now() } };
          const { [end.task_id]: _removed, ...rest } = current; return rest;
        });
      });
      source.onerror = () => {
        setConnected(false);
        if (source.readyState === EventSource.CLOSED && !stopped) { clearTimeout(retry); retry = setTimeout(open, 15_000); }
      };
    };
    open();
    const sweep = setInterval(() => setDrafts(current => {
      const stale = Object.values(current).filter(draft => draft.state === 'sending' && Date.now() - draft.ended_at > LINGER_MS);
      if (!stale.length) return current;
      const next = { ...current }; for (const draft of stale) delete next[draft.task_id]; return next;
    }), 5_000);
    return () => { stopped = true; source?.close(); clearTimeout(retry); clearInterval(sweep); setConnected(false); setDrafts({}); };
  }, [enabled]);
  return { connected, drafts };
}
