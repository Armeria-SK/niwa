import { useEffect, useRef, useState } from 'react';
import { api } from './api.js';

export function useMemoryPage(member, query) {
  const pages = useRef(1); const generation = useRef(0); const previousKey = useRef('');
  const [data, setData] = useState({ key: '', items: [], total: 0, next: null });
  const [loading, setLoading] = useState(true); const [error, setError] = useState(''); const [retry, setRetry] = useState(0);
  const key = `${member.id}:${query}`;
  const path = `/agents/${member.id}/memories/page?q=${encodeURIComponent(query)}`;
  useEffect(() => {
    if (previousKey.current !== key) { pages.current = 1; previousKey.current = key; }
    const version = ++generation.current; setLoading(true); setError('');
    const timer = setTimeout(async () => {
      try {
        let next = null; let result; const items = [];
        for (let index = 0; index < pages.current; index++) {
          result = await api(`${path}${next === null ? '' : `&before=${next}`}`);
          if (generation.current !== version) return;
          items.push(...result.items); next = result.next; if (next === null) break;
        }
        setData({ ...result, key, items });
      } catch (failure) { if (generation.current === version) setError(failure.message); }
      finally { if (generation.current === version) setLoading(false); }
    }, query ? 200 : 0);
    return () => { generation.current++; clearTimeout(timer); };
  }, [member.memory_version, key, path, retry]);
  async function loadMore() {
    if (loading || data.next === null) return;
    const version = generation.current; setLoading(true); setError('');
    try {
      const result = await api(`${path}&before=${data.next}`);
      if (generation.current !== version) return;
      pages.current++; setData(current => ({ ...result, key, items: [...current.items, ...result.items] }));
    } catch (failure) { if (generation.current === version) setError(failure.message); }
    finally { if (generation.current === version) setLoading(false); }
  }
  return { ...(data.key === key ? data : { items: [], total: 0, next: null }), loading, error, loadMore, reload: () => setRetry(value => value + 1) };
}
