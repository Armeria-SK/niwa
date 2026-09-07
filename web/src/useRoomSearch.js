import { useEffect, useState } from 'react';
import { api } from './api.js';

export function useRoomSearch(query, rooms) {
  const [result, setResult] = useState(null);
  const revision = rooms.map(room => `${room.id}:${room.last_sequence}`).join(',');
  useEffect(() => {
    if (!query) return;
    let active = true;
    const timer = setTimeout(() => { api(`/rooms/search?q=${encodeURIComponent(query)}`)
      .then(ids => { if (active) setResult({ query, revision, ids: new Set(ids) }); })
      .catch(error => { if (active) setResult({ query, revision, error: error.message }); }); }, 200);
    return () => { active = false; clearTimeout(timer); };
  }, [query, revision]);
  const current = result?.query === query && result?.revision === revision ? result : null;
  return { ids: current?.ids, error: current?.error, loading: !!query && !current };
}
