import { OAuthAccount } from './account.ts';
import type { CredentialStore } from './credential-store.ts';
import { loginWithBrowser, refreshOAuthCredential, type OAuthClientConfig } from './codex-oauth.ts';
import { CodexConnection } from '../providers/codex/connection.ts';
import { check } from '../domain/types.ts';
import type { ModelProfile } from '../providers/shared/profile.ts';

/** Server-owned OAuth state; Web clients receive only the authorization URL and bounded status. */
export class Subscription {
  readonly account: OAuthAccount;
  readonly connection: CodexConnection;
  #attempt: { abort: AbortController; ready: Promise<string>; done: Promise<void> } | undefined;
  #url: string | null = null;
  #error: string | null = null;
  #config: OAuthClientConfig;
  #changed: () => void;
  #disconnecting: Promise<void> | undefined;
  #revision = 0;
  get revision(): number { return this.#revision; }
  constructor(store: CredentialStore, changed: () => void, config: OAuthClientConfig = {}) {
    this.#config = { ...config, experimental_opt_in: true }; this.#changed = changed;
    this.account = new OAuthAccount(store, credential => refreshOAuthCredential(this.#config, credential.refresh_token, credential.account_id));
    this.connection = new CodexConnection({ experimental_opt_in: true, credential_store: this.account, refresh: this.account.refresh,
      ...(config.fetch ? { fetch: config.fetch } : {}) });
  }
  async status() {
    return { connected: !!await this.account.read(), pending: !!this.#attempt, url: this.#url, error: this.#error };
  }
  async models() {
    const revision = this.#revision;
    check(!this.#attempt && !this.#disconnecting && await this.account.read(), 'conflict', 'Subscription login is required');
    const result = await this.connection.catalog.discover({ account_scope: 'default', refresh_mode: 'online' });
    check(revision === this.#revision && result.kind === 'snapshot', 'conflict', 'Subscription account changed');
    return result.snapshot.models.filter(model => model.visibility !== 'hidden');
  }
  async profile(modelId: string, effort: string): Promise<ModelProfile> {
    const model = (await this.models()).find(item => item.model_id === modelId);
    check(model && model.supported_efforts.some(value => value === effort), 'invalid', 'Model or reasoning effort is unavailable');
    return { runtime: 'gpt', provider_id: 'openai_subscription', provider_model_id: modelId, supported_efforts: [...model.supported_efforts],
      ...(model.context_window === undefined ? {} : { context_window: model.context_window }),
      max_output_tokens: 4096, supports_tool_calls: true, supports_structured_output: false, supports_streaming: true,
      supports_session_resume: false, supports_parallel_sessions: false, supports_usage_reporting: true };
  }
  start(): Promise<string> {
    if (this.#disconnecting) return this.#disconnecting.then(() => this.start());
    if (this.#attempt) return this.#attempt.ready;
    let resolve!: (url: string) => void; let reject!: (error: Error) => void;
    const ready = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
    void ready.catch(() => {});
    const attempt = { abort: new AbortController(), ready, done: Promise.resolve() };
    this.#attempt = attempt; this.#error = null; this.#revision++; this.#changed();
    attempt.done = (async () => {
      try {
        await this.account.clear(); this.#changed();
        const credential = await loginWithBrowser({ ...this.#config, open_external: async url => { this.#url = url; resolve(url); } }, attempt.abort.signal);
        if (this.#attempt !== attempt || attempt.abort.signal.aborted) return;
        await this.account.login(credential); this.#changed();
      } catch {
        if (!attempt.abort.signal.aborted) this.#error = '認証を完了できませんでした。もう一度接続してください。';
        reject(new Error('Subscription login did not start or was cancelled'));
      } finally { if (this.#attempt === attempt) { this.#attempt = undefined; this.#url = null; } }
    })();
    return ready;
  }
  logout(): Promise<void> {
    if (this.#disconnecting) return this.#disconnecting;
    this.#revision++; this.#changed();
    const attempt = this.#attempt; attempt?.abort.abort();
    this.#disconnecting = (async () => { await attempt?.done; await this.account.clear(); this.#error = null; })().finally(() => { this.#disconnecting = undefined; });
    return this.#disconnecting;
  }
  async close(): Promise<void> { const attempt = this.#attempt; attempt?.abort.abort(); await attempt?.done; }
}
