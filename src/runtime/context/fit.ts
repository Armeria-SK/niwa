import type { ModelMessage, ModelRequest } from '../../contracts/model.ts';
import { retainCompleteExchanges } from './retention.ts';

export type FittedContext = { request: ModelRequest; removed_messages: number; input_bytes: number; estimated_input_tokens: number };
export class ContextLimit extends Error {}
// A transport-size guard when capacity is unknown, not an inferred token capacity.
const UNKNOWN_CAPACITY_BYTES = 128 * 1024;
// UTF-8/3 plus framing allowance is an estimate, not tokenizer output or observed provider usage.
const measure = (request: ModelRequest) => {
  const bytes = Buffer.byteLength(JSON.stringify({ system: request.system_instructions, messages: request.messages, tools: request.tools }), 'utf8');
  return { input_bytes: bytes, estimated_input_tokens: Math.ceil(bytes / 3) + 1024 };
};

/** Only remove complete old exchanges from the supplied task transcript. All other inputs are pinned. */
export function fitContext(request: ModelRequest, history: readonly ModelMessage[], capacity?: number): FittedContext {
  const exchanges = history.filter(message => message.role === 'assistant').length;
  retainCompleteExchanges(history, exchanges); // Validate even exchanges that would be removed.
  const original = { request, removed_messages: 0, ...measure(request) };
  if (capacity === undefined) {
    if (original.input_bytes > UNKNOWN_CAPACITY_BYTES) throw new ContextLimit('モデルの文脈容量が不明で、入力サイズの確認が必要です。');
    return original;
  }
  if (!Number.isSafeInteger(capacity) || capacity < 1) throw new ContextLimit('モデルの文脈容量が不正です。');
  const available = capacity - request.budget.max_output_tokens;
  if (original.estimated_input_tokens <= available) return original;
  const old = new Set(history);
  for (let keep = exchanges - 1; keep >= 1; keep--) {
    const retained = new Set(retainCompleteExchanges(history, keep));
    const messages = request.messages.filter(message => !old.has(message) || retained.has(message));
    const candidate = { ...request, messages };
    const fitted = { request: candidate, removed_messages: request.messages.length - messages.length, ...measure(candidate) };
    if (fitted.estimated_input_tokens <= available) return fitted;
  }
  throw new ContextLimit('依頼・作業状態・直近の交換を保持すると、入力の概算がモデルの文脈容量に収まりません。');
}
