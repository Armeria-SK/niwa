import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createPkcePair } from './codex-oauth.ts';
import type { CredentialStore, OAuthCredential } from './credential-store.ts';
import { xJson } from '../tools/x/http.ts';

const scopes = ['tweet.read', 'tweet.write', 'users.read', 'offline.access'];
export interface XClient { client_id: string; client_secret?: string }
const token = (value: unknown): value is string => typeof value === 'string' && /^[\x21-\x7e]{1,65536}$/.test(value);

/** One dedicated account. Tokens never enter model inputs, browser profiles, or generated-program environments. */
export class XOAuth {
  #pending: { state: string; verifier: string; redirect: string; expires: number } | undefined;
  #refresh: Promise<OAuthCredential> | undefined; #generation = 0; #verified = ''; #refreshFailed = false;
  #lifetime = new AbortController();
  constructor(private store: CredentialStore, private client: XClient, readonly accountId: string, private fetcher: typeof fetch = fetch) {
    if (!/^[0-9]{1,19}$/.test(accountId) || !/^[\x21-\x7e]{1,512}$/.test(client.client_id) ||
      (client.client_secret !== undefined && !token(client.client_secret))) throw new Error('Invalid X client configuration');
    this.client = { ...client };
  }
  begin(redirect: string) {
    this.#lifetime.signal.throwIfAborted();
    const callback = new URL(redirect);
    if ((callback.protocol !== 'https:' && !(callback.protocol === 'http:' && callback.hostname === '127.0.0.1')) || callback.username || callback.password || callback.hash || callback.search)
      throw new Error('Invalid X callback');
    this.#generation++;
    const pkce = createPkcePair(); const state = randomBytes(32).toString('base64url');
    this.#pending = { state, verifier: pkce.verifier, redirect: callback.href, expires: Date.now() + 10 * 60_000 };
    const url = new URL('https://x.com/i/oauth2/authorize');
    url.search = new URLSearchParams({ response_type: 'code', client_id: this.client.client_id, redirect_uri: callback.href,
      scope: scopes.join(' '), state, code_challenge: pkce.challenge, code_challenge_method: 'S256' }).toString();
    return { url: url.href, expires_at: this.#pending.expires };
  }
  async finish(state: string, code: string, signal?: AbortSignal) {
    signal = AbortSignal.any([this.#lifetime.signal, ...(signal ? [signal] : [])]); signal.throwIfAborted();
    const pending = this.#pending;
    if (!pending || Date.now() > pending.expires || !/^[A-Za-z0-9_-]{43}$/.test(state) || state.length !== pending.state.length ||
      !timingSafeEqual(Buffer.from(state), Buffer.from(pending.state)) || !token(code)) throw new Error('X authorization state is invalid or expired');
    this.#pending = undefined; const generation = this.#generation;
    const credential = await this.#exchange(new URLSearchParams({ grant_type: 'authorization_code', code,
      redirect_uri: pending.redirect, code_verifier: pending.verifier }), signal);
    await this.#save(credential, generation, signal);
    if (generation !== this.#generation) throw new Error('X connection changed');
    this.#refreshFailed = false;
    return { account_id: this.accountId, connected: true };
  }
  async #exchange(body: URLSearchParams, signal?: AbortSignal): Promise<OAuthCredential> {
    body.set('client_id', this.client.client_id);
    const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
    if (this.client.client_secret) headers.Authorization = 'Basic ' + Buffer.from(`${encodeURIComponent(this.client.client_id)}:${encodeURIComponent(this.client.client_secret)}`).toString('base64');
    const response = await xJson('https://api.x.com/2/oauth2/token', { method: 'POST', headers, body, ...(signal ? { signal } : {}) }, this.fetcher);
    const value = response.data as Record<string, unknown> | null;
    if (response.status !== 200 || !value || !token(value.access_token) || !token(value.refresh_token) || typeof value.token_type !== 'string' || !/^bearer$/i.test(value.token_type) ||
      !Number.isSafeInteger(value.expires_in) || Number(value.expires_in) < 1 || Number(value.expires_in) > 365 * 86400 ||
      typeof value.scope !== 'string' || !scopes.every(scope => (value.scope as string).split(' ').includes(scope))) throw new Error('X authorization response is invalid');
    return { access_token: value.access_token, refresh_token: value.refresh_token, expires_at: Date.now() + Number(value.expires_in) * 1000,
      account_id: this.accountId, token_type: 'bearer' };
  }
  async #verify(credential: OAuthCredential, signal?: AbortSignal) {
    const generation = this.#generation;
    if (credential.account_id !== this.accountId || !token(credential.access_token)) throw new Error('X account does not match configuration');
    if (this.#verified === credential.access_token) return;
    const response = await xJson('https://api.x.com/2/users/me', { headers: { Authorization: `Bearer ${credential.access_token}` }, ...(signal ? { signal } : {}) }, this.fetcher);
    if (response.status !== 200 || (response.data as { data?: { id?: unknown } } | null)?.data?.id !== this.accountId) throw new Error('X account does not match configuration');
    if (generation !== this.#generation) throw new Error('X connection changed');
    this.#verified = credential.access_token;
  }
  async #save(credential: OAuthCredential, generation: number, signal?: AbortSignal) {
    await this.#verify(credential, signal); signal?.throwIfAborted();
    if (generation !== this.#generation) throw new Error('X connection changed');
    await this.store.write(credential);
  }
  async access(signal?: AbortSignal): Promise<string> {
    signal = AbortSignal.any([this.#lifetime.signal, ...(signal ? [signal] : [])]); signal.throwIfAborted();
    const generation = this.#generation; let credential = await this.store.read();
    if (!credential) throw new Error('X is not connected');
    if (credential.expires_at <= Date.now() + 60_000) {
      if (this.#refreshFailed) throw new Error('X authorization must be renewed');
      if (!this.#refresh) this.#refresh = (async () => {
        const updated = await this.#exchange(new URLSearchParams({ grant_type: 'refresh_token', refresh_token: credential!.refresh_token }), signal);
        await this.#save(updated, generation, signal); return updated;
      })().catch(error => { this.#refreshFailed = true; throw error; }).finally(() => { this.#refresh = undefined; });
      credential = await this.#refresh;
    }
    await this.#verify(credential, signal); signal?.throwIfAborted();
    if (generation !== this.#generation) throw new Error('X connection changed');
    return credential.access_token;
  }
  async disconnect() { this.#generation++; this.#pending = undefined; this.#verified = ''; await this.store.clear(); }
  close() { this.#generation++; this.#pending = undefined; this.#verified = ''; this.#lifetime.abort(); }
  async status() {
    const credential = await this.store.read();
    return { available: true, account_id: this.accountId, connected: credential?.account_id === this.accountId,
      expires_at: credential?.account_id === this.accountId ? credential.expires_at : null,
      pending: !!this.#pending && this.#pending.expires > Date.now(), needs_authorization: this.#refreshFailed };
  }
}
