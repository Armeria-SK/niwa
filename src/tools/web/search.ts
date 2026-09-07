import type { JsonObject } from '../../contracts/model.ts';
import { httpJson } from '../../shared/http-json.ts';

export type WebSearch = (query: string, signal?: AbortSignal) => Promise<JsonObject>;

/** Host-only key, fixed endpoint. No remote error text or credential is returned to the bot. */
export function braveSearch(key: string, fetchImpl: typeof fetch = fetch): WebSearch {
  if (!/^[\x21-\x7e]{1,512}$/.test(key)) throw new Error('Invalid search credential');
  return async (query, signal) => {
    if (!query.trim() || query.length > 400) return { error: 'Search query must be 1–400 characters' };
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', query); url.searchParams.set('count', '5');
    try {
      const raw = await httpJson(url, { headers: { 'X-Subscription-Token': key }, fetch: fetchImpl,
        maxBytes: 256 * 1024, ...(signal ? { signal } : {}) });
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid results');
      const data = raw as { web?: { results?: unknown }; error?: unknown };
      if (data.error || (data.web?.results !== undefined && !Array.isArray(data.web.results))) throw new Error('Invalid results');
      const results = (data.web?.results ?? []).slice(0, 5).flatMap((item: unknown) => {
        if (!item || typeof item !== 'object') return [];
        const entry = item as { url?: unknown; title?: unknown; description?: unknown };
        if (typeof entry.url !== 'string' || entry.url.length > 4096) return [];
        let source: URL;
        try { source = new URL(entry.url); } catch { return []; }
        if (!['https:', 'http:'].includes(source.protocol) || source.username || source.password) return [];
        return [{ url: source.href, title: typeof entry.title === 'string' ? entry.title.slice(0, 300) : '',
          description: typeof entry.description === 'string' ? entry.description.slice(0, 1500) : '' }];
      });
      const output = { results, provider: 'brave', searched_at: new Date().toISOString(), untrusted: true };
      if (JSON.stringify(output).includes(key)) throw new Error('Credential appeared in response');
      return output;
    } catch { return { error: 'Web search is unavailable. Check the search connection or retry later.' }; }
  };
}
