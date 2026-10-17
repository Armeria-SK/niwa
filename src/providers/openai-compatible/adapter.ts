import { randomUUID } from 'node:crypto';
import { Value } from '@sinclair/typebox/value';
import type { JsonObject, ModelAdapterCapabilities, ModelEvent, ModelRequest } from '../../contracts/index.ts';
import { hasImages, isPlainJsonValue, modelRequestSchema } from '../../contracts/index.ts';
import type { ModelAdapter, ModelRunOptions } from '../shared/adapter.ts';
import { containsExactCredentialMaterial, containsSensitiveJsonKey, sanitizeModelRequestTextFields } from '../shared/input-safety.ts';
import type { EndpointSlot } from '../shared/limiter.ts';
import { ModelSetupError } from '../shared/setup-error.ts';
import { redactSecrets } from '../../shared/redaction.ts';
import { compatibleUrl } from './url.ts';

type Failure = Extract<ModelEvent, { type: 'failed' }>['error'];
const NAME = 'OpenAI互換API';
const MESSAGES = {
  auth: `${NAME}がAPIキーを受け付けませんでした。「設定」→「モデルと接続」でキーを確認してください。`,
  permission: `このAPIキーでは選択したモデルを利用できません。接続先の管理画面で権限とモデルを確認してください。`,
  not_found: `${NAME}の接続先URLまたはモデルが見つかりません。URL（例: https://api.openai.com/v1）とモデルIDを確認してください。`,
  request: `${NAME}が要求を受け付けませんでした。モデルがツール呼び出し（tools）に対応しているか確認してください。`,
  quota: `${NAME}の残高または利用枠が不足しています。接続先の請求設定を確認してください。`,
  rate: `${NAME}の利用制限に達しました。時間をおいて再確認します。`,
  unavailable: `${NAME}の接続先が一時的に応答できません。時間をおいて再確認します。`,
  timeout: `${NAME}の応答が時間内に完了しませんでした。`,
  network: `${NAME}へ接続できませんでした。URLとネットワークを確認してください。`,
  invalid: `${NAME}の応答を読み取れませんでした。`,
  aborted: `${NAME}への要求を中断しました。`,
  capability: `${NAME}のモデルではこの設定を使えません。`,
  credential: `会話や指示にAPIキーと同じ文字列が含まれているため、${NAME}へ送信しませんでした。`,
} as const;

class TransportError extends Error {
  constructor(readonly kind: 'network' | 'timeout' | 'aborted' | 'invalid') { super(`OpenAI-compatible transport ${kind}`); }
}
interface Reply { readonly status: number; readonly headers: Headers; readonly body: unknown }

/** Bounded request. Response bodies, URLs and keys never become error text. */
async function exchange(url: URL, options: { apiKey?: string | undefined; body?: unknown; fetch: typeof fetch; timeoutMs: number; signal?: AbortSignal | undefined; maxBytes: number }): Promise<Reply> {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 2_147_483_647) throw new TransportError('invalid');
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, options.timeoutMs);
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  let onAbort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new TransportError(timedOut ? 'timeout' : 'aborted'));
    controller.signal.addEventListener('abort', onAbort, { once: true });
    if (controller.signal.aborted) onAbort();
  });
  cancelled.catch(() => undefined);
  const work = async (): Promise<Reply> => {
    controller.signal.throwIfAborted();
    const response = await options.fetch(url, {
      method: options.body === undefined ? 'GET' : 'POST', redirect: 'error', signal: controller.signal,
      headers: { Accept: 'application/json', ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}) },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    // Error bodies are only inspected for a provider error code.
    const limit = response.ok ? options.maxBytes : 64 * 1024;
    const reader = response.body?.getReader();
    if (!reader) return { status: response.status, headers: response.headers, body: undefined };
    const chunks: Uint8Array[] = []; let total = 0;
    try {
      for (;;) {
        const { done, value } = await Promise.race([reader.read(), cancelled]);
        if (done) break;
        total += value.length;
        if (total > limit) { if (response.ok) throw new TransportError('invalid'); break; }
        chunks.push(value);
      }
    } finally { void reader.cancel().catch(() => undefined); }
    let body: unknown;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { if (response.ok) throw new TransportError('invalid'); }
    return { status: response.status, headers: response.headers, body };
  };
  try { return await Promise.race([work(), cancelled]); }
  catch (error) { throw error instanceof TransportError ? error : new TransportError(controller.signal.aborted ? (timedOut ? 'timeout' : 'aborted') : 'network'); }
  finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); controller.signal.removeEventListener('abort', onAbort); }
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function providerErrorCode(body: unknown): string {
  const error = isRecord(body) && isRecord(body.error) ? body.error : undefined;
  const values = [error?.code, error?.type].filter((value): value is string => typeof value === 'string');
  return values.join(' ').slice(0, 256);
}
/** Retry-After in seconds or as an HTTP date, bounded to one day ahead. */
function retryAfter(headers: Headers, now = Date.now()): number | undefined {
  const value = headers.get('retry-after')?.trim();
  if (!value || value.length > 64) return undefined;
  const at = /^\d+$/u.test(value) ? now + Number(value) * 1000 : Date.parse(value);
  if (!Number.isFinite(at) || at <= now) return undefined;
  return Math.ceil(Math.min(at, now + 86_400_000) / 1000);
}
/** Trusted classification of an HTTP status. Never includes the response body. */
export function statusFailure(status: number, body: unknown, headers: Headers, sent = true): Failure {
  const base = { provider_request_sent: sent, origin: 'provider' as const };
  const code = providerErrorCode(body);
  if (status === 401) return { ...base, code: 'AUTHENTICATION_FAILED', retryable: false, message: MESSAGES.auth };
  if (status === 403) return { ...base, code: 'PERMISSION_DENIED', retryable: false, message: MESSAGES.permission };
  if (status === 404) return { ...base, code: 'INVALID_REQUEST', retryable: false, message: MESSAGES.not_found };
  if (status === 402 || (status === 429 && /insufficient_quota/u.test(code))) return { ...base, code: 'QUOTA_EXCEEDED', retryable: true, message: MESSAGES.quota };
  if (status === 429) { const reset = retryAfter(headers); return { ...base, code: 'RATE_LIMITED', retryable: true, message: MESSAGES.rate, ...(reset === undefined ? {} : { reset_at: reset }) }; }
  if (status === 408) return { ...base, code: 'TIMED_OUT', retryable: true, message: MESSAGES.timeout };
  if (status >= 500) { const reset = retryAfter(headers); return { ...base, code: 'PROVIDER_UNAVAILABLE', retryable: true, message: MESSAGES.unavailable, ...(reset === undefined ? {} : { reset_at: reset }) }; }
  if (status >= 400) return { ...base, code: 'INVALID_REQUEST', retryable: false, message: MESSAGES.request };
  return { ...base, code: 'INVALID_RESPONSE', retryable: false, message: MESSAGES.invalid };
}
function transportFailure(error: unknown, sent: boolean): Failure {
  const kind = error instanceof TransportError ? error.kind : 'invalid';
  if (kind === 'timeout') return { code: 'TIMED_OUT', retryable: true, message: MESSAGES.timeout, origin: 'transport', provider_request_sent: sent };
  if (kind === 'aborted') return { code: 'ABORTED', retryable: false, message: MESSAGES.aborted, origin: 'local', provider_request_sent: sent };
  if (kind === 'network') return { code: 'NETWORK_ERROR', retryable: true, message: MESSAGES.network, origin: 'transport', provider_request_sent: sent };
  return { code: 'INVALID_RESPONSE', retryable: false, message: MESSAGES.invalid, origin: 'provider', provider_request_sent: sent };
}

const safeText = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/u.test(value);
export function compatibleModelId(value: unknown): string {
  if (!safeText(value, 256)) throw new TransportError('invalid');
  return value;
}

/** GET {base}/models. Throws ModelSetupError with a trusted Japanese message; the key never appears in it. */
export async function listCompatibleModels(baseUrl: string, apiKey: string | undefined, fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<string[]> {
  let reply: Reply;
  try { reply = await exchange(compatibleUrl(baseUrl, 'models'), { apiKey, fetch: fetchImpl, timeoutMs: 15_000, signal, maxBytes: 8 * 1024 * 1024 }); }
  catch (error) { throw new ModelSetupError(transportFailure(error, true)); }
  if (reply.status < 200 || reply.status > 299) throw new ModelSetupError(statusFailure(reply.status, reply.body, reply.headers));
  const data = isRecord(reply.body) ? reply.body.data : undefined;
  if (!Array.isArray(data) || data.length > 5000) throw new ModelSetupError(transportFailure(new TransportError('invalid'), true));
  const ids = new Set<string>();
  for (const item of data) if (isRecord(item) && safeText(item.id, 256)) ids.add(item.id);
  return [...ids].sort((left, right) => left.localeCompare(right, 'en'));
}

export interface CompatibleConnection {
  readonly baseUrl: string;
  readonly apiKey?: string | undefined;
  readonly fetch?: typeof fetch;
  /** Limits concurrent requests per endpoint; waiting ends at the caller's abort or `queueMs`. */
  readonly slot?: EndpointSlot;
  readonly queueMs?: number;
}

/** Chat Completions with function tools. Non-streaming: the response is validated as a whole before any event is emitted. */
export class OpenAICompatibleAdapter implements ModelAdapter {
  readonly adapter_id = 'openai-compatible';
  readonly capabilities: ModelAdapterCapabilities;
  readonly #model: string;
  readonly #url: URL;
  readonly #key: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #slot: EndpointSlot | undefined;
  readonly #queueMs: number;
  constructor(connection: CompatibleConnection, model: string) {
    this.#model = compatibleModelId(model);
    this.#url = compatibleUrl(connection.baseUrl, 'chat/completions');
    this.#key = connection.apiKey || undefined; this.#fetch = connection.fetch ?? fetch;
    this.#slot = connection.slot; this.#queueMs = connection.queueMs ?? 600_000;
    const keyed = this.#key !== undefined;
    this.capabilities = Object.freeze({
      execution_mode: 'model_api', auth_mode: keyed ? 'api_key' : 'none', billing_mode: keyed ? 'api_usage' : 'none', owns_agent_loop: false,
      supports_niwa_tool_loop: true, supports_tool_calls: true, supports_structured_output: false,
      supports_streaming: false, supports_session_resume: false, supports_parallel_sessions: true, supports_usage_reporting: true,
    });
  }
  async *run(request: ModelRequest, options: ModelRunOptions): AsyncIterable<ModelEvent> {
    const secrets = this.#key ? [this.#key] : [];
    const fail = (error: Failure): ModelEvent => ({ type: 'failed', error: { ...error, message: redactSecrets(error.message, secrets) } });
    let sent = false;
    let events: ModelEvent[];
    try {
      // Niwa cannot tell whether an OpenAI-compatible model sees images, so it never sends them.
      if (hasImages(request)) { yield fail({ code: 'CAPABILITY_MISMATCH', retryable: false, message: MESSAGES.capability, provider_request_sent: false }); return; }
      if (!Value.Check(modelRequestSchema, request) || !isPlainJsonValue(request, { max_depth: 32, max_nodes: 10_000, max_bytes: 4 * 1024 * 1024 })) {
        yield fail({ code: 'INVALID_REQUEST', retryable: false, message: MESSAGES.request, provider_request_sent: false }); return;
      }
      if (request.reasoning_effort !== undefined || request.response_contract.type !== 'text') {
        yield fail({ code: 'CAPABILITY_MISMATCH', retryable: false, message: MESSAGES.capability, provider_request_sent: false }); return;
      }
      const safe = sanitizeModelRequestTextFields(request).request;
      const body = {
        model: this.#model, stream: false,
        messages: [{ role: 'system', content: safe.system_instructions }, ...safe.messages.map(message => {
          if (message.role === 'user') return { role: 'user', content: message.content };
          if (message.role === 'tool') return { role: 'tool', tool_call_id: message.tool_call_id, content: message.content };
          const calls = message.tool_calls ?? [];
          return { role: 'assistant', content: calls.length ? (message.content || null) : (message.content ?? ''),
            ...(calls.length ? { tool_calls: calls.map(call => ({ id: call.tool_call_id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) } : {}) };
        })],
        ...(safe.tools.length ? { tools: safe.tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.input_schema } })) } : {}),
        ...safe.model_options,
      };
      // The key is sent only as a header; never inside the conversation payload.
      if (containsExactCredentialMaterial(body, secrets)) {
        yield fail({ code: 'INVALID_REQUEST', retryable: false, message: MESSAGES.credential, provider_request_sent: false }); return;
      }
      let release: (() => void) | undefined;
      if (this.#slot) {
        const wait = AbortSignal.timeout(this.#queueMs);
        try { release = await this.#slot(options.signal ? AbortSignal.any([options.signal, wait]) : wait); }
        catch { throw new TransportError(options.signal?.aborted ? 'aborted' : 'timeout'); }
      }
      let reply: Reply;
      try {
        sent = true;
        reply = await exchange(this.#url, { apiKey: this.#key, body, fetch: this.#fetch, timeoutMs: options.timeout_ms, signal: options.signal, maxBytes: 8 * 1024 * 1024 });
      } finally { release?.(); }
      if (reply.status < 200 || reply.status > 299) { yield fail(statusFailure(reply.status, reply.body, reply.headers)); return; }
      events = this.#parse(reply.body, request.budget.max_tool_calls);
    } catch (error) {
      yield fail(transportFailure(error, sent)); return;
    }
    yield* events;
  }
  #parse(data: unknown, maxToolCalls: number): ModelEvent[] {
    const invalid = () => new TransportError('invalid');
    if (!isRecord(data)) throw invalid();
    // Some gateways report upstream failures inside a 200 response.
    if (isRecord(data.error) && !('choices' in data)) {
      const status = Number(data.error.code);
      return [{ type: 'failed', error: Number.isInteger(status) && status >= 400 && status <= 599 ? statusFailure(status, data, new Headers())
        : { code: 'PROVIDER_ERROR', retryable: true, message: MESSAGES.unavailable, origin: 'provider', provider_request_sent: true } }];
    }
    if (!Array.isArray(data.choices) || data.choices.length < 1) throw invalid();
    const choice = data.choices[0];
    if (!isRecord(choice) || !isRecord(choice.message)) throw invalid();
    const message = choice.message;
    if (message.role !== undefined && message.role !== 'assistant') throw invalid();
    if (choice.finish_reason === 'error') return [{ type: 'failed', error: { code: 'PROVIDER_ERROR', retryable: true, message: MESSAGES.unavailable, origin: 'provider', provider_request_sent: true } }];
    const events: ModelEvent[] = [];
    let text = '';
    if (typeof message.content === 'string') text = message.content;
    else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (!isRecord(part)) throw invalid();
        if (part.type === 'text' && typeof part.text === 'string') text += part.text;
      }
    } else if (message.content !== null && message.content !== undefined) throw invalid();
    if (!text && typeof message.refusal === 'string') text = message.refusal;
    if (text.length > 4 * 1024 * 1024) throw invalid();
    if (text) events.push({ type: 'text_delta', text });
    const calls = message.tool_calls ?? [];
    if (!Array.isArray(calls) || calls.length > maxToolCalls) throw invalid();
    const ids = new Set<string>();
    for (const value of calls) {
      if (!isRecord(value) || (value.type !== undefined && value.type !== 'function') || !isRecord(value.function)) throw invalid();
      const name = value.function.name;
      if (!safeText(name, 128)) throw invalid();
      const raw = value.function.arguments;
      let args: unknown;
      if (typeof raw === 'string') {
        if (raw.length > 256_000) throw invalid();
        try { args = raw.trim() ? JSON.parse(raw) : {}; } catch { throw invalid(); }
      } else args = raw ?? {};
      if (!isRecord(args) || !isPlainJsonValue(args, { max_depth: 16, max_nodes: 2000, max_bytes: 256_000 }) || containsSensitiveJsonKey(args)) throw invalid();
      let id = typeof value.id === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/u.test(value.id) ? value.id : randomUUID();
      if (ids.has(id)) id = randomUUID();
      ids.add(id);
      events.push({ type: 'tool_call', tool_call_id: id, name, arguments: args as JsonObject });
    }
    const usage = data.usage;
    if (isRecord(usage) && Number.isSafeInteger(usage.prompt_tokens) && Number.isSafeInteger(usage.completion_tokens)
      && Number(usage.prompt_tokens) >= 0 && Number(usage.completion_tokens) >= 0) {
      const input = Number(usage.prompt_tokens), output = Number(usage.completion_tokens);
      events.push({ type: 'usage', input_tokens: input, output_tokens: output, total_tokens: input + output });
    }
    const reason = choice.finish_reason;
    events.push({ type: 'completed', finish_reason: calls.length ? 'tool_calls' : reason === 'length' ? 'length' : reason === 'content_filter' ? 'content_filter' : 'stop' });
    return events;
  }
}
