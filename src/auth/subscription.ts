import { OAuthAccount } from './account.ts';
import { CredentialStoreUnavailableError, type CredentialStore } from './credential-store.ts';
import { loginWithBrowser, refreshOAuthCredential, OAuthError, type OAuthClientConfig } from './codex-oauth.ts';
import { CodexConnection } from '../providers/codex/connection.ts';
import { check } from '../domain/types.ts';
import type { ModelProfile } from '../providers/shared/profile.ts';

function loginError(error: unknown): string {
  if (error instanceof CredentialStoreUnavailableError) return '認証情報の保存領域を利用できませんでした。Niwaのファイル権限を確認してください。';
  if (error instanceof OAuthError) {
    const messages: Partial<Record<OAuthError['code'], string>> = {
      INVALID_CONFIG: '認証の戻り先を開けませんでした。同じPCで別の認証処理が動いていないか確認してください。',
      AUTHORIZATION_TIMEOUT: '認証結果の受信が時間切れになりました。Niwaを動かしているPCから、もう一度接続してください。',
      STATE_MISMATCH: '認証結果が現在の接続操作と一致しません。古い認証タブを閉じ、もう一度接続してください。',
      CALLBACK_ERROR: '認証結果を受け取れませんでした。もう一度接続してください。',
      TOKEN_ENDPOINT_UNREACHABLE: 'Niwaから認証サーバーへ接続できませんでした。Niwaの通信許可とネットワーク接続を確認してください。',
      TOKEN_EXCHANGE_TIMEOUT: '認証情報の交換が時間切れになりました。通信を確認し、もう一度接続してください。',
      TOKEN_EXCHANGE_FAILED: '認証サーバーが認証情報の交換を受け付けませんでした。もう一度接続してください。',
      TOKEN_RESPONSE_INVALID: '認証サーバーの応答を確認できませんでした。もう一度接続してください。',
    };
    if (messages[error.code]) return messages[error.code]!;
  }
  return '認証を完了できませんでした。もう一度接続してください。';
}

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
  constructor(store: CredentialStore, changed: () => void, config: OAuthClientConfig = {}, reasoningSummary = false) {
    this.#config = { ...config, experimental_opt_in: true }; this.#changed = changed;
    this.account = new OAuthAccount(store, credential => refreshOAuthCredential(this.#config, credential.refresh_token, credential.account_id));
    this.connection = new CodexConnection({ ...(reasoningSummary?{reasoning_summary:'auto' as const}:{}), experimental_opt_in: true, credential_store: this.account, refresh: this.account.refresh,
      ...(config.fetch ? { fetch: config.fetch } : {}) });
  }
  async status() {
    return { connected: !!await this.account.read(), pending: !!this.#attempt, url: this.#url, error: this.#error };
  }
  async models(signal?: AbortSignal) {
    signal?.throwIfAborted();
    const revision = this.#revision;
    check(!this.#attempt && !this.#disconnecting && await this.account.read(), 'conflict', 'Subscription login is required');
    const result = await this.connection.catalog.discover({ account_scope: 'default', refresh_mode: 'online', ...(signal?{signal}: {}) });
    check(revision === this.#revision && result.kind === 'snapshot', 'conflict', 'Subscription account changed');
    return result.snapshot.models.filter(model => model.visibility !== 'hidden');
  }
  async profile(modelId: string, effort: string, signal?: AbortSignal): Promise<ModelProfile> {
    const model = (await this.models(signal)).find(item => item.model_id === modelId);
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
      } catch (error) {
        if (!attempt.abort.signal.aborted) this.#error = loginError(error);
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
