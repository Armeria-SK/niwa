// Derived from Carried c695f855419ffc69d1e62b04f1de8de36c7c162d, core/providers/src/openai-subscription-model-catalog.ts.
// Apache-2.0. Modified for Niwa; see THIRD_PARTY_NOTICES.md and provenance/carried.json.
import { createHash } from 'node:crypto';

import type { CredentialStore, OAuthCredential } from '../../auth/credential-store.ts';

import {
  ModelCatalogError,
  createCatalogEntry,
  createCatalogSnapshot,
  modelCatalogEmptyResponseError,
  safeAccountScope,
  sanitizeCatalogText,
  type ModelCatalogDiscoveryOptions,
  type ProviderModelCatalogAdapter,
  type ProviderModelCatalogDiscoveryResult,
  type ProviderModelCatalogEntry,
} from '../shared/catalog.ts';
import {
  DEFAULT_SUBSCRIPTION_BASE_URL,
  DEFAULT_SUBSCRIPTION_ORIGINATOR,
  DEFAULT_SUBSCRIPTION_USER_AGENT,
  createSubscriptionHeaders,
  normalizeSubscriptionBaseUrl,
  validateSubscriptionHeaderValue,
} from './transport.ts';

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const DEFAULT_TTL_MS = 5 * 60_000;
const OPENAI_SUBSCRIPTION_CATALOG_PROTOCOL_REVISION = 'v1';

export interface OpenAISubscriptionModelCatalogConfig {
  readonly experimental_opt_in: boolean;
  readonly credential_store: CredentialStore;
  readonly client_version: string;
  readonly base_url?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly originator?: string;
  readonly user_agent?: string;
  readonly now?: () => number;
  readonly ttl_ms?: number;
  readonly request_timeout_ms?: number;
  readonly max_response_body_bytes?: number;
  readonly refresh?: (refreshToken: string, currentCredential?: OAuthCredential, signal?: AbortSignal) => Promise<OAuthCredential>;
}

/** Experimental, subscription-only selection catalog. This has no model-run
 * capability and is intentionally isolated from the public OpenAI API. */
export class OpenAISubscriptionModelCatalogAdapter implements ProviderModelCatalogAdapter {
  readonly provider_id = 'openai_subscription' as const;
  readonly discovery_identity: string;
  readonly compatibility_client_version: string;

  readonly #store: CredentialStore;
  readonly #clientVersion: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #originator: string;
  readonly #userAgent: string;
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #requestTimeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #refresh: OpenAISubscriptionModelCatalogConfig['refresh'];

  constructor(config: OpenAISubscriptionModelCatalogConfig) {
    if (config.experimental_opt_in !== true) throw new Error('GPT subscription model discovery requires explicit experimental opt-in.');
    this.#store = config.credential_store;
    this.#clientVersion = safeClientVersion(config.client_version);
    this.#baseUrl = normalizeSubscriptionBaseUrl(config.base_url ?? DEFAULT_SUBSCRIPTION_BASE_URL);
    this.#fetch = config.fetch ?? globalThis.fetch;
    this.#originator = validateSubscriptionHeaderValue(config.originator ?? DEFAULT_SUBSCRIPTION_ORIGINATOR, 'originator');
    this.#userAgent = validateSubscriptionHeaderValue(config.user_agent ?? DEFAULT_SUBSCRIPTION_USER_AGENT, 'user_agent');
    this.compatibility_client_version = this.#clientVersion;
    this.discovery_identity = createOpenAISubscriptionCatalogDiscoveryIdentity(this.#clientVersion, this.#originator);
    this.#now = config.now ?? (() => Date.now());
    this.#ttlMs = boundedPositive(config.ttl_ms ?? DEFAULT_TTL_MS, 60_000, 24 * 60 * 60_000, 'ttl_ms');
    this.#requestTimeoutMs = boundedPositive(config.request_timeout_ms ?? DEFAULT_REQUEST_TIMEOUT_MS, 100, 120_000, 'request_timeout_ms');
    this.#maxResponseBytes = boundedPositive(config.max_response_body_bytes ?? DEFAULT_RESPONSE_BYTES, 1024, MAX_RESPONSE_BYTES, 'max_response_body_bytes');
    this.#refresh = config.refresh;
  }

  async discover(options: ModelCatalogDiscoveryOptions): Promise<ProviderModelCatalogDiscoveryResult> {
    if (options.signal?.aborted) throw aborted();
    const accountScope = safeAccountScope(options.account_scope);
    const requestTimeoutMs = this.#requestTimeout(options);
    let credential = await this.#usableCredential(options.signal);
    let response = await this.#request(credential, options, requestTimeoutMs);
    if (response.status === 401 && this.#refresh !== undefined) {
      await response.body?.cancel().catch(() => undefined);
      credential = await this.#refreshOnce(credential, options.signal);
      response = await this.#request(credential, options, requestTimeoutMs);
    }
    const responseEtag = safeEtag(response.headers.get('etag'));
    if (response.status === 304) {
      await response.body?.cancel().catch(() => undefined);
      return responseEtag === undefined
        ? Object.freeze({ kind: 'not_modified' as const })
        : Object.freeze({ kind: 'not_modified' as const, etag: responseEtag });
    }
    if (!response.ok) throw await catalogHttpFailure(response, requestTimeoutMs);
    const body = await readBoundedText(response, this.#maxResponseBytes, options.signal, requestTimeoutMs);
    const models = parseSubscriptionCatalog(body);
    if (models.length === 0) throw modelCatalogEmptyResponseError(this.#clientVersion);
    const now = new Date(this.#now());
    const snapshot = createCatalogSnapshot({
      provider_id: this.provider_id,
      account_scope: accountScope,
      discovery_identity: this.discovery_identity,
      compatibility_client_version: this.compatibility_client_version,
      source: 'remote',
      fetched_at: now.toISOString(),
      expires_at: new Date(now.getTime() + this.#ttlMs).toISOString(),
      ...(responseEtag === undefined ? {} : { etag: responseEtag }),
      models,
    });
    return Object.freeze({ kind: 'snapshot', snapshot });
  }

  async #usableCredential(signal: AbortSignal | undefined): Promise<OAuthCredential> {
    let credential: OAuthCredential | undefined;
    try { credential = await this.#store.read(); }
    catch { throw new ModelCatalogError('AUTH_UNAVAILABLE', 'GPT subscription credentials are unavailable.'); }
    if (credential === undefined) throw new ModelCatalogError('AUTH_UNAVAILABLE', 'GPT subscription login is required before loading available models.');
    if (credential.expires_at > this.#now() + 30_000) return credential;
    return await this.#refreshOnce(credential, signal);
  }

  async #refreshOnce(credential: OAuthCredential, signal: AbortSignal | undefined): Promise<OAuthCredential> {
    if (signal?.aborted) throw aborted();
    if (this.#refresh === undefined) throw new ModelCatalogError('AUTHENTICATION_FAILED', 'The GPT subscription credential has expired.', false);
    try {
      const refreshed = await this.#refresh(credential.refresh_token, credential, signal);
      if (signal?.aborted) throw aborted();
      if (!isCredential(refreshed)) throw new Error('invalid refresh result');
      await this.#store.write(refreshed);
      return refreshed;
    } catch (error) {
      if (error instanceof ModelCatalogError) throw error;
      if (signal?.aborted) throw aborted();
      throw new ModelCatalogError('AUTHENTICATION_FAILED', 'GPT subscription credential refresh failed.', false);
    }
  }

  #requestTimeout(options: ModelCatalogDiscoveryOptions): number {
    return options.request_timeout_ms === undefined
      ? this.#requestTimeoutMs
      : boundedPositive(options.request_timeout_ms, 100, 120_000, 'request_timeout_ms');
  }

  async #request(credential: OAuthCredential, options: ModelCatalogDiscoveryOptions, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = (): void => controller.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    try {
      const url = new URL('models', this.#baseUrl);
      url.searchParams.set('client_version', this.#clientVersion);
      // A caller may only make a conditional request when it is deliberately
      // revalidating a compatible stale cache. Full refreshes must not retain a
      // possibly bad prior response through a 304.
      const etag = options.refresh_mode === 'online_if_stale' ? safeEtag(options.etag) : undefined;
      return await this.#fetch(url, {
        method: 'GET',
        redirect: 'error',
        headers: {
          ...createSubscriptionHeaders(credential, {
            accept: 'application/json',
            originator: this.#originator,
            user_agent: this.#userAgent,
          }),
          ...(etag === undefined ? {} : { 'If-None-Match': etag }),
        },
        signal: controller.signal,
      });
    } catch {
      if (timedOut) throw new ModelCatalogError('CATALOG_TIMED_OUT', 'The model catalog request timed out.', true);
      if (options.signal?.aborted) throw aborted();
      throw new ModelCatalogError('CATALOG_NETWORK_ERROR', 'The model catalog request failed before a response.', true);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }
  }
}

export function parseOpenAISubscriptionModelCatalog(value: unknown, accountScope = 'default', now = new Date(), ttlMs = DEFAULT_TTL_MS): readonly ProviderModelCatalogEntry[] {
  const root = asRecord(value);
  const items = root?.['models'];
  if (!Array.isArray(items)) throw new ModelCatalogError('CATALOG_INVALID_RESPONSE', 'The model catalog response did not contain a models array.');
  if (items.length > 512) throw new ModelCatalogError('CATALOG_INVALID_RESPONSE', 'The model catalog contains too many models.');
  const models = items.map((item) => parseEntry(item));
  // Reuse snapshot validation for duplicate detection and all generic bounds.
  return createCatalogSnapshot({
    provider_id: 'openai_subscription',
    account_scope: accountScope,
    source: 'remote',
    fetched_at: now.toISOString(),
    expires_at: new Date(now.getTime() + ttlMs).toISOString(),
    models,
  }).models;
}

function parseSubscriptionCatalog(body: string): readonly ProviderModelCatalogEntry[] {
  let value: unknown;
  try { value = JSON.parse(body); }
  catch { throw new ModelCatalogError('CATALOG_INVALID_RESPONSE', 'The model catalog response was not valid JSON.'); }
  return parseOpenAISubscriptionModelCatalog(value, 'default', new Date(0), DEFAULT_TTL_MS);
}

function parseEntry(value: unknown): ProviderModelCatalogEntry {
  const entry = asRecord(value);
  if (entry === undefined) throw new ModelCatalogError('CATALOG_INVALID_RESPONSE', 'The model catalog contains a malformed entry.');
  const efforts = entry['supported_reasoning_levels'];
  return createCatalogEntry({
    provider_id: 'openai_subscription',
    model_id: entry['slug'],
    display_name: entry['display_name'],
    description: entry['description'],
    supported_efforts: efforts ?? [],
    default_effort: entry['default_reasoning_level'],
    visibility: mapOpenAISubscriptionCatalogVisibility(entry['visibility']),
    display_priority: entry['priority'],
    supported_in_api: entry['supported_in_api'],
    context_window: entry['context_window'],
    max_context_window: entry['max_context_window'],
  });
}

/** Maps the subscription catalog's display policy into Carried's generic
 * picker policy. Unknown values are never promoted to a selectable entry. */
export function mapOpenAISubscriptionCatalogVisibility(value: unknown): 'list' | 'hidden' | 'unknown' {
  if (value === 'list') return 'list';
  if (value === 'hide' || value === 'hidden' || value === 'none') return 'hidden';
  return 'unknown';
}

/** The identity is deliberately opaque in the user cache. It contains the
 * backend protocol revision, compatibility client version, and originator
 * profile, but never credentials or account identifiers. */
export function createOpenAISubscriptionCatalogDiscoveryIdentity(clientVersion: string, originator: string): string {
  const version = safeClientVersion(clientVersion);
  const safeOriginator = validateSubscriptionHeaderValue(originator, 'originator');
  const material = `openai-subscription-catalog\u0000${OPENAI_SUBSCRIPTION_CATALOG_PROTOCOL_REVISION}\u0000${version}\u0000${safeOriginator}`;
  return `sha256:${createHash('sha256').update(material, 'utf8').digest('hex')}`;
}

async function catalogHttpFailure(response: Response, timeoutMs: number): Promise<ModelCatalogError> {
  // Read a small bounded body only to release the stream. It is intentionally
  // not surfaced: provider text can contain untrusted or sensitive content.
  await readBoundedText(response, 16 * 1024, undefined, Math.min(timeoutMs, 5_000)).catch(() => undefined);
  if (response.status === 401) return new ModelCatalogError('AUTHENTICATION_FAILED', 'GPT subscription authentication failed.', false);
  if (response.status === 429) return new ModelCatalogError('CATALOG_RATE_LIMITED', 'The model catalog request was rate limited.', true);
  if (response.status === 403 || response.status === 404) return new ModelCatalogError('CATALOG_UNAVAILABLE', 'The model catalog is unavailable for this subscription.', false);
  if (response.status >= 500) return new ModelCatalogError('CATALOG_UNAVAILABLE', 'The model catalog service is temporarily unavailable.', true);
  return new ModelCatalogError('CATALOG_UNAVAILABLE', 'The model catalog request was rejected.', false);
}

async function readBoundedText(response: Response, maxBytes: number, signal?: AbortSignal, timeoutMs?: number): Promise<string> {
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let total = 0;
  let output = '';
  let timedOut = false;
  const onAbort = (): void => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = timeoutMs === undefined
    ? undefined
    : setTimeout(() => {
      timedOut = true;
      void reader.cancel().catch(() => undefined);
    }, timeoutMs);
  try {
    for (;;) {
      if (signal?.aborted) throw aborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ModelCatalogError('CATALOG_INVALID_RESPONSE', 'The model catalog response exceeded its byte limit.');
      }
      output += decoder.decode(chunk.value, { stream: true });
    }
    if (timedOut) throw new ModelCatalogError('CATALOG_TIMED_OUT', 'The model catalog response timed out.', true);
    if (signal?.aborted) throw aborted();
    return output + decoder.decode();
  } catch (error) {
    if (error instanceof ModelCatalogError) throw error;
    if (timedOut) throw new ModelCatalogError('CATALOG_TIMED_OUT', 'The model catalog response timed out.', true);
    if (signal?.aborted) throw aborted();
    throw new ModelCatalogError('CATALOG_INVALID_RESPONSE', 'The model catalog response could not be decoded.');
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    await reader.cancel().catch(() => undefined);
  }
}

function safeClientVersion(value: string): string {
  const text = sanitizeCatalogText(value, 128, true);
  if (text === undefined || text !== value) throw new Error('client_version contains invalid characters.');
  return text;
}

function safeEtag(value: string | null | undefined): string | undefined {
  return value == null ? undefined : sanitizeCatalogText(value, 1024);
}

function boundedPositive(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${name} is outside its allowed bound.`);
  return value;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function isCredential(value: unknown): value is OAuthCredential {
  if (!asRecord(value)) return false;
  const candidate = value as OAuthCredential;
  return typeof candidate.access_token === 'string'
    && typeof candidate.refresh_token === 'string'
    && Number.isSafeInteger(candidate.expires_at);
}

function aborted(): ModelCatalogError {
  return new ModelCatalogError('ABORTED', 'The model catalog request was aborted.', false);
}

export { DEFAULT_TTL_MS as DEFAULT_MODEL_CATALOG_TTL_MS };
