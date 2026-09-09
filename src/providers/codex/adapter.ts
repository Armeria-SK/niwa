// Derived from Carried c695f855419ffc69d1e62b04f1de8de36c7c162d, core/providers/src/openai-subscription-adapter.ts.
// Apache-2.0. Modified for Niwa; upstream revision and source path are recorded above.
import {
  isPlainJsonValue,
  modelRequestSchema,
  type JsonObject,
  type ModelAdapterCapabilities,
  type ModelEvent,
  type ModelFailureCode,
  type ModelFailureOrigin,
  type ModelMessage,
  type ModelRequest,
  type ReasoningEffort,
} from '../../contracts/index.ts';
import type { CredentialStore, OAuthCredential } from '../../auth/credential-store.ts';
import { subscriptionUsageLimit } from './usage-limit.ts';
import { Value } from '@sinclair/typebox/value';

import { createProgressModelEventStream, type ModelAdapter, type ModelEventStream, type ModelRunOptions } from '../shared/adapter.ts';
import { createEffectiveModelCapabilities, type ModelProfile } from '../shared/profile.ts';
import {
  DEFAULT_SUBSCRIPTION_BASE_URL,
  createSubscriptionHeaders,
  normalizeSubscriptionBaseUrl,
} from './transport.ts';
import {
  createCodexResponsesCompatibilityProfile,
  DEFAULT_CODEX_RESPONSES_COMPATIBILITY_PROFILE,
  type CodexResponsesCompatibilityProfile,
} from './compatibility.ts';
import {
  CodexResponsesParseError,
  createCodexResponsesStreamParser,
  parseCodexResponses,
  type CodexReasoningContinuationItem,
  type CodexResponsesDiagnostics,
  type CodexResponsesFailureCategory,
  type CodexResponsesParseResult,
} from './responses-parser.ts';
import {
  containsExactCredentialMaterial,
  containsHighConfidenceSecretIdentifier,
  sanitizeModelRequestTextFields,
} from '../shared/input-safety.ts';
import { redactSecrets, sanitizeModelInputText } from '../../shared/redaction.ts';

const DEFAULT_BASE_URL = DEFAULT_SUBSCRIPTION_BASE_URL;
const DEFAULT_ORIGINATOR = DEFAULT_CODEX_RESPONSES_COMPATIBILITY_PROFILE.originator;
const DEFAULT_USER_AGENT = DEFAULT_CODEX_RESPONSES_COMPATIBILITY_PROFILE.user_agent;
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const DEFAULT_ERROR_BODY_BYTES = 16 * 1024;
const MAX_ERROR_BODY_BYTES = 1024 * 1024;

export const openAISubscriptionAdapterCapabilities: ModelAdapterCapabilities = {
  execution_mode: 'model_api',
  auth_mode: 'subscription_oauth',
  billing_mode: 'subscription',
  owns_agent_loop: false,
  supports_niwa_tool_loop: true,
  supports_tool_calls: true,
  supports_structured_output: true,
  supports_streaming: true,
  supports_session_resume: false,
  supports_parallel_sessions: false,
  supports_usage_reporting: true,
};

export interface OpenAISubscriptionAdapterConfig {
  readonly model_profile: ModelProfile;
  /** Host-owned role; conversation transport attempts do not certify coding. */
  readonly purpose?: 'coding' | 'conversation';
  readonly experimental_opt_in: boolean;
  /** Host-only opt-in after endpoint compatibility acceptance; never enabled from model input. */
  readonly reasoning_summary?: 'auto';
  readonly on_summary_unsupported?: () => void;
  readonly credential_store: CredentialStore;
  readonly base_url?: string;
  readonly fetch?: typeof globalThis.fetch;
  /** First-party-compatible request identity; kept configurable for endpoint policy changes. */
  readonly originator?: string;
  readonly user_agent?: string;
  /** Optional host-owned compatibility profile; never inferred from the
   * Carried product version. */
  readonly compatibility_profile?: Partial<CodexResponsesCompatibilityProfile>;
  readonly now?: () => number;
  readonly refresh?: (refreshToken: string, currentCredential?: OAuthCredential) => Promise<OAuthCredential>;
  readonly max_error_body_bytes?: number;
  readonly max_response_body_bytes?: number;
}

interface FailureDetails {
  readonly code: ModelFailureCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly category: CodexResponsesFailureCategory;
  readonly origin?: ModelFailureOrigin;
  readonly reset_at?: number;
}

class SubscriptionFailure extends Error {
  override readonly name = 'SubscriptionFailure';
  constructor(readonly details: FailureDetails) {
    super(details.message);
  }
}

type RequestAbortReason = 'timeout' | 'aborted';

interface BoundedRequestScope {
  readonly signal: AbortSignal;
  readonly throwIfAborted: () => void;
  readonly abortError: () => SubscriptionFailure;
  readonly dispose: () => void;
}

export interface OpenAISubscriptionRunDiagnostics extends CodexResponsesDiagnostics {
  readonly http_status?: number;
  readonly content_type?: string;
  readonly failure?: {
    readonly category: CodexResponsesFailureCategory;
    readonly code: string;
    readonly safe_message: string;
  };
}

export interface OpenAISubscriptionRunResult {
  readonly events: readonly ModelEvent[];
  readonly diagnostics: OpenAISubscriptionRunDiagnostics;
}

export class OpenAISubscriptionAdapter implements ModelAdapter {
  readonly adapter_id = 'openai-subscription';
  readonly capabilities: ModelAdapterCapabilities;
  readonly supported_efforts: readonly ReasoningEffort[];
  readonly context_window?: number;

  readonly #profile: ModelProfile;
  #summary: 'auto'|undefined;
  #summaryUnsupported: (() => void) | undefined;
  readonly #store: CredentialStore;
  readonly #baseUrl: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #originator: string;
  readonly #userAgent: string;
  readonly #now: () => number;
  readonly #refresh: ((refreshToken: string, currentCredential?: OAuthCredential) => Promise<OAuthCredential>) | undefined;
  readonly #maxErrorBodyBytes: number;
  readonly #maxResponseBodyBytes: number;
  /** Opaque provider continuation; adapter-instance scoped and memory-only. */
  #reasoningContinuation: readonly CodexReasoningContinuationItem[] | undefined;

  constructor(config: OpenAISubscriptionAdapterConfig) {
    if (config.experimental_opt_in !== true) throw new Error('GPT subscription runtime requires explicit experimental opt-in.');
    this.#summary=config.reasoning_summary;this.#summaryUnsupported=config.on_summary_unsupported;
    this.#profile = Object.freeze({ ...config.model_profile });
    if (this.#profile.runtime !== 'gpt' || this.#profile.provider_id !== 'openai_subscription') throw new Error('GPT subscription requires a gpt/openai_subscription model profile.');
    this.capabilities = Object.freeze(
      createEffectiveModelCapabilities(openAISubscriptionAdapterCapabilities, this.#profile, config.purpose),
    );
    this.#store = config.credential_store;
    this.#baseUrl = normalizeSubscriptionBaseUrl(config.base_url ?? config.model_profile.base_url ?? DEFAULT_BASE_URL);
    this.#fetch = config.fetch ?? globalThis.fetch;
    const compatibility = createCodexResponsesCompatibilityProfile({
      ...(config.compatibility_profile ?? {}),
      ...(config.originator === undefined ? {} : { originator: config.originator }),
      ...(config.user_agent === undefined ? {} : { user_agent: config.user_agent }),
    });
    this.#originator = compatibility.originator;
    this.#userAgent = compatibility.user_agent;
    this.#now = config.now ?? (() => Date.now());
    this.#refresh = config.refresh;
    this.supported_efforts = Object.freeze([...this.#profile.supported_efforts]);
    if (this.#profile.context_window !== undefined) this.context_window = this.#profile.context_window;
    this.#maxErrorBodyBytes = config.max_error_body_bytes ?? DEFAULT_ERROR_BODY_BYTES;
    this.#maxResponseBodyBytes = config.max_response_body_bytes ?? MAX_RESPONSE_BYTES;
    this.#reasoningContinuation = undefined;
    assertByteLimit(this.#maxErrorBodyBytes, MAX_ERROR_BODY_BYTES, 'max_error_body_bytes');
    assertByteLimit(this.#maxResponseBodyBytes, MAX_RESPONSE_BYTES, 'max_response_body_bytes');
  }

  run(request: ModelRequest, options: ModelRunOptions): ModelEventStream {
    const cancellation = new AbortController();
    return createProgressModelEventStream(
      emit => this.runDetailed(request, options, cancellation.signal, emit).then((result) => result.events),
      () => cancellation.abort(),
    );
  }

  /** Execute one request while retaining only safe protocol observations for
   * diagnostics. The regular ModelAdapter surface still exposes events only. */
  async runDetailed(request: ModelRequest, options: ModelRunOptions, cancellationSignal = new AbortController().signal, onDisplay?: (event:ModelEvent)=>void): Promise<OpenAISubscriptionRunResult> {
    const observation = createDiagnostics();
    let requestScope: BoundedRequestScope | undefined;
    let providerRequestSent = false;
    const markProviderRequestSent = (): void => { providerRequestSent = true; };
    const exactCredentials = new Set<string>();
    const rememberCredential = (credential: OAuthCredential): void => {
      if (credential.access_token.length > 0) exactCredentials.add(credential.access_token);
      if (credential.refresh_token.length > 0) exactCredentials.add(credential.refresh_token);
    };
    try {
      this.#validateRequest(request, options);
      requestScope = createBoundedRequestScope(options.timeout_ms, [options.signal, cancellationSignal]);
      requestScope.throwIfAborted();
      let credential = await this.#usableCredential(request, requestScope, rememberCredential);
      requestScope.throwIfAborted();
      let response = await this.#performRequest(request, credential, [...exactCredentials], requestScope, markProviderRequestSent);
      observation.http_status = response.status;
      observation.content_type = safeContentType(response.headers.get('content-type'));
      observation.request_id_present = hasRequestIdHeader(response.headers);
      if (response.status === 401 && this.#refresh !== undefined) {
        cancelResponseBody(response);
        requestScope.throwIfAborted();
        credential = await this.#refreshOnce(credential, requestScope);
        rememberCredential(credential);
        response = await this.#performRequest(request, credential, [...exactCredentials], requestScope, markProviderRequestSent);
        observation.http_status = response.status;
        observation.content_type = safeContentType(response.headers.get('content-type'));
        observation.request_id_present = observation.request_id_present || hasRequestIdHeader(response.headers);
      }
      if (this.#summary && response.status===400) {
        const body=await readBoundedBody(response,this.#maxErrorBodyBytes,requestScope);
        let rejected=false;
        try {const error=JSON.parse(body)?.error;rejected=error?.param==='reasoning.summary'&&['unsupported_parameter','unsupported_value','unknown_parameter'].includes(error.code);}catch{/* Unknown errors are not option rejection. */}
        if(!rejected)throw httpFailure(response.status,body,[...exactCredentials]);
        this.#summary=undefined;this.#summaryUnsupported?.();
        response=await this.#performRequest(request,credential,[...exactCredentials],requestScope,markProviderRequestSent);
        observation.http_status=response.status;
      }
      if (!response.ok) {
        const body = await readBoundedBody(response, this.#maxErrorBodyBytes, requestScope);
        const error=httpFailure(response.status, body, [...exactCredentials]);
        const retry=response.headers.get('retry-after');
        const reset=retry?(/^\d+$/.test(retry)?Math.ceil(Date.now()/1000)+Number(retry):Math.ceil(Date.parse(retry)/1000)):undefined;
        throw error.details.retryable&&reset!==undefined&&Number.isSafeInteger(reset)&&reset>=0&&reset<=8640000000000?new SubscriptionFailure({...error.details,reset_at:reset}):error;
      }
      const parsed = await readCodexResponse(response, this.#maxResponseBodyBytes, requestScope, [...exactCredentials], summary=>onDisplay?.({type:'reasoning_summary',summary}));
      requestScope.throwIfAborted();
      observation.merge(parsed.diagnostics);
      if (parsed.diagnostics.response_completed) {
        this.#reasoningContinuation = parsed.reasoning_continuation === undefined
          ? undefined
          : cloneReasoningContinuation(parsed.reasoning_continuation);
      }
      return Object.freeze({ events: parsed.events, diagnostics: observation.snapshot() });
    } catch (error) {
      if (error instanceof CodexResponsesParseError) observation.merge(error.diagnostics);
      const details = failureDetails(error);
      observation.failure = {
        category: details.category,
        // Preserve the bounded provider/protocol code in diagnostics while
        // keeping the public ModelEvent failure code within Carried's stable
        // contract.
        code: error instanceof CodexResponsesParseError ? error.code : details.code,
        safe_message: details.message,
      };
      const partial = error instanceof CodexResponsesParseError ? error.partial_events : [];
      return Object.freeze({
        events: Object.freeze([...partial, toFailureEvent(error, providerRequestSent)]),
        diagnostics: observation.snapshot(),
      });
    } finally {
      requestScope?.dispose();
    }
  }

  #validateRequest(request: ModelRequest, options: ModelRunOptions): void {
    if (
      !Value.Check(modelRequestSchema, request) ||
      !isPlainJsonValue(request, { max_depth: 32, max_nodes: 10_000, max_bytes: MAX_REQUEST_BYTES }) ||
      !Number.isSafeInteger(options.timeout_ms) ||
      options.timeout_ms < 1
    ) {
      throw failure('INVALID_REQUEST', 'The model request or runtime options are invalid.', false);
    }
    if (
      request.reasoning_effort === undefined ||
      !this.supported_efforts.includes(request.reasoning_effort)
    ) {
      throw failure(
        'CAPABILITY_MISMATCH',
        request.reasoning_effort === undefined
          ? 'The GPT runtime requires an explicit EFFORT value.'
          : `The selected GPT model does not support effort ${request.reasoning_effort}.`,
        false,
      );
    }
    if (!this.capabilities.supports_tool_calls && request.tools.length > 0) {
      throw failure('CAPABILITY_MISMATCH', 'The selected GPT model does not support tools.', false);
    }
    if (
      request.response_contract.type === 'json_schema' &&
      !this.capabilities.supports_structured_output
    ) {
      throw failure('CAPABILITY_MISMATCH', 'The selected GPT model does not support structured output.', false);
    }
    if (request.budget.max_output_tokens > this.#profile.max_output_tokens) {
      throw failure('CAPABILITY_MISMATCH', 'The requested output budget exceeds the selected GPT model profile.', false);
    }
    if (containsHighConfidenceSecretIdentifier(request)) {
      throw failure('INVALID_REQUEST', 'The model request contained a secret-shaped structural identifier.', false, undefined, 'local');
    }
  }

  async #usableCredential(
    request: ModelRequest,
    scope: BoundedRequestScope,
    rememberCredential: (credential: OAuthCredential) => void,
  ): Promise<OAuthCredential> {
    const credential = await awaitWithRequestScope(
      Promise.resolve().then(() => {
        scope.throwIfAborted();
        return this.#store.read();
      }),
      scope,
    );
    if (credential === undefined) {
      throw failure('AUTH_UNAVAILABLE', 'GPT subscription login is required.', false);
    }
    rememberCredential(credential);
    // Reject a harness-owned credential leak before an expired credential can
    // trigger refresh I/O. The outbound-body guard remains as defense in depth.
    if (containsExactCredentialMaterial(request, [credential.access_token, credential.refresh_token])) {
      throw failure('INVALID_REQUEST', 'The model request contained configured credential material.', false, undefined, 'local');
    }
    if (credential.expires_at > this.#now() + 30_000) return credential;
    if (this.#refresh === undefined) {
      throw failure('AUTHENTICATION_FAILED', 'GPT subscription credential has expired.', false);
    }
    const refreshed = await this.#refreshOnce(credential, scope);
    rememberCredential(refreshed);
    return refreshed;
  }

  async #refreshOnce(credential: OAuthCredential, scope: BoundedRequestScope): Promise<OAuthCredential> {
    try {
      const refreshed = await awaitWithRequestScope(
        Promise.resolve().then(() => {
          scope.throwIfAborted();
          return this.#refresh?.(credential.refresh_token, credential);
        }),
        scope,
      );
      scope.throwIfAborted();
      if (refreshed === undefined) throw new Error('refresh unavailable');
      await awaitWithRequestScope(
        Promise.resolve().then(() => {
          scope.throwIfAborted();
          return this.#store.write(refreshed);
        }),
        scope,
      );
      scope.throwIfAborted();
      return refreshed;
    } catch (error) {
      if (error instanceof SubscriptionFailure) throw error;
      if (scope.signal.aborted) throw scope.abortError();
      throw failure('AUTHENTICATION_FAILED', 'GPT subscription credential refresh failed.', false);
    }
  }

  async #performRequest(
    request: ModelRequest,
    credential: OAuthCredential,
    exactCredentials: readonly string[],
    scope: BoundedRequestScope,
    markProviderRequestSent: () => void,
  ): Promise<Response> {
    scope.throwIfAborted();
    try {
      if (containsExactCredentialMaterial(request, exactCredentials)) {
        throw failure('INVALID_REQUEST', 'The model request contained configured credential material.', false, undefined, 'local');
      }
      if (containsExactCredentialMaterial(this.#reasoningContinuation, exactCredentials)) {
        throw failure('INVALID_REQUEST', 'The outbound subscription request contained configured credential material.', false, undefined, 'local');
      }
      const modelSafeRequest = sanitizeModelRequestTextFields(request).request;
      const requestBody = toSubscriptionRequest(modelSafeRequest, this.#profile.provider_model_id, this.#reasoningContinuation, this.#summary);
      const body = JSON.stringify(requestBody);
      if (containsExactCredentialMaterial(requestBody, exactCredentials)) {
        throw failure('INVALID_REQUEST', 'The outbound subscription request contained configured credential material.', false, undefined, 'local');
      }
      const requestPromise = Promise.resolve().then(() => {
        scope.throwIfAborted();
        markProviderRequestSent();
        return this.#fetch(new URL('responses', this.#baseUrl), {
          method: 'POST',
          redirect: 'error',
          headers: {
            ...createSubscriptionHeaders(credential, {
              accept: 'text/event-stream, application/json',
              content_type: 'application/json',
              originator: this.#originator,
              user_agent: this.#userAgent,
            }),
            'OpenAI-Beta': 'responses=experimental',
          },
          body,
          signal: scope.signal,
        });
      });
      return await awaitWithRequestScope(requestPromise, scope);
    } catch (error) {
      if (error instanceof SubscriptionFailure) throw error;
      if (scope.signal.aborted) throw scope.abortError();
      throw failure('NETWORK_ERROR', 'The GPT subscription request failed before a response.', true);
    }
  }
}

function cloneReasoningContinuation(
  continuation: readonly CodexReasoningContinuationItem[],
): readonly CodexReasoningContinuationItem[] {
  return Object.freeze(continuation.map((item) => Object.freeze({
    type: 'reasoning' as const,
    ...(item.id === undefined ? {} : { id: item.id }),
    summary: Object.freeze(item.summary.map((summary) => Object.freeze({
      type: 'summary_text' as const,
      text: summary.text,
    }))),
    encrypted_content: item.encrypted_content,
  })));
}

export function toSubscriptionRequest(
  request: ModelRequest,
  model: string,
  reasoningContinuation?: readonly CodexReasoningContinuationItem[],
  summary?: 'auto',
): JsonObject {
  const mappedMessages = request.messages.flatMap(toInputMessages);
  const continuation = (reasoningContinuation ?? []).map(toReasoningInputItem);
  // Responses reasoning items are part of the previous assistant turn. Keep
  // the caller's user/history order intact and place the opaque continuation
  // immediately before that turn's function call when one is present.
  const firstFunctionCall = mappedMessages.findIndex((item) => item['type'] === 'function_call');
  const input = continuation.length === 0
    ? mappedMessages
    : firstFunctionCall < 0
      ? [...mappedMessages, ...continuation]
      : [...mappedMessages.slice(0, firstFunctionCall), ...continuation, ...mappedMessages.slice(firstFunctionCall)];
  return {
    model,
    instructions: request.system_instructions,
    input,
    tool_choice: request.tools.length === 0 ? 'none' : 'auto',
    parallel_tool_calls: false,
    store: false,
    stream: true,
    include: ['reasoning.encrypted_content'],
    ...(request.reasoning_effort === undefined ? {} : { reasoning: { effort: request.reasoning_effort, ...(summary?{summary}:{}) } }),
    ...(request.response_contract.type === 'json_schema'
      ? {
          text: {
            format: {
              type: 'json_schema',
              name: request.response_contract.name,
              schema: request.response_contract.schema,
              strict: request.response_contract.strict,
            },
          },
        }
      : {}),
    ...(request.tools.length === 0
      ? {}
      : {
          tools: request.tools.map((tool) => ({
            type: 'function',
            name: tool.name,
            description: tool.description,
            parameters: tool.input_schema,
            strict: false,
          })),
        }),
  };
}

function toInputMessages(message: ModelMessage): readonly JsonObject[] {
  if (message.role === 'user') {
    return [{
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: message.content }],
    }];
  }
  if (message.role === 'tool') {
    return [{ type: 'function_call_output', call_id: message.tool_call_id, output: message.content }];
  }
  const items: JsonObject[] = [];
  if (message.content !== undefined) {
    items.push({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: message.content }],
    });
  }
  for (const call of message.tool_calls ?? []) {
    items.push({
      type: 'function_call',
      call_id: call.tool_call_id,
      name: call.name,
      arguments: JSON.stringify(call.arguments),
    });
  }
  return items.length > 0 ? items : [{ type: 'message', role: 'assistant', content: [] }];
}

function failure(
  code: ModelFailureCode,
  message: string,
  retryable: boolean,
  category = categoryForCode(code),
  origin?: ModelFailureOrigin,
): SubscriptionFailure {
  return new SubscriptionFailure({ code, message, retryable, category, ...(origin === undefined ? {} : { origin }) });
}

function httpFailure(status: number, body: string, exactCredentials: readonly string[]): SubscriptionFailure {
  if (status === 429) {
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch { /* Unstructured 429 remains a rate limit. */ }
    const limit = subscriptionUsageLimit(parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>)['error'] : undefined);
    if (limit) return new SubscriptionFailure({ code: 'QUOTA_EXCEEDED', message: 'GPT subscription usage limit reached',
      retryable: false, category: 'provider_error', origin: 'provider', ...limit });
  }
  const detail = safeHttpDetail(body, exactCredentials);
  const suffix = detail === undefined ? '' : `: ${detail}`;
  if (status === 401) return failure('AUTHENTICATION_FAILED', `GPT subscription authentication failed${suffix}`, false, 'provider_error', 'provider');
  if (status === 403) return failure('PERMISSION_DENIED', `GPT subscription access was denied${suffix}`, false, 'provider_error', 'provider');
  if (status === 429) return failure('RATE_LIMITED', `GPT subscription rate limit reached${suffix}`, true, 'provider_error', 'provider');
  if (status >= 500) return failure('PROVIDER_UNAVAILABLE', `GPT subscription backend unavailable (HTTP ${status})${suffix}`, true, 'provider_error', 'provider');
  return failure('PROVIDER_ERROR', `GPT subscription backend rejected the request (HTTP ${status})${suffix}`, false, 'provider_error', 'provider');
}

function failureDetails(error: unknown): FailureDetails {
  if (error instanceof SubscriptionFailure) return error.details;
  if (error instanceof CodexResponsesParseError) {
    if (error.usage_limit) return { code: 'QUOTA_EXCEEDED', message: 'GPT subscription usage limit reached',
      retryable: false, category: 'provider_error', origin: 'provider', ...error.usage_limit };
    return {
      code: error.category === 'provider_error' ? 'PROVIDER_ERROR' : 'INVALID_RESPONSE',
      message: error.message,
      retryable: false,
      category: error.category,
    };
  }
  return { code: 'PROVIDER_ERROR', message: 'The GPT subscription adapter failed safely.', retryable: false, category: 'unknown' };
}

function categoryForCode(code: ModelFailureCode): CodexResponsesFailureCategory {
  if (code === 'NETWORK_ERROR' || code === 'TIMED_OUT' || code === 'ABORTED') return 'transport_error';
  if (code === 'INVALID_RESPONSE' || code === 'OUTPUT_LIMIT' || code === 'INVALID_REQUEST' || code === 'CAPABILITY_MISMATCH') return 'protocol_error';
  if (code === 'PROVIDER_ERROR' || code === 'PROVIDER_UNAVAILABLE' || code === 'AUTH_UNAVAILABLE' || code === 'AUTHENTICATION_FAILED' || code === 'PERMISSION_DENIED' || code === 'RATE_LIMITED') return 'provider_error';
  return 'unknown';
}

function toFailureEvent(error: unknown, providerRequestSent: boolean): ModelEvent {
  const details = failureDetails(error);
  return {
    type: 'failed',
    error: {
      code: details.code,
      message: redactSecrets(details.message).slice(0, 2048),
      retryable: details.retryable,
      origin: failureOrigin(details, error, providerRequestSent),
      provider_request_sent: providerRequestSent,
      ...(details.reset_at === undefined ? {} : { reset_at: details.reset_at }),
    },
  };
}

function toReasoningInputItem(item: CodexReasoningContinuationItem): JsonObject {
  return {
    type: 'reasoning',
    ...(item.id === undefined ? {} : { id: item.id }),
    summary: item.summary.map((summary) => ({
      type: 'summary_text',
      text: sanitizeModelInputText(summary.text).text,
    })),
    // This provider-private value must remain byte-for-byte opaque. The exact
    // configured-credential guard runs before this serializer.
    encrypted_content: item.encrypted_content,
  };
}

function failureOrigin(
  details: FailureDetails,
  error: unknown,
  providerRequestSent: boolean,
): ModelFailureOrigin {
  if (details.origin !== undefined) return details.origin;
  if (!providerRequestSent) return 'local';
  if (error instanceof CodexResponsesParseError) return 'provider';
  if (details.code === 'NETWORK_ERROR' || details.code === 'TIMED_OUT' || details.code === 'ABORTED') return 'transport';
  return 'provider';
}

interface MutableAdapterDiagnostics {
  terminal_event: string | undefined;
  readonly event_types: Set<string>;
  response_completed: boolean;
  usage_present: boolean;
  server_model_present: boolean;
  request_id_present: boolean;
  observed_text: boolean;
  observed_tool_call: boolean;
  tool_call_shape: MutableToolCallShapeDiagnostics;
  wire_event_count: number;
  semantic_event_count: number;
  coalesced_delta_count: number;
  http_status: number | undefined;
  content_type: string | undefined;
  failure: OpenAISubscriptionRunDiagnostics['failure'] | undefined;
  merge(value: CodexResponsesDiagnostics): void;
  snapshot(): OpenAISubscriptionRunDiagnostics;
}

interface MutableToolCallShapeDiagnostics {
  item_id_present: boolean;
  call_id_present: boolean;
  name_present: boolean;
  arguments_present: boolean;
  item_done: boolean;
  arguments_done: boolean;
}

function createDiagnostics(): MutableAdapterDiagnostics {
  const value: MutableAdapterDiagnostics = {
    terminal_event: undefined,
    event_types: new Set<string>(),
    response_completed: false,
    usage_present: false,
    server_model_present: false,
    request_id_present: false,
    observed_text: false,
    observed_tool_call: false,
    tool_call_shape: { item_id_present: false, call_id_present: false, name_present: false, arguments_present: false, item_done: false, arguments_done: false },
    wire_event_count: 0,
    semantic_event_count: 0,
    coalesced_delta_count: 0,
    http_status: undefined,
    content_type: undefined,
    failure: undefined,
    merge(next: CodexResponsesDiagnostics): void {
      for (const eventType of next.event_types) if (value.event_types.size < 128) value.event_types.add(eventType.slice(0, 128));
      if (next.terminal_event !== undefined) value.terminal_event = next.terminal_event;
      value.response_completed ||= next.response_completed;
      value.usage_present ||= next.usage_present;
      value.server_model_present ||= next.server_model_present;
      value.request_id_present ||= next.request_id_present;
      value.observed_text ||= next.observed_text;
      value.observed_tool_call ||= next.observed_tool_call;
      value.tool_call_shape.item_id_present ||= next.tool_call_shape.item_id_present;
      value.tool_call_shape.call_id_present ||= next.tool_call_shape.call_id_present;
      value.tool_call_shape.name_present ||= next.tool_call_shape.name_present;
      value.tool_call_shape.arguments_present ||= next.tool_call_shape.arguments_present;
      value.tool_call_shape.item_done ||= next.tool_call_shape.item_done;
      value.tool_call_shape.arguments_done ||= next.tool_call_shape.arguments_done;
      // Safe counters only. One request may parse at most one response body,
      // so the largest observation wins over a partial earlier snapshot.
      value.wire_event_count = Math.max(value.wire_event_count, next.wire_event_count);
      value.semantic_event_count = Math.max(value.semantic_event_count, next.semantic_event_count);
      value.coalesced_delta_count = Math.max(value.coalesced_delta_count, next.coalesced_delta_count);
    },
    snapshot(): OpenAISubscriptionRunDiagnostics {
      return Object.freeze({
        ...(value.terminal_event === undefined ? {} : { terminal_event: value.terminal_event }),
        event_types: Object.freeze([...value.event_types]),
        response_completed: value.response_completed,
        usage_present: value.usage_present,
        server_model_present: value.server_model_present,
        request_id_present: value.request_id_present,
        observed_text: value.observed_text,
        observed_tool_call: value.observed_tool_call,
        tool_call_shape: Object.freeze({ ...value.tool_call_shape }),
        wire_event_count: value.wire_event_count,
        semantic_event_count: value.semantic_event_count,
        coalesced_delta_count: value.coalesced_delta_count,
        ...(value.http_status === undefined ? {} : { http_status: value.http_status }),
        ...(value.content_type === undefined ? {} : { content_type: value.content_type }),
        ...(value.failure === undefined ? {} : { failure: value.failure }),
      });
    },
  };
  return value;
}

function safeContentType(value: string | null): string | undefined {
  if (value === null || value.length === 0 || value.length > 256 || hasControlCharacters(value)) return undefined;
  return value;
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

function hasRequestIdHeader(headers: Headers): boolean {
  return headers.has('x-request-id') || headers.has('request-id') || headers.has('openai-request-id');
}

function safeHttpDetail(body: string, exactCredentials: readonly string[]): string | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(redactSecrets(body, exactCredentials)); }
  catch { return undefined; }
  const root = asRecord(parsed);
  const response = asRecord(root?.['response']);
  const error = asRecord(response?.['error']) ?? asRecord(root?.['error']);
  if (!error) return undefined;
  const code = typeof error['code'] === 'string' ? redactSecrets(error['code'], exactCredentials).replaceAll(/[^A-Za-z0-9_.-]/gu, '_').slice(0, 128) : undefined;
  const message = typeof error['message'] === 'string'
    ? Array.from(redactSecrets(error['message'], exactCredentials), (character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f ? ' ' : character;
    }).join('').slice(0, 512)
    : undefined;
  if (code === undefined && message === undefined) return undefined;
  return [code, message].filter((part): part is string => part !== undefined && part.length > 0).join(': ');
}

function createBoundedRequestScope(
  timeoutMs: number,
  signals: readonly (AbortSignal | undefined)[],
): BoundedRequestScope {
  const controller = new AbortController();
  let reason: RequestAbortReason | undefined;
  let disposed = false;
  const subscriptions: Array<{ readonly signal: AbortSignal; readonly listener: () => void }> = [];
  const abort = (nextReason: RequestAbortReason): void => {
    if (reason !== undefined) return;
    reason = nextReason;
    controller.abort();
  };

  for (const signal of signals) {
    if (signal === undefined) continue;
    if (signal.aborted) {
      abort('aborted');
      break;
    }
    const listener = (): void => abort('aborted');
    signal.addEventListener('abort', listener, { once: true });
    subscriptions.push({ signal, listener });
    // An abort can race the check above before the listener is installed.
    if (signal.aborted) abort('aborted');
    if (reason !== undefined) break;
  }

  const timer = reason === undefined ? setTimeout(() => abort('timeout'), timeoutMs) : undefined;
  const abortError = (): SubscriptionFailure => reason === 'timeout'
    ? failure('TIMED_OUT', 'The GPT subscription request timed out.', true)
    : failure('ABORTED', 'The GPT subscription request was aborted.', false);

  return {
    signal: controller.signal,
    throwIfAborted: () => {
      if (controller.signal.aborted) throw abortError();
    },
    abortError,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      for (const subscription of subscriptions) {
        subscription.signal.removeEventListener('abort', subscription.listener);
      }
    },
  };
}

/** Race an arbitrary promise against the whole-request scope. The source
 * promise still receives rejection handlers after the scope settles so a late
 * fetch, refresh, or store operation cannot become an unhandled rejection. */
function awaitWithRequestScope<T>(
  source: PromiseLike<T>,
  scope: BoundedRequestScope,
): Promise<T> {
  scope.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => scope.signal.removeEventListener('abort', onAbort);
    const settleResolve = (value: T): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (scope.signal.aborted) {
        reject(scope.abortError());
      } else {
        resolve(value);
      }
    };
    const settleReject = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(scope.abortError());
    };
    scope.signal.addEventListener('abort', onAbort, { once: true });
    if (scope.signal.aborted) {
      onAbort();
      return;
    }
    // Attach both handlers immediately. If the scope rejects first, a late
    // source rejection is observed and ignored by settleReject.
    Promise.resolve(source).then(settleResolve, settleReject);
  });
}

interface ReaderCancellation {
  cancelled: boolean;
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>, state: ReaderCancellation): void {
  if (state.cancelled) return;
  state.cancelled = true;
  try {
    void Promise.resolve(reader.cancel()).catch(() => undefined);
  } catch {
    // Cancellation is best effort. The request scope already owns settlement.
  }
}

function readWithRequestScope(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  scope: BoundedRequestScope,
  cancellation: ReaderCancellation,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  scope.throwIfAborted();
  return new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => scope.signal.removeEventListener('abort', onAbort);
    const settleResolve = (value: ReadableStreamReadResult<Uint8Array>): void => {
      if (settled) return;
      if (scope.signal.aborted) {
        onAbort();
        return;
      }
      settled = true;
      cleanup();
      resolve(value);
    };
    const settleReject = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cancelReader(reader, cancellation);
      cleanup();
      reject(scope.abortError());
    };
    scope.signal.addEventListener('abort', onAbort, { once: true });
    if (scope.signal.aborted) {
      onAbort();
      return;
    }
    // Promise.resolve().then also turns an unexpected synchronous reader
    // throw into a handled rejection.
    Promise.resolve().then(() => reader.read()).then(settleResolve, settleReject);
  });
}

function cancelResponseBody(response: Response): void {
  if (!response.body) return;
  try {
    const reader = response.body.getReader();
    void Promise.resolve(reader.cancel()).catch(() => undefined);
  } catch {
    // A locked or already-consumed body needs no further cleanup here.
  }
}

async function readBoundedBody(response: Response, maxBytes: number, scope: BoundedRequestScope): Promise<string> {
  if (scope.signal.aborted) {
    cancelResponseBody(response);
    scope.throwIfAborted();
  }
  if (!response.body) return '';
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = response.body.getReader();
  } catch {
    throw failure('NETWORK_ERROR', 'The GPT subscription response body could not be read.', true);
  }
  const cancellation: ReaderCancellation = { cancelled: false };
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let total = 0;
  let output = '';
  try {
    for (;;) {
      const chunk = await readWithRequestScope(reader, scope, cancellation);
      if (chunk.done) {
        scope.throwIfAborted();
        return output + decoder.decode();
      }
      scope.throwIfAborted();
      total += chunk.value.byteLength;
      if (total > maxBytes) {
        cancelReader(reader, cancellation);
        throw failure('OUTPUT_LIMIT', 'The GPT subscription response exceeded the byte limit.', false);
      }
      try {
        output += decoder.decode(chunk.value, { stream: true });
      } catch {
        if (scope.signal.aborted) throw scope.abortError();
        cancelReader(reader, cancellation);
        throw failure('INVALID_RESPONSE', 'The GPT subscription response was not valid UTF-8.', false);
      }
    }
  } catch (error) {
    if (scope.signal.aborted) {
      cancelReader(reader, cancellation);
      throw scope.abortError();
    }
    if (error instanceof SubscriptionFailure) throw error;
    cancelReader(reader, cancellation);
    throw failure('NETWORK_ERROR', 'The GPT subscription response body could not be read.', true);
  }
}

/**
 * Consume a Responses body incrementally.  SSE requests are finalized as soon
 * as a terminal event is observed and the underlying reader is cancelled; an
 * open TCP connection after `response.completed` therefore cannot hold a run
 * open until EOF.  JSON responses retain the bounded body behavior because a
 * JSON document has no independent terminal frame.
 */
async function readCodexResponse(
  response: Response,
  maxBytes: number,
  scope: BoundedRequestScope,
  exactCredentials: readonly string[],
  onSummary?: (summary:string)=>void,
): Promise<CodexResponsesParseResult> {
  if (scope.signal.aborted) {
    cancelResponseBody(response);
    scope.throwIfAborted();
  }
  if (!response.body) return parseCodexResponses('', exactCredentials);
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = response.body.getReader();
  } catch {
    throw failure('NETWORK_ERROR', 'The GPT subscription response body could not be read.', true);
  }
  const cancellation: ReaderCancellation = { cancelled: false };
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  let mode: 'unknown' | 'sse' | 'json' = contentType.includes('text/event-stream') ? 'sse' : 'unknown';
  let sse = mode === 'sse' ? createCodexResponsesStreamParser(exactCredentials,onSummary) : undefined;
  let prefix = '';
  let body = '';
  let total = 0;
  const selectMode = (): void => {
    if (mode !== 'unknown' || prefix.trim().length === 0) return;
    const trimmed = prefix.trimStart();
    if (trimmed.startsWith('data:') || trimmed.startsWith('event:') || trimmed.startsWith(':')) {
      mode = 'sse';
      sse = createCodexResponsesStreamParser(exactCredentials,onSummary);
      sse.push(prefix);
      prefix = '';
      return;
    }
    // A provider chunk can split the first SSE marker (`data:` or `event:`)
    // between bytes. Do not commit to JSON while the bounded prefix is still
    // a valid partial marker; wait for the next chunk to disambiguate.
    if ('data:'.startsWith(trimmed) || 'event:'.startsWith(trimmed)) return;
    mode = 'json';
    body = prefix;
    prefix = '';
  };
  try {
    for (;;) {
      const chunk = await readWithRequestScope(reader, scope, cancellation);
      if (chunk.done) {
        scope.throwIfAborted();
        let tail: string;
        try {
          tail = decoder.decode();
        } catch {
          cancelReader(reader, cancellation);
          throw failure('INVALID_RESPONSE', 'The GPT subscription response was not valid UTF-8.', false);
        }
        if (mode === 'sse') {
          sse?.push(tail);
          return sse?.finish() ?? parseCodexResponses('', exactCredentials);
        }
        if (mode === 'unknown') {
          prefix += tail;
          selectMode();
          if (sse !== undefined) return sse.finish();
          body = prefix;
        } else body += tail;
        return parseCodexResponses(body, exactCredentials);
      }
      scope.throwIfAborted();
      total += chunk.value.byteLength;
      if (total > maxBytes) {
        cancelReader(reader, cancellation);
        throw failure('OUTPUT_LIMIT', 'The GPT subscription response exceeded the byte limit.', false);
      }
      let text: string;
      try {
        text = decoder.decode(chunk.value, { stream: true });
      } catch {
        if (scope.signal.aborted) throw scope.abortError();
        cancelReader(reader, cancellation);
        throw failure('INVALID_RESPONSE', 'The GPT subscription response was not valid UTF-8.', false);
      }
      if (mode === 'sse') {
        sse?.push(text);
      } else if (mode === 'unknown') {
        prefix += text;
        if (Buffer.byteLength(prefix, 'utf8') > maxBytes) {
          cancelReader(reader, cancellation);
          throw failure('OUTPUT_LIMIT', 'The GPT subscription response exceeded the byte limit.', false);
        }
        selectMode();
      } else {
        body += text;
      }
      if (mode === 'sse' && sse?.terminal) {
        cancelReader(reader, cancellation);
        return sse.result();
      }
    }
  } catch (error) {
    if (scope.signal.aborted) {
      cancelReader(reader, cancellation);
      throw scope.abortError();
    }
    if (error instanceof SubscriptionFailure || error instanceof CodexResponsesParseError) {
      cancelReader(reader, cancellation);
      throw error;
    }
    cancelReader(reader, cancellation);
    throw failure('NETWORK_ERROR', 'The GPT subscription response body could not be read.', true);
  }
}

function assertByteLimit(value: number, maximum: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`${name} must be a positive safe integer no greater than ${maximum}.`);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export { DEFAULT_BASE_URL, DEFAULT_ORIGINATOR, DEFAULT_USER_AGENT };
