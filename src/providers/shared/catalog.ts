// Derived from Carried c695f855419ffc69d1e62b04f1de8de36c7c162d, core/providers/src/model-catalog.ts.
// Apache-2.0. Modified for Niwa; upstream revision and source path are recorded above.
import type { ReasoningEffort } from '../../contracts/index.ts';

/** A catalog is selection metadata only. It never establishes Carried
 * capability support and deliberately carries no credential material. */
export type ModelCatalogRefreshMode = 'cache_only' | 'online_if_stale' | 'online';
export type ModelCatalogSource = 'remote' | 'cache_fresh' | 'cache_stale';

export interface ProviderModelCatalogEntry {
  readonly provider_id: string;
  readonly model_id: string;
  readonly display_name: string;
  readonly description?: string;
  readonly supported_efforts: readonly ReasoningEffort[];
  readonly unsupported_or_unknown_efforts?: readonly string[];
  readonly default_effort?: ReasoningEffort;
  readonly visibility: 'list' | 'hidden' | 'unknown';
  /** Provider-neutral picker order. Lower values are presented first. */
  readonly display_priority: number;
  readonly supported_in_api?: boolean;
  readonly context_window?: number;
  readonly max_context_window?: number;
}

export interface ProviderModelCatalogSnapshot {
  readonly catalog_version: 2;
  readonly provider_id: string;
  /** A non-secret account hash, or the explicit fallback `default`. */
  readonly account_scope: string;
  /** Opaque protocol identity. It prevents cache reuse across incompatible
   * discovery contracts without persisting account or credential material. */
  readonly discovery_identity: string;
  /** Safe, provider-advertised compatibility metadata for display only. */
  readonly compatibility_client_version?: string;
  readonly source: ModelCatalogSource;
  readonly fetched_at: string;
  readonly expires_at: string;
  readonly etag?: string;
  readonly models: readonly ProviderModelCatalogEntry[];
}

export interface ModelCatalogDiscoveryOptions {
  readonly account_scope: string;
  readonly refresh_mode: Exclude<ModelCatalogRefreshMode, 'cache_only'>;
  readonly etag?: string;
  readonly signal?: AbortSignal;
  readonly request_timeout_ms?: number;
}

export type ProviderModelCatalogDiscoveryResult =
  | { readonly kind: 'snapshot'; readonly snapshot: ProviderModelCatalogSnapshot }
  | { readonly kind: 'not_modified'; readonly etag?: string };

export interface ProviderModelCatalogAdapter {
  readonly provider_id: string;
  /** Opaque identity used to determine whether a cached catalog is compatible
   * with this discovery implementation. */
  readonly discovery_identity: string;
  /** Safe protocol compatibility metadata that may be shown to a user. */
  readonly compatibility_client_version?: string;
  readonly discover: (options: ModelCatalogDiscoveryOptions) => Promise<ProviderModelCatalogDiscoveryResult>;
}

export type ModelCatalogFailureCode =
  | 'AUTH_UNAVAILABLE'
  | 'AUTHENTICATION_FAILED'
  | 'CATALOG_TIMED_OUT'
  | 'CATALOG_NETWORK_ERROR'
  | 'CATALOG_UNAVAILABLE'
  | 'CATALOG_RATE_LIMITED'
  | 'CATALOG_INVALID_RESPONSE'
  | 'CATALOG_EMPTY_RESPONSE'
  | 'ABORTED';

export class ModelCatalogError extends Error {
  override readonly name = 'ModelCatalogError';

  constructor(
    readonly code: ModelCatalogFailureCode,
    message: string,
    readonly retryable: boolean = false,
  ) {
    super(message);
  }
}

export function modelCatalogEmptyResponseError(compatibilityClientVersion?: string): ModelCatalogError {
  return new ModelCatalogError(
    'CATALOG_EMPTY_RESPONSE',
    [
      'Model catalog request completed but returned no models.',
      'The provider returned an empty model catalog.',
      'The request succeeded, but no selectable models were advertised.',
      ...(compatibilityClientVersion === undefined ? [] : [`Compatibility: Codex backend ${compatibilityClientVersion}.`]),
      'Check the backend compatibility version or retry later.',
      'No catalog was cached.',
    ].join(' '),
    true,
  );
}

export const NIWA_REASONING_EFFORTS = Object.freeze([
  'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
] as const);

const MAX_MODELS = 512;
const MAX_MODEL_ID = 256;
const MAX_DISPLAY_NAME = 256;
const MAX_DESCRIPTION = 2048;
const MAX_EFFORTS = 16;
const MAX_ETAG = 1024;
const MAX_DISCOVERY_IDENTITY = 128;
const MAX_COMPATIBILITY_CLIENT_VERSION = 128;
export const DEFAULT_MODEL_CATALOG_DISCOVERY_IDENTITY = `sha256:${'0'.repeat(64)}`;

export function isReasoningEffort(value: string): value is ReasoningEffort {
  return (NIWA_REASONING_EFFORTS as readonly string[]).includes(value);
}

/** Converts Provider metadata to bounded display-safe text without making it
 * authoritative. Control characters are discarded before it reaches a TUI. */
export function sanitizeCatalogText(value: unknown, maxLength: number, required = false): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value
    .replace(/[\p{Cc}]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, maxLength);
  return normalized.length > 0 || !required ? normalized || undefined : undefined;
}

export function parseCatalogEfforts(value: unknown): {
  readonly supported_efforts: readonly ReasoningEffort[];
  readonly unsupported_or_unknown_efforts: readonly string[];
} {
  if (!Array.isArray(value) || value.length > MAX_EFFORTS) {
    throw new ModelCatalogError('CATALOG_INVALID_RESPONSE', 'The provider catalog contained invalid reasoning-effort metadata.');
  }
  const known: ReasoningEffort[] = [];
  const unknown: string[] = [];
  for (const item of value) {
    const source = catalogEffortSource(item);
    if (source.length > 64) throw new ModelCatalogError('CATALOG_INVALID_RESPONSE', 'The provider catalog contained an invalid reasoning effort.');
    const effort = sanitizeCatalogText(source, 64, true);
    if (effort === undefined || effort !== source) throw new ModelCatalogError('CATALOG_INVALID_RESPONSE', 'The provider catalog contained an invalid reasoning effort.');
    if (isReasoningEffort(effort)) {
      if (!known.includes(effort)) known.push(effort);
    } else if (!unknown.includes(effort)) {
      unknown.push(effort);
    }
  }
  return Object.freeze({
    supported_efforts: Object.freeze([...known]),
    unsupported_or_unknown_efforts: Object.freeze([...unknown]),
  });
}

export function createCatalogEntry(input: {
  readonly provider_id: string;
  readonly model_id: unknown;
  readonly display_name?: unknown;
  readonly description?: unknown;
  readonly supported_efforts: unknown;
  /** Used only when re-hydrating a normalized cache entry. Provider parsing
   * derives this field from the original effort list instead. */
  readonly unsupported_or_unknown_efforts?: unknown;
  readonly default_effort?: unknown;
  readonly visibility?: unknown;
  readonly display_priority?: unknown;
  readonly supported_in_api?: unknown;
  readonly context_window?: unknown;
  readonly max_context_window?: unknown;
}): ProviderModelCatalogEntry {
  const providerId = safeIdentifier(input.provider_id, 128, 'provider id');
  const modelId = strictCatalogText(input.model_id, MAX_MODEL_ID, 'model id');
  const displayName = boundedOptionalCatalogText(input.display_name, MAX_DISPLAY_NAME, 'display name') ?? modelId;
  const description = boundedOptionalCatalogText(input.description, MAX_DESCRIPTION, 'description');
  const efforts = parseCatalogEfforts(input.supported_efforts);
  const unsupported = input.unsupported_or_unknown_efforts === undefined
    ? efforts.unsupported_or_unknown_efforts
    : parseUnknownCatalogEfforts(input.unsupported_or_unknown_efforts);
  const candidateDefault = sanitizeCatalogText(input.default_effort, 64);
  const defaultEffort = candidateDefault !== undefined && isReasoningEffort(candidateDefault) && efforts.supported_efforts.includes(candidateDefault)
    ? candidateDefault
    : undefined;
  const visibility = input.visibility === 'list' || input.visibility === 'hidden' ? input.visibility : 'unknown';
  const displayPriority = input.display_priority === undefined ? 0 : safeDisplayPriority(input.display_priority);
  const contextWindow = input.context_window === undefined ? undefined : safeContextWindow(input.context_window);
  const maxContextWindow = input.max_context_window === undefined ? undefined : safeContextWindow(input.max_context_window);
  const entry: ProviderModelCatalogEntry = {
    provider_id: providerId,
    model_id: modelId,
    display_name: displayName,
    ...(description === undefined ? {} : { description }),
    supported_efforts: efforts.supported_efforts,
    ...(unsupported.length === 0 ? {} : { unsupported_or_unknown_efforts: unsupported }),
    ...(defaultEffort === undefined ? {} : { default_effort: defaultEffort }),
    visibility,
    display_priority: displayPriority,
    ...(typeof input.supported_in_api === 'boolean' ? { supported_in_api: input.supported_in_api } : {}),
    ...(contextWindow === undefined ? {} : { context_window: contextWindow }),
    ...(maxContextWindow === undefined ? {} : { max_context_window: maxContextWindow }),
  };
  return Object.freeze(entry);
}

export function createCatalogSnapshot(input: {
  readonly provider_id: string;
  readonly account_scope: string;
  readonly discovery_identity?: string;
  readonly compatibility_client_version?: string;
  readonly source: ModelCatalogSource;
  readonly fetched_at: string;
  readonly expires_at: string;
  readonly etag?: string;
  readonly models: readonly ProviderModelCatalogEntry[];
}): ProviderModelCatalogSnapshot {
  const providerId = safeIdentifier(input.provider_id, 128, 'provider id');
  const scope = safeAccountScope(input.account_scope);
  const discoveryIdentity = safeDiscoveryIdentity(input.discovery_identity ?? DEFAULT_MODEL_CATALOG_DISCOVERY_IDENTITY);
  const compatibilityClientVersion = input.compatibility_client_version === undefined
    ? undefined
    : safeCompatibilityClientVersion(input.compatibility_client_version);
  if (input.source !== 'remote' && input.source !== 'cache_fresh' && input.source !== 'cache_stale') throw new ModelCatalogError('CATALOG_INVALID_RESPONSE', 'The catalog source is invalid.');
  const fetchedAt = safeTimestamp(input.fetched_at, 'fetched_at');
  const expiresAt = safeTimestamp(input.expires_at, 'expires_at');
  if (Date.parse(expiresAt) < Date.parse(fetchedAt)) throw new ModelCatalogError('CATALOG_INVALID_RESPONSE', 'The catalog expiry precedes its fetch time.');
  if (input.models.length > MAX_MODELS) throw new ModelCatalogError('CATALOG_INVALID_RESPONSE', 'The provider catalog contains too many models.');
  const deduplicated = new Map<string, ProviderModelCatalogEntry>();
  for (const model of input.models) {
    if (model.provider_id !== providerId) throw new ModelCatalogError('CATALOG_INVALID_RESPONSE', 'The provider catalog mixed provider identities.');
    const previous = deduplicated.get(model.model_id);
    if (previous === undefined) {
      deduplicated.set(model.model_id, model);
      continue;
    }
    if (JSON.stringify(previous) !== JSON.stringify(model)) {
      throw new ModelCatalogError('CATALOG_INVALID_RESPONSE', 'The provider catalog contains conflicting duplicate model ids.');
    }
  }
  const models = [...deduplicated.values()].sort(compareCatalogEntries);
  const etag = input.etag === undefined ? undefined : sanitizeCatalogText(input.etag, MAX_ETAG);
  return Object.freeze({
    catalog_version: 2,
    provider_id: providerId,
    account_scope: scope,
    discovery_identity: discoveryIdentity,
    ...(compatibilityClientVersion === undefined ? {} : { compatibility_client_version: compatibilityClientVersion }),
    source: input.source,
    fetched_at: fetchedAt,
    expires_at: expiresAt,
    ...(etag === undefined ? {} : { etag }),
    models: Object.freeze(models.map((model) => Object.freeze({ ...model, supported_efforts: Object.freeze([...model.supported_efforts]), ...(model.unsupported_or_unknown_efforts === undefined ? {} : { unsupported_or_unknown_efforts: Object.freeze([...model.unsupported_or_unknown_efforts]) }) }))),
  });
}

export function compareCatalogEntries(left: ProviderModelCatalogEntry, right: ProviderModelCatalogEntry): number {
  // Lower display priority is presented first, then stable human-readable keys.
  return left.display_priority - right.display_priority
    || left.display_name.localeCompare(right.display_name, 'en')
    || left.model_id.localeCompare(right.model_id, 'en');
}

export function safeAccountScope(value: string): string {
  if (value === 'default') return value;
  if (/^sha256:[a-f0-9]{64}$/u.test(value)) return value;
  throw new ModelCatalogError('CATALOG_INVALID_RESPONSE', 'The catalog account scope is invalid.');
}

function safeIdentifier(value: string, max: number, label: string): string {
  const text = sanitizeCatalogText(value, max, true);
  if (text === undefined || text !== value || /\s/u.test(text)) throw new ModelCatalogError('CATALOG_INVALID_RESPONSE', `The catalog ${label} is invalid.`);
  return text;
}

function strictCatalogText(value: unknown, max: number, label: string): string {
  if (typeof value !== 'string' || value.length > max) {
    throw new ModelCatalogError('CATALOG_INVALID_RESPONSE', `The provider catalog ${label} exceeds its supported bounds.`);
  }
  const text = sanitizeCatalogText(value, max, true);
  if (text === undefined || text !== value) throw new ModelCatalogError('CATALOG_INVALID_RESPONSE', `The provider catalog ${label} is invalid.`);
  return text;
}

function boundedOptionalCatalogText(value: unknown, max: number, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length > max) throw new ModelCatalogError('CATALOG_INVALID_RESPONSE', `The provider catalog ${label} exceeds its supported bounds.`);
  return sanitizeCatalogText(value, max);
}

function parseUnknownCatalogEfforts(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_EFFORTS) throw new ModelCatalogError('CATALOG_INVALID_RESPONSE', 'The cached catalog contained invalid unknown-effort metadata.');
  const unknown: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.length > 64) throw new ModelCatalogError('CATALOG_INVALID_RESPONSE', 'The cached catalog contained invalid unknown-effort metadata.');
    const effort = sanitizeCatalogText(item, 64, true);
    if (effort === undefined || effort !== item || isReasoningEffort(effort) || unknown.includes(effort)) throw new ModelCatalogError('CATALOG_INVALID_RESPONSE', 'The cached catalog contained invalid unknown-effort metadata.');
    unknown.push(effort);
  }
  return Object.freeze(unknown);
}

function catalogEffortSource(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ModelCatalogError('CATALOG_INVALID_RESPONSE', 'The provider catalog contained an invalid reasoning effort.');
  }
  const record = value as Record<string, unknown>;
  if (typeof record['effort'] !== 'string') {
    throw new ModelCatalogError('CATALOG_INVALID_RESPONSE', 'The provider catalog contained an invalid reasoning effort.');
  }
  if (record['description'] !== undefined) {
    if (typeof record['description'] !== 'string' || record['description'].length > MAX_DESCRIPTION) {
      throw new ModelCatalogError('CATALOG_INVALID_RESPONSE', 'The provider catalog contained an invalid reasoning-effort description.');
    }
    sanitizeCatalogText(record['description'], MAX_DESCRIPTION);
  }
  return record['effort'];
}

function safeTimestamp(value: string, label: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value) || Number.isNaN(Date.parse(value))) {
    throw new ModelCatalogError('CATALOG_INVALID_RESPONSE', `The catalog ${label} is invalid.`);
  }
  return value;
}

function safeDisplayPriority(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < -1_000_000 || value > 1_000_000) {
    throw new ModelCatalogError('CATALOG_INVALID_RESPONSE', 'The provider catalog contained an invalid display priority.');
  }
  return value;
}

function safeDiscoveryIdentity(value: string): string {
  if (typeof value !== 'string' || value.length > MAX_DISCOVERY_IDENTITY || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new ModelCatalogError('CATALOG_INVALID_RESPONSE', 'The catalog discovery identity is invalid.');
  }
  return value;
}

function safeCompatibilityClientVersion(value: string): string {
  const text = sanitizeCatalogText(value, MAX_COMPATIBILITY_CLIENT_VERSION, true);
  if (text === undefined || text !== value || !/^[0-9A-Za-z][0-9A-Za-z._+-]*$/u.test(text)) {
    throw new ModelCatalogError('CATALOG_INVALID_RESPONSE', 'The catalog compatibility client version is invalid.');
  }
  return text;
}

function safeContextWindow(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 100_000_000) {
    throw new ModelCatalogError('CATALOG_INVALID_RESPONSE', 'The provider catalog contained an invalid context window.');
  }
  return value;
}
