import { randomUUID } from 'node:crypto';
import { Value } from '@sinclair/typebox/value';
import type { ModelAdapterCapabilities, ModelRequest, ModelEvent, JsonObject } from '../../contracts/index.ts';
import { isPlainJsonValue, modelRequestSchema } from '../../contracts/index.ts';
import type { ModelAdapter, ModelRunOptions } from '../shared/adapter.ts';
import { sanitizeModelRequestTextFields, containsSensitiveJsonKey } from '../shared/input-safety.ts';
import { httpJson, HttpError } from '../../shared/http-json.ts';

export function ollamaUrl(baseUrl: string, endpoint: 'chat' | 'tags' | 'show'): URL {
  const url = new URL(baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid Ollama URL');
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return new URL(`api/${endpoint}`, url);
}
export interface OllamaModel {
  id: string;
  tools: boolean;
  thinking: boolean;
}
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError('invalid');
  return value as Record<string, unknown>;
};
const modelName = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\x00-\x1f\x7f]/u.test(value)) throw new HttpError('invalid');
  return value;
};
export async function listOllamaModels(baseUrl: string, fetchImpl?: typeof fetch): Promise<string[]> {
  const data = record(await httpJson(ollamaUrl(baseUrl, 'tags'), { ...(fetchImpl ? { fetch: fetchImpl } : {}) }));
  if (!Array.isArray(data.models) || data.models.length > 512) throw new HttpError('invalid');
  return [...new Set(data.models.map(value => modelName(record(value).name)))];
}
export async function inspectOllamaModel(baseUrl: string, model: string, fetchImpl?: typeof fetch): Promise<OllamaModel> {
  const data = record(await httpJson(ollamaUrl(baseUrl, 'show'), { body: { model: modelName(model), verbose: false }, ...(fetchImpl ? { fetch: fetchImpl } : {}) }));
  if (!Array.isArray(data.capabilities) || data.capabilities.some(value => typeof value !== 'string')) throw new HttpError('invalid');
  if (!data.capabilities.includes('completion')) throw new Error('This Ollama model cannot chat');
  if (data.remote_host || data.remote_model) throw new Error('Niwa requires a local Ollama model');
  return { id: model, tools: data.capabilities.includes('tools'), thinking: data.capabilities.includes('thinking') };
}
export class OllamaAdapter implements ModelAdapter {
  readonly adapter_id = 'ollama';
  readonly capabilities: ModelAdapterCapabilities;
  readonly #model: OllamaModel;
  readonly #url: URL;
  readonly #fetch: typeof fetch;
  constructor(baseUrl: string, model: OllamaModel, fetchImpl = fetch) {
    this.#model = Object.freeze({ ...model, id: modelName(model.id) });
    this.#url = ollamaUrl(baseUrl, 'chat'); this.#fetch = fetchImpl;
    this.capabilities = Object.freeze({
      execution_mode: 'model_api', auth_mode: 'none', billing_mode: 'none', owns_agent_loop: false,
      supports_niwa_tool_loop: model.tools, supports_tool_calls: model.tools, supports_structured_output: false,
      supports_streaming: false, supports_session_resume: false, supports_parallel_sessions: true, supports_usage_reporting: true,
    });
  }
  async *run(request: ModelRequest, options: ModelRunOptions): AsyncIterable<ModelEvent> {
    let sent = false;
    try {
      if (!Value.Check(modelRequestSchema, request) || !isPlainJsonValue(request, { max_depth: 32, max_nodes: 10_000, max_bytes: 4 * 1024 * 1024 })) throw new HttpError('invalid');
      // Codex efforts are never forwarded to local models. Use the model's native thinking defaults.
      if (request.reasoning_effort !== undefined || request.response_contract.type !== 'text' || (request.tools.length && !this.#model.tools)) {
        yield { type: 'failed', error: { code: 'CAPABILITY_MISMATCH', message: 'The selected Ollama model cannot use these settings or tools.', retryable: false } };
        return;
      }
      const safe = sanitizeModelRequestTextFields(request).request;
      const messages = safe.messages.map(message => {
        if (message.role === 'tool') return { role: 'tool', content: message.content, tool_name: message.name };
        if (message.role === 'user') return message;
        return { role: 'assistant', content: message.content ?? '', ...(message.tool_calls ? {
          tool_calls: message.tool_calls.map(call => ({ function: { name: call.name, arguments: call.arguments } })),
        } : {}) };
      });
      sent = true;
      const data = record(await httpJson(this.#url, { fetch: this.#fetch, timeoutMs: options.timeout_ms,
        ...(options.signal ? { signal: options.signal } : {}), maxBytes: 8 * 1024 * 1024,
        body: { model: this.#model.id, stream: false, messages: [{ role: 'system', content: safe.system_instructions }, ...messages],
          tools: safe.tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.input_schema } })),
          options: { ...safe.model_options, num_predict: safe.budget.max_output_tokens },
        },
      }));
      const message = record(data.message);
      if (data.done !== true || message.role !== 'assistant' || typeof message.content !== 'string') throw new HttpError('invalid');
      if (message.content) yield { type: 'text_delta', text: message.content };
      const calls = message.tool_calls ?? [];
      if (!Array.isArray(calls) || calls.length > request.budget.max_tool_calls) throw new HttpError('invalid');
      for (const value of calls) {
        const call = record(record(value).function); const args = record(call.arguments);
        if (!this.#model.tools || !isPlainJsonValue(args, { max_depth: 16, max_nodes: 2000, max_bytes: 256_000 }) || containsSensitiveJsonKey(args)) throw new HttpError('invalid');
        yield { type: 'tool_call', tool_call_id: randomUUID(), name: modelName(call.name), arguments: args as JsonObject };
      }
      if (Number.isSafeInteger(data.prompt_eval_count) && Number.isSafeInteger(data.eval_count)
        && Number(data.prompt_eval_count) >= 0 && Number(data.eval_count) >= 0) {
        yield { type: 'usage', input_tokens: Number(data.prompt_eval_count), output_tokens: Number(data.eval_count), total_tokens: Number(data.prompt_eval_count) + Number(data.eval_count) };
      }
      yield { type: 'completed', finish_reason: calls.length ? 'tool_calls' : data.done_reason === 'length' ? 'length' : 'stop' };
    } catch (error) {
      const code = error instanceof HttpError && error.kind === 'timeout' ? 'TIMED_OUT'
        : error instanceof HttpError && error.kind === 'aborted' ? 'ABORTED'
          : error instanceof HttpError && (error.kind === 'network' || error.kind === 'status') ? 'PROVIDER_UNAVAILABLE' : 'INVALID_RESPONSE';
      yield { type: 'failed', error: { code, message: `Ollama request failed (${code}).`, retryable: code === 'PROVIDER_UNAVAILABLE' || code === 'TIMED_OUT', provider_request_sent: sent } };
    }
  }
}
