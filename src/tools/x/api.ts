import type { XOAuth } from '../../auth/x-oauth.ts';
import { xJson } from './http.ts';

export interface XPost { text: string; reply_to?: string }
export type XPostResult = { id: string; url: string } | { error: 'outcome_unknown' | 'not_connected' | 'cancelled' | 'x_rejected'; status?: number };
const id = (value: unknown): value is string => typeof value === 'string' && /^[0-9]{1,19}$/.test(value);
export function validateXPost(input: XPost) {
  if (!input || typeof input.text !== 'string' || !input.text.trim() || [...input.text].length > 280 || /[\x00-\x08\x0b-\x1f\x7f]/.test(input.text) ||
    (input.reply_to !== undefined && !id(input.reply_to)) || Object.keys(input).some(key => !['text', 'reply_to'].includes(key))) throw new Error('Invalid X post');
}
/** Fixed user-context endpoints for the dedicated shared account; no DM, account creation or arbitrary URL method. */
export class XApi {
  constructor(private auth: Pick<XOAuth, 'access' | 'accountId'>, private fetcher: typeof fetch = fetch) {}
  async post(input: XPost, signal?: AbortSignal): Promise<XPostResult> {
    validateXPost(input); const body = JSON.stringify({ text: input.text, ...(input.reply_to ? { reply: { in_reply_to_tweet_id: input.reply_to } } : {}) });
    let token: string;
    try { token = await this.auth.access(signal); } catch { return { error: 'not_connected' }; }
    if (signal?.aborted) return { error: 'cancelled' };
    try {
      const response = await xJson('https://api.x.com/2/tweets', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body,
        ...(signal ? { signal } : {}) }, this.fetcher);
      const post = (response.data as { data?: { id?: unknown } } | null)?.data;
      if (response.status === 201 && id(post?.id)) return { id: post.id, url: `https://x.com/i/web/status/${post.id}` };
      if ([400, 401, 403, 404, 413, 422, 429].includes(response.status)) return { error: 'x_rejected', status: response.status };
      return { error: 'outcome_unknown' };
    } catch { return { error: 'outcome_unknown' }; }
  }
  async read(postId: string, signal?: AbortSignal) {
    if (!id(postId)) throw new Error('Invalid X post ID');
    const response = await this.#get(`/2/tweets/${postId}?tweet.fields=author_id,created_at`, signal);
    return { posts: [this.#post((response as { data?: unknown }).data)], untrusted: true };
  }
  async mentions(sinceId?: string, signal?: AbortSignal) {
    if (sinceId !== undefined && !id(sinceId)) throw new Error('Invalid X mention cursor');
    const response = await this.#get(`/2/users/${this.auth.accountId}/mentions?max_results=20&tweet.fields=author_id,created_at${sinceId ? `&since_id=${sinceId}` : ''}`, signal) as { data?: unknown };
    if (response.data !== undefined && (!Array.isArray(response.data) || response.data.length > 20)) throw new Error('Invalid X mentions');
    return { posts: ((response.data ?? []) as unknown[]).map(item => this.#post(item)), untrusted: true };
  }
  async #get(path: string, signal?: AbortSignal) {
    const token = await this.auth.access(signal);
    const response = await xJson('https://api.x.com' + path, { headers: { Authorization: `Bearer ${token}` }, ...(signal ? { signal } : {}) }, this.fetcher);
    if (response.status !== 200 || !response.data || typeof response.data !== 'object') throw new Error('X read unavailable');
    return response.data;
  }
  #post(value: unknown) {
    const post = value as { id?: unknown; text?: unknown; author_id?: unknown; created_at?: unknown } | null;
    if (!post || !id(post.id) || typeof post.text !== 'string' || post.text.length > 25_000) throw new Error('Invalid X post response');
    return { id: post.id, text: post.text, url: `https://x.com/i/web/status/${post.id}`,
      ...(id(post.author_id) ? { author_id: post.author_id } : {}), ...(typeof post.created_at === 'string' && post.created_at.length <= 40 ? { created_at: post.created_at } : {}) };
  }
}
