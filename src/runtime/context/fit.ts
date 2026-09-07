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

/** Trim archived room messages and complete old tool exchanges; keep instructions and work state. */
export function fitContext(request: ModelRequest, history: readonly ModelMessage[], capacity?: number, conversation: readonly ModelMessage[] = []): FittedContext {
  const exchanges = history.filter(message => message.role === 'assistant').length;
  retainCompleteExchanges(history, exchanges); // Validate even exchanges that would be removed.
  const original = { request, removed_messages: 0, ...measure(request) };
  if (capacity !== undefined && (!Number.isSafeInteger(capacity) || capacity < 1)) throw new ContextLimit('モデルの文脈容量が不正です。');
  const fits = (value: ReturnType<typeof measure>) => capacity === undefined ? value.input_bytes <= UNKNOWN_CAPACITY_BYTES
    : value.estimated_input_tokens <= capacity - request.budget.max_output_tokens;
  if (fits(original)) return original;
  let messages = request.messages;
  const old = new Set(history);
  for (let keep = exchanges - 1; keep >= 1; keep--) {
    const retained = new Set(retainCompleteExchanges(history, keep));
    const trimmed = messages.filter(message => !old.has(message) || retained.has(message));
    const candidate = { ...request, messages: trimmed };
    const fitted = { request: candidate, removed_messages: request.messages.length - trimmed.length, ...measure(candidate) };
    if (fits(fitted)) return fitted;
    if (keep === 1) messages = trimmed;
  }
  for (const message of conversation) {
    messages = messages.filter(item => item !== message);
    const candidate = { ...request, messages };
    const fitted = { request: candidate, removed_messages: request.messages.length - messages.length, ...measure(candidate) };
    if (fits(fitted)) return fitted;
  }
  if (capacity === undefined) throw new ContextLimit('モデルの文脈容量が不明で、入力サイズの確認が必要です。');
  throw new ContextLimit('依頼・作業状態・直近の交換を保持すると、入力の概算がモデルの文脈容量に収まりません。');
}
