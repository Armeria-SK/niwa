import Anthropic from '@anthropic-ai/sdk';
import type { BetaContentBlock, BetaContentBlockParam, BetaMessage, BetaMessageParam, BetaMessageStreamParams, BetaToolResultBlockParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { ModelInfo } from '@anthropic-ai/sdk/resources/models';
import { createHash, randomUUID } from 'node:crypto';
import { Value } from '@sinclair/typebox/value';
import type { JsonObject, ModelAdapterCapabilities, ModelEvent, ModelMessage, ModelRequest, ReasoningEffort } from '../../contracts/index.ts';
import { isPlainJsonValue, modelRequestSchema } from '../../contracts/index.ts';
import { createProgressModelEventStream, emitModelDelta, type ModelAdapter, type ModelEventStream, type ModelRunOptions } from '../shared/adapter.ts';
import { containsExactCredentialMaterial, containsSensitiveJsonKey, sanitizeModelRequestTextFields } from '../shared/input-safety.ts';
import type { EndpointSlot } from '../shared/limiter.ts';
import { ModelSetupError } from '../shared/setup-error.ts';
import { redactSecrets } from '../../shared/redaction.ts';

/** The only endpoint the stored key is ever sent to. Tests replace the transport (fetch), never this URL. */
export const ANTHROPIC_ORIGIN = 'https://api.anthropic.com';
export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5';
type Failure = Extract<ModelEvent, { type: 'failed' }>['error'];
type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const NAME = 'Claude（Anthropic API）';
/** Models that accept `fallbacks: "default"`; other models reject the parameter or have no server-side fallback. */
const FALLBACK_MODELS: ReadonlySet<string> = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5-5']);
const FALLBACK_BETA = 'server-side-fallback-2026-07-01', BINDING_BETA = 'thinking-binding-controls-2026-08-01';
const MAX_OUTPUT_TOKENS = 64_000, MAX_STREAM_BYTES = 8 * 1024 * 1024, MAX_REPLAY_TURNS = 32;
const MESSAGES = {
  auth: `${NAME}がAPIキーを受け付けませんでした。「設定」→「モデルと接続」でキーを確認してください。`,
  permission: 'このAPIキーの組織では選択したモデルや機能を利用できません。Claude Consoleで組織の権限を確認してください。',
  not_found: `${NAME}で選択したモデルが見つかりません。モデル一覧を取得し直して選んでください。`,
  request: `${NAME}が要求を受け付けませんでした。モデルの選択と会話の長さを確認してください。`,
  quota: `${NAME}のクレジットまたは利用枠が不足しています。Claude Consoleの請求設定を確認してください。`,
  rate: `${NAME}の利用制限に達しました。時間をおいて再確認します。`,
  unavailable: `${NAME}が一時的に混み合っているか応答できません。時間をおいて再確認します。`,
  timeout: `${NAME}の応答が時間内に完了しませんでした。`,
  network: `${NAME}へ接続できませんでした。ネットワークを確認してください。`,
  invalid: `${NAME}の応答を読み取れませんでした。`,
  aborted: `${NAME}への要求を中断しました。`,
  capability: `${NAME}のモデルではこの設定を使えません。`,
  credential: `会話や指示にAPIキーと同じ文字列が含まれているため、${NAME}へ送信しませんでした。`,
  refusal: 'Claudeが安全上の理由でこの依頼への応答を控えました（切替先のモデルでも応答できませんでした）。依頼の内容を見直してください。',
  truncated: `${NAME}の応答が出力の上限で途中まで止まったため、ツール操作を実行しませんでした。依頼を小さく分けてください。`,
  context: `${NAME}のモデルが扱える文脈の長さを超えました。会話を短くしてください。`,
} as const;

class LocalError extends Error { constructor(readonly failure: Failure) { super('Anthropic local failure'); } }
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
/** Retry-After in seconds or as an HTTP date, bounded to one day ahead. */
function retryAfter(headers: Headers | undefined, now = Date.now()): number | undefined {
  const value = headers?.get('retry-after')?.trim();
  if (!value || value.length > 64) return undefined;
  const at = /^\d+$/u.test(value) ? now + Number(value) * 1000 : Date.parse(value);
  if (!Number.isFinite(at) || at <= now) return undefined;
  return Math.ceil(Math.min(at, now + 86_400_000) / 1000);
}
/** SDK error classes, most specific first. Messages are fixed Japanese text: SDK messages may quote response bodies. */
export function anthropicFailure(error: unknown, sent: boolean, timedOut = false): Failure {
  const base = { provider_request_sent: sent, origin: 'provider' as const };
  if (error instanceof LocalError) return error.failure;
  if (error instanceof ModelSetupError) return error.failure;
  if (error instanceof Anthropic.APIUserAbortError) return timedOut ? { code: 'TIMED_OUT', retryable: true, message: MESSAGES.timeout, origin: 'transport', provider_request_sent: sent }
    : { code: 'ABORTED', retryable: false, message: MESSAGES.aborted, origin: 'local', provider_request_sent: sent };
  if (error instanceof Anthropic.APIConnectionTimeoutError) return { code: 'TIMED_OUT', retryable: true, message: MESSAGES.timeout, origin: 'transport', provider_request_sent: sent };
  if (error instanceof Anthropic.APIConnectionError) return { code: 'NETWORK_ERROR', retryable: true, message: MESSAGES.network, origin: 'transport', provider_request_sent: sent };
  if (error instanceof Anthropic.AuthenticationError) return { ...base, code: 'AUTHENTICATION_FAILED', retryable: false, message: MESSAGES.auth };
  if (error instanceof Anthropic.PermissionDeniedError) return { ...base, code: 'PERMISSION_DENIED', retryable: false, message: MESSAGES.permission };
  if (error instanceof Anthropic.NotFoundError) return { ...base, code: 'INVALID_REQUEST', retryable: false, message: MESSAGES.not_found };
  if (error instanceof Anthropic.BadRequestError) return { ...base, code: 'INVALID_REQUEST', retryable: false, message: MESSAGES.request };
  if (error instanceof Anthropic.RateLimitError) { const reset = retryAfter(error.headers); return { ...base, code: 'RATE_LIMITED', retryable: true, message: MESSAGES.rate, ...(reset === undefined ? {} : { reset_at: reset }) }; }
  // 529 overloaded and other 5xx; also reached by errors reported inside an open stream.
  if (error instanceof Anthropic.InternalServerError) { const reset = retryAfter(error.headers); return { ...base, code: 'PROVIDER_UNAVAILABLE', retryable: true, message: MESSAGES.unavailable, ...(reset === undefined ? {} : { reset_at: reset }) }; }
  if (error instanceof Anthropic.APIError) {
    if (error.status === 402 || error.type === 'billing_error') return { ...base, code: 'QUOTA_EXCEEDED', retryable: true, message: MESSAGES.quota };
    if (error.type === 'rate_limit_error') return { ...base, code: 'RATE_LIMITED', retryable: true, message: MESSAGES.rate };
    if (error.type === 'overloaded_error' || error.type === 'api_error' || error.status === undefined) return { ...base, code: 'PROVIDER_UNAVAILABLE', retryable: true, message: MESSAGES.unavailable };
    if (error.status === 408) return { ...base, code: 'TIMED_OUT', retryable: true, message: MESSAGES.timeout };
    if (error.status >= 500) return { ...base, code: 'PROVIDER_UNAVAILABLE', retryable: true, message: MESSAGES.unavailable };
    return { ...base, code: 'INVALID_REQUEST', retryable: false, message: MESSAGES.request };
  }
  return { ...base, code: 'INVALID_RESPONSE', retryable: false, message: MESSAGES.invalid };
}

/** The key, URL and auth mode are fixed here, so ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL and credential profiles never apply. */
function client(apiKey: string, fetchImpl: typeof fetch, timeout: number): Anthropic {
  return new Anthropic({ apiKey, authToken: null, baseURL: ANTHROPIC_ORIGIN, maxRetries: 0, timeout, fetch: fetchImpl, logLevel: 'off', webhookKey: null });
}

export interface AnthropicModel {
  readonly id: string; readonly display_name: string; readonly created_at: string;
  /** Adaptive thinking (and with it thinking-block replay) is used only where the model advertises it. */
  readonly adaptive: boolean; readonly efforts: readonly Effort[]; readonly max_tokens: number;
  /** Context window in tokens when the Models API reports it. */
  readonly context_window?: number;
}
const safeText = (value: unknown, max: number): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/u.test(value);
type ListedModel = Pick<ModelInfo, 'id' | 'display_name' | 'created_at'> & { readonly capabilities?: unknown; readonly max_tokens?: number | null; readonly max_input_tokens?: number | null };
export function anthropicModelProfile(info: ListedModel): AnthropicModel {
  const caps = isRecord(info.capabilities) ? info.capabilities as Record<string, Record<string, unknown> | null | undefined> : null;
  const supported = (value: unknown) => isRecord(value) && value.supported === true;
  // Models listed without capability data are treated as current models.
  const adaptive = caps ? supported((caps.thinking?.types as Record<string, unknown> | undefined)?.adaptive) : true;
  const efforts = caps ? (supported(caps.effort) ? EFFORTS.filter(effort => supported(caps.effort?.[effort])) : []) : [...EFFORTS];
  const limit = Number.isSafeInteger(info.max_tokens) && Number(info.max_tokens) > 0 ? Number(info.max_tokens) : MAX_OUTPUT_TOKENS;
  return Object.freeze({ id: info.id, display_name: safeText(info.display_name, 256) ? info.display_name : info.id, created_at: typeof info.created_at === 'string' ? info.created_at : '',
    adaptive, efforts: Object.freeze(efforts), max_tokens: Math.min(MAX_OUTPUT_TOKENS, limit),
    ...(Number.isSafeInteger(info.max_input_tokens) && Number(info.max_input_tokens) > 0 ? { context_window: Number(info.max_input_tokens) } : {}) });
}
/** Profile for a typed model id the list did not include (only when listing failed). */
export const unlistedAnthropicModel = (id: string): AnthropicModel => Object.freeze({ id, display_name: id, created_at: '', adaptive: true, efforts: EFFORTS, max_tokens: MAX_OUTPUT_TOKENS });

/** Models API only, so listing is never billed. Newest first; retired models are left out. */
export async function listAnthropicModels(apiKey: string, fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<AnthropicModel[]> {
  const models = new Map<string, AnthropicModel>();
  try {
    let seen = 0;
    for await (const info of client(apiKey, fetchImpl, 15_000).models.list({ limit: 100 }, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) })) {
      if (++seen > 1000) throw new LocalError({ code: 'INVALID_RESPONSE', retryable: false, message: MESSAGES.invalid, origin: 'provider', provider_request_sent: true });
      if (!isRecord(info) || !safeText(info.id, 256) || (info as { lifecycle?: unknown }).lifecycle === 'retired') continue;
      models.set(info.id, anthropicModelProfile(info));
    }
  } catch (error) { throw new ModelSetupError(anthropicFailure(error, true, !signal?.aborted)); }
  return [...models.values()].sort((left, right) => (Date.parse(right.created_at) || 0) - (Date.parse(left.created_at) || 0) || left.id.localeCompare(right.id, 'en'));
}

export interface AnthropicConnection {
  readonly apiKey: string;
  readonly fetch?: typeof fetch;
  readonly slot?: EndpointSlot;
  readonly queueMs?: number;
  /** Ask for summarized thinking and show it as the reasoning summary (installation setting `reasoningSummary`). */
  readonly summary?: boolean;
}
interface StoredTurn { readonly key: string; readonly content: readonly BetaContentBlockParam[] }
const TOOL_ID = /^[A-Za-z0-9_-]{1,128}$/u;
/** Anthropic tool ids allow fewer characters than Niwa's; a deterministic mapping keeps tool_use and tool_result paired. */
const toolId = (id: string) => TOOL_ID.test(id) ? id : `toolu_niwa_${createHash('sha256').update(id).digest('hex').slice(0, 32)}`;
const turnKey = (text: string, calls: readonly { tool_call_id: string; name: string; arguments: unknown }[]) =>
  JSON.stringify([text, calls.map(call => [call.tool_call_id, call.name, call.arguments])]);

/**
 * Messages API with Niwa-owned tools, streamed so long outputs never hit a non-streaming timeout.
 * Thinking blocks are provider-private continuation: each adapter instance keeps the blocks of the turns it produced (memory only)
 * and replays them verbatim, with their signatures, when the same assistant turn comes back in the history. The gateway creates a
 * fresh adapter whenever Niwa rebuilds or trims context, and `drop_block` lets the API discard blocks whose prefix changed instead of failing.
 */
export class AnthropicAdapter implements ModelAdapter {
  readonly adapter_id = 'anthropic';
  readonly capabilities: ModelAdapterCapabilities = Object.freeze({
    execution_mode: 'model_api', auth_mode: 'api_key', billing_mode: 'api_usage', owns_agent_loop: false,
    supports_niwa_tool_loop: true, supports_tool_calls: true, supports_structured_output: false,
    supports_streaming: true, supports_session_resume: false, supports_parallel_sessions: true, supports_usage_reporting: true,
  });
  readonly supported_efforts: readonly ReasoningEffort[];
  readonly context_window?: number;
  readonly #model: AnthropicModel;
  readonly #key: string;
  readonly #fetch: typeof fetch;
  readonly #slot: EndpointSlot | undefined;
  readonly #queueMs: number;
  readonly #summary: boolean;
  #turns: StoredTurn[] = [];
  constructor(connection: AnthropicConnection, model: AnthropicModel) {
    if (!safeText(model.id, 256)) throw new Error('Invalid Anthropic model');
    this.#model = model; this.#key = connection.apiKey; this.#fetch = connection.fetch ?? fetch;
    this.#slot = connection.slot; this.#queueMs = connection.queueMs ?? 600_000; this.#summary = connection.summary === true;
    this.supported_efforts = Object.freeze(model.efforts.length ? ['minimal', ...model.efforts] as ReasoningEffort[] : []);
    if (model.context_window !== undefined) this.context_window = model.context_window;
  }
  run(request: ModelRequest, options: ModelRunOptions): ModelEventStream {
    const cancellation = new AbortController();
    return createProgressModelEventStream(emit => this.#run(request, options, cancellation.signal, emit), () => cancellation.abort());
  }
  /** Niwa effort → output_config.effort; `minimal` has no API equivalent, and an unsupported level steps down to the nearest one. */
  #effort(requested: ReasoningEffort | undefined): Effort | undefined {
    const supported = this.#model.efforts;
    if (!supported.length) return undefined;
    // The API default differs per model (medium on Claude Opus 5.5), so the level is always sent explicitly.
    const wanted: Effort = requested === undefined ? 'medium' : requested === 'minimal' ? 'low' : requested;
    for (let index = EFFORTS.indexOf(wanted); index >= 0; index--) if (supported.includes(EFFORTS[index]!)) return EFFORTS[index]!;
    return supported[0];
  }
  #messages(messages: readonly ModelMessage[]): BetaMessageParam[] {
    const out: BetaMessageParam[] = [];
    const user = (): BetaContentBlockParam[] => {
      const last = out.at(-1);
      if (last?.role === 'user' && Array.isArray(last.content)) return last.content;
      const content: BetaContentBlockParam[] = []; out.push({ role: 'user', content }); return content;
    };
    let pending = new Set<string>();
    for (const message of messages) {
      if (message.role === 'assistant') {
        if (pending.size) pending = this.#answerMissing(user(), pending);
        const calls = message.tool_calls ?? [], text = message.content ?? '';
        const stored = calls.length ? this.#turns.find(turn => turn.key === turnKey(text, calls)) : undefined;
        const content: BetaContentBlockParam[] = stored ? [...stored.content]
          : [...(text ? [{ type: 'text' as const, text }] : []), ...calls.map(call => ({ type: 'tool_use' as const, id: toolId(call.tool_call_id), name: call.name, input: call.arguments }))];
        if (!content.length) continue;
        if (!out.length) out.push({ role: 'user', content: [{ type: 'text', text: '（会話の開始）' }] });
        out.push({ role: 'assistant', content });
        pending = new Set(calls.map(call => toolId(call.tool_call_id)));
        continue;
      }
      const blocks = user();
      if (message.role === 'tool' && pending.has(toolId(message.tool_call_id))) {
        pending.delete(toolId(message.tool_call_id));
        // tool_result blocks must precede any text in the same user turn.
        const at = blocks.findIndex(block => block.type !== 'tool_result');
        const result: BetaToolResultBlockParam = { type: 'tool_result', tool_use_id: toolId(message.tool_call_id), content: message.content || '（結果なし）' };
        if (at < 0) blocks.push(result); else blocks.splice(at, 0, result);
      } else {
        // A result whose call is no longer in the history is kept as plain data.
        const text = message.role === 'tool' ? JSON.stringify({ tool_result: message.name, content: message.content }) : message.content;
        blocks.push({ type: 'text', text: text || '（空）' });
      }
      if (pending.size && message.role !== 'tool') pending = this.#answerMissing(blocks, pending);
    }
    if (pending.size) this.#answerMissing(user(), pending);
    if (!out.length) out.push({ role: 'user', content: [{ type: 'text', text: '（会話の開始）' }] });
    return out;
  }
  /** Every tool_use needs a tool_result in the next user turn; calls Niwa did not run are reported as not executed. */
  #answerMissing(blocks: BetaContentBlockParam[], pending: Set<string>): Set<string> {
    const at = blocks.findIndex(block => block.type !== 'tool_result');
    const missing = [...pending].map((id): BetaToolResultBlockParam => ({ type: 'tool_result', tool_use_id: id, is_error: true, content: 'このツール呼び出しは実行されませんでした。' }));
    blocks.splice(at < 0 ? blocks.length : at, 0, ...missing);
    return new Set();
  }
  async #run(request: ModelRequest, options: ModelRunOptions, cancel: AbortSignal, emit: (event: ModelEvent) => void): Promise<readonly ModelEvent[]> {
    const secrets = [this.#key];
    const fail = (error: Failure): ModelEvent[] => [{ type: 'failed', error: { ...error, message: redactSecrets(error.message, secrets) } }];
    if (!Value.Check(modelRequestSchema, request) || !isPlainJsonValue(request, { max_depth: 32, max_nodes: 10_000, max_bytes: 4 * 1024 * 1024 })
      || !Number.isSafeInteger(options.timeout_ms) || options.timeout_ms < 1 || options.timeout_ms > 2_147_483_647) {
      return fail({ code: 'INVALID_REQUEST', retryable: false, message: MESSAGES.request, provider_request_sent: false });
    }
    if (request.response_contract.type !== 'text') return fail({ code: 'CAPABILITY_MISMATCH', retryable: false, message: MESSAGES.capability, provider_request_sent: false });
    const safe = sanitizeModelRequestTextFields(request).request;
    const model = this.#model.id, effort = this.#effort(request.reasoning_effort), fallback = FALLBACK_MODELS.has(model);
    const betas = [...(this.#model.adaptive ? [BINDING_BETA] : []), ...(fallback ? [FALLBACK_BETA] : [])];
    const body: BetaMessageStreamParams = {
      model, max_tokens: this.#model.max_tokens,
      // Niwa rebuilds the system text per step from task state; identical text within a task stays byte-stable for caching.
      system: safe.system_instructions, messages: this.#messages(safe.messages),
      // Automatic prompt caching of the longest stable prefix.
      cache_control: { type: 'ephemeral' },
      // Forced tool_choice is a 400 on current models, so tools are always offered with `auto`. eager_input_streaming stays off
      // so the API keeps validating tool input before streaming it; Niwa runs a call only after the whole message is checked.
      ...(safe.tools.length ? { tools: safe.tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.input_schema as { type: 'object'; [key: string]: unknown } })), tool_choice: { type: 'auto' as const } } : {}),
      // Niwa's history is not append-only (work state and trimming change between steps), so a mismatched thinking block is dropped instead of failing.
      ...(this.#model.adaptive ? { thinking: { type: 'adaptive' as const, ...(this.#summary ? { display: 'summarized' as const } : {}), block_binding: { prefix_mismatch_behavior: 'drop_block' as const } } } : {}),
      ...(effort ? { output_config: { effort } } : {}),
      // On a safety decline the API reruns the request on the model Anthropic recommends for that category.
      ...(fallback ? { fallbacks: 'default' as const } : {}),
      ...(betas.length ? { betas } : {}),
    };
    // The key is sent only as a header; never inside the conversation payload.
    if (containsExactCredentialMaterial(body, secrets)) return fail({ code: 'INVALID_REQUEST', retryable: false, message: MESSAGES.credential, provider_request_sent: false });
    let release: (() => void) | undefined; let sent = false; let timedOut = false;
    const deadline = new AbortController();
    const signal = AbortSignal.any([cancel, deadline.signal, ...(options.signal ? [options.signal] : [])]);
    try {
      if (this.#slot) {
        const wait = AbortSignal.timeout(this.#queueMs);
        try { release = await this.#slot(AbortSignal.any([wait, cancel, ...(options.signal ? [options.signal] : [])])); }
        catch { return fail(options.signal?.aborted || cancel.aborted ? { code: 'ABORTED', retryable: false, message: MESSAGES.aborted, origin: 'local', provider_request_sent: false }
          : { code: 'TIMED_OUT', retryable: true, message: MESSAGES.timeout, origin: 'local', provider_request_sent: false }); }
      }
      const timer = setTimeout(() => { timedOut = true; deadline.abort(); }, options.timeout_ms);
      try {
        sent = true;
        const stream = client(this.#key, this.#fetch, options.timeout_ms).beta.messages.stream(body, { signal });
        const tools = new Map<number, { id: string; name: string }>(); let bytes = 0;
        for await (const event of stream) {
          if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') tools.set(event.index, { id: event.content_block.id, name: event.content_block.name });
          if (event.type !== 'content_block_delta') continue;
          const delta = event.delta;
          const size = delta.type === 'text_delta' ? delta.text.length : delta.type === 'input_json_delta' ? delta.partial_json.length : delta.type === 'thinking_delta' ? delta.thinking.length : 0;
          if ((bytes += size) > MAX_STREAM_BYTES) { stream.abort(); throw new LocalError({ code: 'INVALID_RESPONSE', retryable: false, message: MESSAGES.invalid, origin: 'provider', provider_request_sent: true }); }
          // Display-only partial output; results come only from the validated final message.
          if (delta.type === 'text_delta') emitModelDelta(options, { channel: 'text', delta: delta.text });
          else if (delta.type === 'input_json_delta') { const tool = tools.get(event.index); if (tool) emitModelDelta(options, { channel: 'tool_arguments', call_id: tool.id.slice(0, 256), ...(safeText(tool.name, 128) ? { name: tool.name } : {}), delta: delta.partial_json }); }
          else if (delta.type === 'thinking_delta' && this.#summary && delta.thinking) emit({ type: 'reasoning_summary', summary: delta.thinking.slice(0, 4000) });
        }
        const message = await stream.finalMessage();
        return this.#parse(message, request.budget.max_tool_calls).map(event => event.type === 'failed' ? fail(event.error)[0]! : event);
      } finally { clearTimeout(timer); }
    } catch (error) {
      return fail(anthropicFailure(error, sent, timedOut));
    } finally { release?.(); }
  }
  #parse(message: BetaMessage, maxToolCalls: number): ModelEvent[] {
    const invalid = () => new LocalError({ code: 'INVALID_RESPONSE', retryable: false, message: MESSAGES.invalid, origin: 'provider', provider_request_sent: true });
    const failed = (code: Failure['code'], text: string): ModelEvent[] => [{ type: 'failed', error: { code, retryable: false, message: text, origin: 'provider', provider_request_sent: true } }];
    if (!isRecord(message) || !Array.isArray(message.content)) throw invalid();
    // The stop reason decides first: a refused or truncated message may carry partial content that must never run.
    if (message.stop_reason === 'refusal') return failed('PROVIDER_ERROR', MESSAGES.refusal);
    if (message.stop_reason === 'max_tokens') return failed('OUTPUT_LIMIT', MESSAGES.truncated);
    if (message.stop_reason === 'model_context_window_exceeded') return failed('OUTPUT_LIMIT', MESSAGES.context);
    if (message.stop_reason !== 'end_turn' && message.stop_reason !== 'tool_use' && message.stop_reason !== 'stop_sequence') throw invalid();
    // After a mid-output fallback, only text blocks before the last switch point belong to the answer.
    const boundary = message.content.reduce((last, block, index) => block.type === 'fallback' ? index : last, -1);
    const blocks = message.content.filter((block, index) => index > boundary || block.type === 'text');
    const replay: BetaContentBlockParam[] = []; const events: ModelEvent[] = []; const ids = new Set<string>();
    let text = '';
    const calls: { tool_call_id: string; name: string; arguments: JsonObject }[] = [];
    for (const block of blocks as BetaContentBlock[]) {
      if (block.type === 'thinking') {
        if (typeof block.thinking !== 'string' || typeof block.signature !== 'string') throw invalid();
        // Replayed exactly as received; never edited.
        replay.push({ type: 'thinking', thinking: block.thinking, signature: block.signature });
      } else if (block.type === 'redacted_thinking') {
        if (typeof block.data !== 'string') throw invalid();
        replay.push({ type: 'redacted_thinking', data: block.data });
      } else if (block.type === 'text') {
        if (typeof block.text !== 'string') throw invalid();
        text += block.text; if (block.text) replay.push({ type: 'text', text: block.text });
      } else if (block.type === 'tool_use') {
        const input: unknown = block.input;
        if (!safeText(block.name, 128) || !isRecord(input) || !isPlainJsonValue(input, { max_depth: 16, max_nodes: 2000, max_bytes: 256_000 }) || containsSensitiveJsonKey(input)) throw invalid();
        let id = typeof block.id === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/u.test(block.id) ? block.id : randomUUID();
        if (ids.has(id)) id = randomUUID();
        ids.add(id);
        calls.push({ tool_call_id: id, name: block.name, arguments: input as JsonObject });
        replay.push({ type: 'tool_use', id: toolId(id), name: block.name, input });
      }
      // fallback markers and unknown block types are not part of the answer.
    }
    if (text.length > 4 * 1024 * 1024 || calls.length > maxToolCalls) throw invalid();
    if (text) events.push({ type: 'text_delta', text });
    for (const call of calls) events.push({ type: 'tool_call', ...call });
    const usage = message.usage;
    if (isRecord(usage) && Number.isSafeInteger(usage.input_tokens) && Number.isSafeInteger(usage.output_tokens)) {
      const cached = (Number(usage.cache_read_input_tokens) || 0) + (Number(usage.cache_creation_input_tokens) || 0);
      const input = Number(usage.input_tokens) + (Number.isSafeInteger(cached) && cached >= 0 ? cached : 0), output = Number(usage.output_tokens);
      if (input >= 0 && output >= 0) events.push({ type: 'usage', input_tokens: input, output_tokens: output, total_tokens: input + output });
    }
    if (calls.length) {
      this.#turns = [...this.#turns.filter(turn => turn.key !== turnKey(text, calls)), { key: turnKey(text, calls), content: Object.freeze(replay) }].slice(-MAX_REPLAY_TURNS);
    }
    events.push({ type: 'completed', finish_reason: calls.length ? 'tool_calls' : 'stop' });
    return events;
  }
}
