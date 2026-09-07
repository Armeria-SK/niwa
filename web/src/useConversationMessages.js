import { useEffect, useRef, useState } from 'react';
import { api } from './api.js';

const displayMessage = message => message && ({ ...message, author: message.author_id === 'administrator' ? 'you' : message.author_id,
  text: message.body, time: new Date(message.created_at).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }) });

export function useConversationMessages(thread) {
  const [data, setData] = useState({ first: null, items: [], next: null });
  const [loading, setLoading] = useState(true); const [error, setError] = useState('');
  const [retry, setRetry] = useState(0); const [olderVersion, setOlderVersion] = useState(0); const generation = useRef(0);
  const path = `/rooms/${thread.id}/messages/page`;
  useEffect(() => {
    const version = ++generation.current; setLoading(true); setError('');
    api(path).then(result => {
      if (generation.current !== version) return;
      setData(current => {
        const overlap = result.items.some(item => item.id === current.items.at(-1)?.id);
        return overlap && result.next !== null ? { ...result, next: current.next,
          items: [...new Map([...current.items, ...result.items].map(item => [item.id, item])).values()].sort((a, b) => a.sequence - b.sequence) } : result;
      });
    }).catch(failure => { if (generation.current === version) setError(failure.message); })
      .finally(() => { if (generation.current === version) setLoading(false); });
    return () => { generation.current++; };
  }, [path, thread.last_sequence, retry]);
  async function loadMore() {
    if (loading || data.next === null) return false;
    const version = generation.current; setLoading(true); setError('');
    try {
      const result = await api(`${path}?before=${data.next}`);
      if (generation.current !== version) return false;
      setData(current => ({ ...current, next: result.next, items: [...result.items, ...current.items] }));
      setOlderVersion(value => value + 1); return true;
    } catch (failure) { if (generation.current === version) setError(failure.message); return false; }
    finally { if (generation.current === version) setLoading(false); }
  }
  return { first: displayMessage(data.first), items: data.items.map(displayMessage), next: data.next, loading, error, olderVersion,
    loadMore, reload: () => setRetry(value => value + 1) };
}
