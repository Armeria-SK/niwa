// Derived from Carried c695f855419ffc69d1e62b04f1de8de36c7c162d, core/providers/src/codex-responses-parser.ts.
// Apache-2.0. Modified for Niwa; see THIRD_PARTY_NOTICES.md and provenance/carried.json.
import type { JsonObject, ModelEvent } from '../../contracts/index.ts';
import { subscriptionUsageLimit } from './usage-limit.ts';

import {
  CodexFunctionCallAssembler,
  FunctionCallStateError,
  type AssembledFunctionCall,
} from './function-call-state.ts';
import {
  containsExactCredentialMaterial,
  containsSensitiveJsonKey,
  sanitizeModelInputJsonValues,
} from '../shared/input-safety.ts';
import { redactSecrets, sanitizeModelInputText } from '../../shared/redaction.ts';

const MAX_EVENT_TYPES = 128;
const MAX_EVENT_TYPE_LENGTH = 128;
const MAX_TEXT_BYTES = 8 * 1024 * 1024;
const MAX_REASONING_ITEMS = 32;
const MAX_REASONING_SUMMARY_ITEMS = 128;
const MAX_REASONING_BYTES = 4 * 1024 * 1024;
const MAX_SEMANTIC_EVENTS = 4096;
/**
 * Independent wire-side safety bound. A Semantic ModelEvent is not a copy of a
 * provider SSE frame, so the semantic event bound cannot also protect the
 * parser from a tiny-frame CPU flood. The adapter already caps a response body
 * at sixteen MiB; a realistic minimum Responses delta frame (the `data:`
 * prefix, a minimal JSON envelope, and the frame terminator) is about sixty-four
 * bytes, so a fully fragmented sixteen MiB body is roughly 2^18 frames. This
 * bound therefore never trips on legitimate fragmentation, stays far above the
 * Harness semantic event limits, and still caps the frame count a sub-realistic
 * flood of near-empty frames can force the parser to process.
 */
const MAX_WIRE_FRAMES = 262_144;

export type CodexResponsesFailureCategory = 'transport_error' | 'provider_error' | 'protocol_error' | 'unknown';

/** Safe, bounded observations from one Responses request. No response body or
 * request/header value is retained. */
export interface CodexResponsesDiagnostics {
  readonly terminal_event?: string;
  readonly event_types: readonly string[];
  readonly response_completed: boolean;
  readonly usage_present: boolean;
  readonly server_model_present: boolean;
  readonly request_id_present: boolean;
  readonly observed_text: boolean;
  readonly observed_tool_call: boolean;
  readonly tool_call_shape: CodexResponsesToolCallShapeDiagnostics;
  /** Provider wire frames processed. Counts only; no frame content is kept. */
  readonly wire_event_count: number;
  /** Semantic ModelEvents produced from those frames. */
  readonly semantic_event_count: number;
  /** Wire deltas merged into an already pending semantic delta event. */
  readonly coalesced_delta_count: number;
}

export interface CodexResponsesToolCallShapeDiagnostics {
  readonly item_id_present: boolean;
  readonly call_id_present: boolean;
  readonly name_present: boolean;
  readonly arguments_present: boolean;
  readonly item_done: boolean;
  readonly arguments_done: boolean;
}

export class CodexResponsesParseError extends Error {
  override readonly name = 'CodexResponsesParseError';

  constructor(
    readonly category: Exclude<CodexResponsesFailureCategory, 'transport_error' | 'unknown'>,
    readonly code: string,
    message: string,
    readonly diagnostics: CodexResponsesDiagnostics,
    readonly partial_events: readonly ModelEvent[] = [],
    readonly usage_limit?: { reset_at?: number },
  ) {
    super(message);
  }
}

export interface CodexReasoningSummaryItem {
  readonly type: 'summary_text';
  readonly text: string;
}

/** Provider-private state replayed only through the Codex Responses adapter. */
export interface CodexReasoningContinuationItem {
  readonly type: 'reasoning';
  readonly id?: string;
  readonly summary: readonly CodexReasoningSummaryItem[];
  readonly encrypted_content: string;
}

export interface CodexResponsesParseResult {
  readonly events: readonly ModelEvent[];
  readonly diagnostics: CodexResponsesDiagnostics;
  /** Provider-private continuation items. The adapter keeps these in memory
   * only; they are intentionally not ModelEvents or diagnostics. */
  readonly reasoning_continuation?: readonly CodexReasoningContinuationItem[];
}

interface CapturedReasoningContinuation {
  readonly item: CodexReasoningContinuationItem;
  readonly source: 'added' | 'output' | 'done';
  readonly byte_length: number;
  readonly order: number;
  readonly sequence: number;
}

interface MutableDiagnostics {
  terminal_event?: string;
  readonly event_types: Set<string>;
  response_completed: boolean;
  usage_present: boolean;
  server_model_present: boolean;
  request_id_present: boolean;
  observed_text: boolean;
  observed_tool_call: boolean;
  readonly tool_call_shape: MutableToolCallShapeDiagnostics;
  wire_event_count: number;
  semantic_event_count: number;
  coalesced_delta_count: number;
}

interface MutableToolCallShapeDiagnostics {
  item_id_present: boolean;
  call_id_present: boolean;
  name_present: boolean;
  arguments_present: boolean;
  item_done: boolean;
  arguments_done: boolean;
}

interface ParseContext {
  readonly events: ModelEvent[];
  readonly diagnostics: MutableDiagnostics;
  readonly exact_credentials: readonly string[];
  readonly max_exact_credential_length: number;
  readonly functionCalls: CodexFunctionCallAssembler;
  readonly reasoningContinuation: Map<string, CapturedReasoningContinuation>;
  readonly reasoningSources: Map<string, CapturedReasoningContinuation['source']>;
  nextReasoningSequence: number;
  reasoningBytes: number;
  textCredentialTail: string;
  reasoningCredentialTail: string;
  completedAppended: boolean;
  textBytes: number;
  /** Pending semantic delta accumulated from consecutive same-kind wire
   * deltas. Flushed at every logical boundary; never merged across kinds. */
  pendingKind: 'text' | 'reasoning' | undefined;
  pendingParts: string[];
  terminalKind?: 'completed' | 'incomplete';
}

export interface CodexResponsesStreamParser {
  readonly terminal: boolean;
  push(chunk: string): void;
  finish(): CodexResponsesParseResult;
  result(): CodexResponsesParseResult;
}

/** Parse either a JSON Responses object or an SSE Responses stream. */
export function parseCodexResponses(body: string, exactSecrets?: string | readonly string[]): CodexResponsesParseResult {
  const context = createContext(exactSecrets);
  try {
    if (body.trim().length === 0) throw protocol(context, 'empty_response', 'The GPT subscription response was empty.');
    if (looksLikeSse(body)) {
      const stream = createCodexResponsesStreamParser(exactSecrets);
      stream.push(body);
      return stream.finish();
    }
    else parseJson(body, context);
    return finalizeContext(context);
  } catch (error) {
    if (error instanceof CodexResponsesParseError) throw error;
    if (error instanceof FunctionCallStateError) throw protocol(context, error.code, error.message);
    throw protocol(context, 'invalid_response', 'The GPT subscription response could not be parsed.');
  }
}

function createContext(exactSecrets: string | readonly string[] | undefined): ParseContext {
  const exactCredentials = Object.freeze(
    (typeof exactSecrets === 'string' ? [exactSecrets] : [...(exactSecrets ?? [])])
      .filter((secret) => secret.length > 0),
  );
  return {
    events: [],
    diagnostics: {
      event_types: new Set<string>(),
      response_completed: false,
      usage_present: false,
      server_model_present: false,
      request_id_present: false,
      observed_text: false,
      observed_tool_call: false,
      tool_call_shape: {
        item_id_present: false,
        call_id_present: false,
        name_present: false,
        arguments_present: false,
        item_done: false,
        arguments_done: false,
      },
      wire_event_count: 0,
      semantic_event_count: 0,
      coalesced_delta_count: 0,
    },
    exact_credentials: exactCredentials,
    max_exact_credential_length: Math.max(
      0,
      ...exactCredentials.map((secret) => secret.length),
    ),
    functionCalls: new CodexFunctionCallAssembler(),
    reasoningContinuation: new Map<string, CapturedReasoningContinuation>(),
    reasoningSources: new Map<string, CapturedReasoningContinuation['source']>(),
    nextReasoningSequence: 0,
    reasoningBytes: 0,
    textCredentialTail: '',
    reasoningCredentialTail: '',
    completedAppended: false,
    textBytes: 0,
    pendingKind: undefined,
    pendingParts: [],
  };
}

function parseJson(body: string, context: ParseContext): void {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw protocol(context, 'invalid_json', 'The GPT subscription response was not valid JSON.');
  }
  rejectExactCredentialMaterial(value, context);
  const root = asRecord(value);
  if (!root) throw protocol(context, 'invalid_object', 'The GPT subscription response was malformed.');
  recordMetadata(root, context);
  const response = asRecord(root['response']);
  if (response !== undefined) recordResponseMetadata(response, context);
  let outputParsed = false;
  if (typeof root['type'] === 'string') {
    recordEventType(root['type'], context);
    processRecord(root, context);
    outputParsed = root['type'] === 'response.completed';
  }
  const output = Array.isArray(root['output']) ? root['output'] : response?.['output'];
  if (!outputParsed && Array.isArray(output)) parseOutput(output, context);
  if (typeof root['output_text'] === 'string') addText(root['output_text'], context);
  else if (typeof response?.['output_text'] === 'string') addText(response['output_text'], context);
  if (root['usage'] !== undefined) recordUsage(root['usage'], context);
  else if (response?.['usage'] !== undefined) recordUsage(response['usage'], context);
  const status = root['status'] ?? response?.['status'];
  if (root['error'] !== undefined || response?.['error'] !== undefined || status === 'failed') {
    recordEventType('response.failed', context);
    processFailure(root, context);
  }
  else if (status === 'incomplete') {
    recordEventType('response.incomplete', context);
    markTerminal('response.incomplete', 'incomplete', context);
  } else if (context.terminalKind === undefined) {
    const hasCompletedShape = status === 'completed'
      || root['type'] === 'response.completed'
      || Array.isArray(output)
      || typeof root['output_text'] === 'string'
      || typeof response?.['output_text'] === 'string';
    if (!hasCompletedShape) throw protocol(context, 'missing_terminal_event', 'The GPT subscription response did not contain a terminal event.');
    recordEventType('response.completed', context);
    markTerminal('response.completed', 'completed', context);
  }
}

function parseOutput(output: readonly unknown[], context: ParseContext): void {
  for (const [outputIndex, item] of output.entries()) {
    const record = asRecord(item);
    if (!record) continue;
    captureReasoningItem(record, context, { source: 'output', output_index: outputIndex });
    if (record['type'] === 'function_call') {
      recordToolCallShape(record, context);
      context.diagnostics.tool_call_shape.item_done = true;
      context.diagnostics.tool_call_shape.arguments_done = typeof record['arguments'] === 'string' && record['arguments'].length > 0;
      context.functionCalls.registerOutputItem(record);
      emitAsEvents(context.functionCalls.markItemDone(record), context);
      continue;
    }
    const content = record['content'];
    if (Array.isArray(content)) {
      for (const part of content) {
        const partRecord = asRecord(part);
        if (partRecord?.['type'] === 'output_text' && typeof partRecord['text'] === 'string') addText(partRecord['text'], context);
      }
    } else if (typeof record['text'] === 'string') addText(record['text'], context);
  }
}

export function createCodexResponsesStreamParser(exactSecrets?: string | readonly string[]): CodexResponsesStreamParser {
  const context = createContext(exactSecrets);
  let lineBuffer = '';
  let frameEvent: string | undefined;
  let frameData: string[] = [];
  let finalized: CodexResponsesParseResult | undefined;

  const flushFrame = (): void => {
    if (frameEvent === undefined && frameData.length === 0) return;
    context.diagnostics.wire_event_count += 1;
    if (context.diagnostics.wire_event_count > MAX_WIRE_FRAMES) {
      throw protocol(context, 'wire_frame_limit', 'The GPT subscription response exceeded the streamed frame limit.');
    }
    const event = frameEvent;
    const data = frameData.join('\n');
    frameEvent = undefined;
    frameData = [];
    if (data.length === 0 || data === '[DONE]') return;
    let value: unknown;
    try {
      value = JSON.parse(data);
    } catch {
      throw protocol(context, 'invalid_sse_json', 'The GPT subscription SSE frame was not valid JSON.');
    }
    rejectExactCredentialMaterial(value, context);
    const record = asRecord(value);
    if (!record) throw protocol(context, 'invalid_sse_object', 'The GPT subscription SSE frame was malformed.');
    const eventType = typeof record['type'] === 'string' ? record['type'] : event;
    if (eventType !== undefined) recordEventType(eventType, context);
    try {
      processRecord(record, context, eventType);
    } catch (error) {
      if (error instanceof FunctionCallStateError) throw protocol(context, error.code, error.message);
      throw error;
    }
  };

  const consumeLine = (line: string): void => {
    if (line.length === 0) {
      flushFrame();
      return;
    }
    if (line.startsWith(':')) return;
    if (line.startsWith('event:')) { frameEvent = line.slice(6).trim(); return; }
    if (line.startsWith('data:')) { frameData.push(line.slice(5).replace(/^ /u, '')); }
  };

  const finalize = (): CodexResponsesParseResult => {
    if (finalized !== undefined) return finalized;
    if (lineBuffer.length > 0) {
      consumeLine(lineBuffer.endsWith('\r') ? lineBuffer.slice(0, -1) : lineBuffer);
      lineBuffer = '';
    }
    flushFrame();
    try {
      finalized = finalizeContext(context);
      return finalized;
    } catch (error) {
      if (error instanceof FunctionCallStateError) throw protocol(context, error.code, error.message);
      throw error;
    }
  };

  return {
    get terminal(): boolean { return context.terminalKind !== undefined || finalized !== undefined; },
    push(chunk: string): void {
      if (finalized !== undefined || chunk.length === 0) return;
      lineBuffer += chunk;
      // A frame without a line terminator is bounded to avoid retaining an
      // unbounded provider response while waiting for a malformed delimiter.
      if (Buffer.byteLength(lineBuffer, 'utf8') > MAX_TEXT_BYTES) throw protocol(context, 'response_limit', 'The GPT subscription response exceeded the collected limit.');
      for (;;) {
        const newline = lineBuffer.indexOf('\n');
        if (newline < 0) break;
        const line = lineBuffer.slice(0, newline);
        lineBuffer = lineBuffer.slice(newline + 1);
        consumeLine(line.endsWith('\r') ? line.slice(0, -1) : line);
        if (context.terminalKind !== undefined) {
          // Do not process provider bytes after a terminal event. The
          // transport cancels the reader at this boundary.
          lineBuffer = '';
          frameEvent = undefined;
          frameData = [];
          break;
        }
      }
    },
    finish: finalize,
    result: finalize,
  };
}

function finalizeContext(context: ParseContext): CodexResponsesParseResult {
  flushPending(context);
  if (context.terminalKind === undefined) {
    throw protocol(context, 'missing_terminal_event', 'The GPT subscription response did not contain a terminal event.');
  }
  if (!context.completedAppended) {
    if (context.terminalKind === 'incomplete') {
      // An incomplete response must never turn an un-emitted function call
      // into a successful host Tool Call. Calls already emitted before the
      // terminal event remain part of the observed stream; anything pending
      // is a targeted protocol failure.
      if (context.functionCalls.snapshots().some((state) => !state.emitted)) {
        throw protocol(context, 'incomplete_tool_call', 'The GPT subscription response ended before the tool call was complete.');
      }
    } else {
      emitAsEvents(context.functionCalls.finalize(), context);
    }
    appendCompleted(context);
    context.completedAppended = true;
  }
  return Object.freeze({
    events: Object.freeze([...context.events]),
    diagnostics: snapshot(context.diagnostics),
    ...(context.terminalKind !== 'completed' || context.reasoningContinuation.size === 0 ? {} : {
      reasoning_continuation: Object.freeze(
        [...context.reasoningContinuation.values()]
          // `output_item.added` is provisional: the provider documents that
          // its encrypted content may be incomplete. Only a completed output
          // item (or the authoritative non-streaming `output`) is replayable.
          .filter(({ source }) => source !== 'added')
          .sort((left, right) => left.order - right.order || left.sequence - right.sequence)
          .map(({ item }) => item),
      ),
    }),
  });
}

function emitAsEvents(calls: readonly AssembledFunctionCall[], context: ParseContext): void {
  for (const call of calls) {
    if (containsExactCredentialMaterial(call, context.exact_credentials)) {
      throw credentialMaterialProtocol(context);
    }
    if (
      sanitizeModelInputText(call.call_id).redaction_count > 0 ||
      sanitizeModelInputText(call.name).redaction_count > 0
    ) {
      throw protocol(context, 'secret_shaped_tool_identifier', 'The GPT subscription response contained a secret-shaped tool identifier.');
    }
    if (containsSensitiveJsonKey(call.arguments)) {
      throw protocol(context, 'secret_semantic_tool_arguments', 'The GPT subscription response contained secret-semantic tool arguments.');
    }
    const argumentsValue = sanitizeModelInputJsonValues(call.arguments as JsonObject).value;
    context.diagnostics.observed_tool_call = true;
    pushEvent({ type: 'tool_call', tool_call_id: call.call_id, name: call.name, arguments: argumentsValue }, context);
  }
}

function recordToolCallShape(
  value: Record<string, unknown> | undefined,
  context: ParseContext,
  outerItemId?: unknown,
): void {
  if (value === undefined) return;
  const itemId = outerItemId ?? value['item_id'] ?? value['id'];
  if (typeof itemId === 'string' && itemId.length > 0) context.diagnostics.tool_call_shape.item_id_present = true;
  if (typeof value['call_id'] === 'string' && value['call_id'].length > 0) context.diagnostics.tool_call_shape.call_id_present = true;
  if (typeof value['name'] === 'string' && value['name'].length > 0) context.diagnostics.tool_call_shape.name_present = true;
  if (Object.prototype.hasOwnProperty.call(value, 'arguments') || typeof value['delta'] === 'string') {
    context.diagnostics.tool_call_shape.arguments_present = true;
  }
}

function processRecord(record: Record<string, unknown>, context: ParseContext, eventType = typeof record['type'] === 'string' ? record['type'] : undefined): void {
  if (eventType === undefined) {
    if (record['usage'] !== undefined) recordUsage(record['usage'], context);
    return;
  }
  recordMetadata(record, context);
  if (eventType === 'response.output_text.delta') {
    if (typeof record['delta'] === 'string') addText(record['delta'], context);
    return;
  }
  if (eventType === 'response.output_text.done') { flushPending(context); return; }
  if (eventType === 'response.reasoning_summary_text.delta') {
    if (typeof record['delta'] === 'string') addReasoning(record['delta'], context);
    return;
  }
  if (eventType === 'response.reasoning_summary_text.done') { flushPending(context); return; }
  if (eventType === 'response.output_item.added') {
    flushPending(context);
    const item = asRecord(record['item']) ?? asRecord(record['output_item']);
    const outputIndex = nonNegativeInteger(record['output_index']);
    captureReasoningItem(item, context, {
      source: 'added',
      outer_item_id: record['item_id'],
      ...(outputIndex === undefined ? {} : { output_index: outputIndex }),
    });
    if (item?.['type'] === 'function_call') recordToolCallShape(item, context, record['item_id']);
    context.functionCalls.registerOutputItem(withOuterItemId(item, record));
    return;
  }
  if (eventType === 'response.output_item.done') {
    flushPending(context);
    const item = asRecord(record['item']) ?? asRecord(record['output_item']);
    const outputIndex = nonNegativeInteger(record['output_index']);
    captureReasoningItem(item, context, {
      source: 'done',
      outer_item_id: record['item_id'],
      ...(outputIndex === undefined ? {} : { output_index: outputIndex }),
    });
    if (item?.['type'] === 'function_call') {
      recordToolCallShape(item, context, record['item_id']);
      context.diagnostics.tool_call_shape.item_done = true;
    }
    emitAsEvents(context.functionCalls.markItemDone(withOuterItemId(item, record)), context);
    return;
  }
  if (eventType === 'response.function_call_arguments.delta') {
    flushPending(context);
    recordToolCallShape(record, context);
    context.functionCalls.appendArguments(record['item_id'], record['call_id'], record['delta']);
    if (typeof record['delta'] === 'string') context.diagnostics.observed_tool_call = true;
    return;
  }
  if (eventType === 'response.function_call_arguments.done') {
    flushPending(context);
    recordToolCallShape(record, context);
    context.diagnostics.tool_call_shape.arguments_done = true;
    emitAsEvents(context.functionCalls.completeArguments(record['item_id'], record['call_id'], record['arguments'], record['name']), context);
    return;
  }
  if (eventType === 'response.completed') {
    const response = asRecord(record['response']);
    if (response !== undefined) recordResponseMetadata(response, context);
    if (response?.['usage'] !== undefined) recordUsage(response['usage'], context);
    else if (record['usage'] !== undefined) recordUsage(record['usage'], context);
    const output = Array.isArray(response?.['output']) ? response['output'] : record['output'];
    if (Array.isArray(output)) parseOutput(output, context);
    markTerminal(eventType, 'completed', context);
    return;
  }
  if (eventType === 'response.incomplete') {
    const response = asRecord(record['response']);
    if (response !== undefined) recordResponseMetadata(response, context);
    if (response?.['usage'] !== undefined) recordUsage(response['usage'], context);
    else if (record['usage'] !== undefined) recordUsage(record['usage'], context);
    markTerminal(eventType, 'incomplete', context);
    return;
  }
  if (eventType === 'response.failed') {
    processFailure(record, context);
    return;
  }
  if (record['usage'] !== undefined) recordUsage(record['usage'], context);
}

function processFailure(record: Record<string, unknown>, context: ParseContext): never {
  // Preserve already observed output in `partial_events`. A flush that would
  // itself exceed the semantic event bound must not replace the provider's
  // own terminal failure with a parser limit failure.
  try { flushPending(context); } catch { /* the provider failure is terminal */ }
  context.diagnostics.terminal_event = 'response.failed';
  const response = asRecord(record['response']);
  if (response !== undefined) recordResponseMetadata(response, context);
  const error = asRecord(response?.['error']) ?? asRecord(record['error']);
  const code = safeCode(error?.['code'] ?? error?.['type'] ?? 'provider_error');
  const message = safeMessage(error?.['message'] ?? 'The GPT subscription response failed.');
  throw new CodexResponsesParseError(
    'provider_error',
    code,
    message,
    snapshot(context.diagnostics),
    Object.freeze([...context.events]),
    subscriptionUsageLimit(error),
  );
}

function recordMetadata(record: Record<string, unknown>, context: ParseContext): void {
  if (typeof record['model'] === 'string' || typeof asRecord(record['response'])?.['model'] === 'string') context.diagnostics.server_model_present = true;
  if (typeof record['id'] === 'string' || typeof record['request_id'] === 'string') context.diagnostics.request_id_present = true;
}

function recordResponseMetadata(response: Record<string, unknown>, context: ParseContext): void {
  if (typeof response['model'] === 'string') context.diagnostics.server_model_present = true;
  if (typeof response['id'] === 'string' || typeof response['request_id'] === 'string') context.diagnostics.request_id_present = true;
}

function recordUsage(value: unknown, context: ParseContext): void {
  context.diagnostics.usage_present = true;
  const usage = asRecord(value);
  if (!usage) return;
  const input = nonNegativeInteger(usage['input_tokens'] ?? usage['prompt_tokens']);
  const output = nonNegativeInteger(usage['output_tokens'] ?? usage['completion_tokens']);
  const total = nonNegativeInteger(usage['total_tokens']);
  if (input === undefined || output === undefined || total === undefined || total !== input + output) return;
  if (context.events.some((event) => event.type === 'usage')) return;
  pushEvent({ type: 'usage', input_tokens: input, output_tokens: output, total_tokens: total }, context);
}

function appendCompleted(context: ParseContext): void {
  const finishReason = context.terminalKind === 'incomplete'
    ? 'length'
    : context.diagnostics.observed_tool_call ? 'tool_calls' : 'stop';
  pushEvent({ type: 'completed', finish_reason: finishReason }, context);
}

function markTerminal(eventType: string, kind: 'completed' | 'incomplete', context: ParseContext): void {
  if (context.terminalKind !== undefined) throw protocol(context, 'multiple_terminal_events', 'The GPT subscription response emitted multiple terminal events.');
  context.terminalKind = kind;
  context.diagnostics.terminal_event = eventType;
  context.diagnostics.response_completed = kind === 'completed';
}

function addText(value: string, context: ParseContext): void {
  context.textBytes += Buffer.byteLength(value, 'utf8');
  if (context.textBytes > MAX_TEXT_BYTES) throw protocol(context, 'text_limit', 'The GPT subscription response exceeded the collected text limit.');
  // Credential material is checked per wire delta, with a carried tail, so an
  // exact credential split across provider chunks still fails closed before
  // any coalescing can hide the split.
  context.textCredentialTail = checkedCredentialTail(context.textCredentialTail, value, context);
  context.diagnostics.observed_text = true;
  appendPending('text', value, context);
}

function addReasoning(value: string, context: ParseContext): void {
  context.textBytes += Buffer.byteLength(value, 'utf8');
  if (context.textBytes > MAX_TEXT_BYTES) throw protocol(context, 'text_limit', 'The GPT subscription response exceeded the collected text limit.');
  context.reasoningCredentialTail = checkedCredentialTail(context.reasoningCredentialTail, value, context);
  appendPending('reasoning', value, context);
}

/**
 * Accumulate one wire delta into the pending semantic delta event. Consecutive
 * deltas of the same kind coalesce; a different kind flushes first, so a
 * provider's chunking granularity never decides how many Semantic ModelEvents
 * the Harness observes.
 */
function appendPending(kind: 'text' | 'reasoning', value: string, context: ParseContext): void {
  if (context.pendingKind !== undefined && context.pendingKind !== kind) flushPending(context);
  if (context.pendingKind === undefined) context.pendingKind = kind;
  else context.diagnostics.coalesced_delta_count += 1;
  context.pendingParts.push(value);
}

/** Emit the pending semantic delta event, if any, at a logical boundary. */
function flushPending(context: ParseContext): void {
  const kind = context.pendingKind;
  if (kind === undefined) return;
  const value = context.pendingParts.join('');
  context.pendingKind = undefined;
  context.pendingParts = [];
  appendEvent(
    kind === 'text'
      ? { type: 'text_delta', text: sanitizeModelInputText(value).text.slice(0, MAX_TEXT_BYTES) }
      : { type: 'reasoning_summary', summary: redactSecrets(value).slice(0, MAX_TEXT_BYTES) },
    context,
  );
}

function checkedCredentialTail(previousTail: string, value: string, context: ParseContext): string {
  if (context.max_exact_credential_length === 0) return '';
  const combined = `${previousTail}${value}`;
  if (containsExactCredentialMaterial(combined, context.exact_credentials)) {
    throw credentialMaterialProtocol(context);
  }
  const retainedLength = context.max_exact_credential_length - 1;
  return retainedLength === 0 ? '' : combined.slice(-retainedLength);
}

function withOuterItemId(
  item: Record<string, unknown> | undefined,
  outer: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (item === undefined) return undefined;
  if (item['id'] !== undefined || outer['item_id'] === undefined) return item;
  return { ...item, item_id: outer['item_id'] };
}

interface CaptureReasoningOptions {
  readonly source: 'added' | 'output' | 'done';
  readonly outer_item_id?: unknown;
  readonly output_index?: number;
}

function captureReasoningItem(
  value: Record<string, unknown> | undefined,
  context: ParseContext,
  options: CaptureReasoningOptions,
): void {
  if (value?.['type'] !== 'reasoning') return;
  const itemId = stringId(value['id']) ?? stringId(options.outer_item_id);
  const outputKey = options.output_index === undefined ? undefined : `output:${options.output_index}`;
  const idKey = itemId === undefined ? undefined : `id:${itemId}`;
  const key = [outputKey, idKey].find((candidate) => (
    candidate !== undefined && context.reasoningSources.has(candidate)
  )) ?? outputKey ?? idKey ?? `anonymous:${context.reasoningContinuation.size}`;
  const previous = context.reasoningContinuation.get(key);
  const previousSource = context.reasoningSources.get(key);
  // The completed item event is the provider's canonical continuation. A
  // lower-priority aggregate/output or provisional event must never replace,
  // remove, or even re-validate a value already captured from item.done.
  if (previousSource !== undefined && reasoningSourcePriority(previousSource) > reasoningSourcePriority(options.source)) return;
  // Streaming `output_item.added` is explicitly provisional and may omit its
  // empty summary. Completed/done items must carry the required summary shape;
  // no summary text is synthesized and provisional state is never replayed.
  const summary = parseReasoningSummary(value['summary'], options.source === 'added', context);
  const encryptedValue = value['encrypted_content'];
  if (encryptedValue === undefined || encryptedValue === null) {
    if (options.source !== 'added') {
      context.reasoningSources.set(key, options.source);
      removeReasoningContinuation(key, context);
    }
    return;
  }
  if (typeof encryptedValue !== 'string') {
    throw protocol(context, 'invalid_reasoning_continuation', 'The GPT subscription reasoning continuation was malformed.');
  }
  const encryptedBytes = Buffer.byteLength(encryptedValue, 'utf8');
  if (encryptedValue.length === 0 || encryptedBytes > MAX_REASONING_BYTES) {
    throw protocol(context, 'reasoning_continuation_limit', 'The GPT subscription reasoning continuation exceeded the collected limit.');
  }
  const byteLength = encryptedBytes + summary.reduce(
    (total, item) => total + Buffer.byteLength(item.text, 'utf8'),
    0,
  );
  const previousBytes = previous?.byte_length ?? 0;
  if (previous === undefined && context.reasoningContinuation.size >= MAX_REASONING_ITEMS) {
    throw protocol(context, 'reasoning_continuation_limit', 'The GPT subscription reasoning continuation exceeded the item limit.');
  }
  if (context.reasoningBytes - previousBytes + byteLength > MAX_REASONING_BYTES) {
    throw protocol(context, 'reasoning_continuation_limit', 'The GPT subscription reasoning continuation exceeded the collected limit.');
  }
  context.reasoningBytes += byteLength - previousBytes;
  context.reasoningSources.set(key, options.source);
  const sequence = previous?.sequence ?? context.nextReasoningSequence++;
  const item = Object.freeze({
    type: 'reasoning' as const,
    ...(itemId === undefined ? {} : { id: itemId }),
    summary,
    encrypted_content: encryptedValue,
  });
  context.reasoningContinuation.set(key, Object.freeze({
    item,
    source: options.source,
    byte_length: byteLength,
    order: options.output_index ?? previous?.order ?? sequence,
    sequence,
  }));
}

function reasoningSourcePriority(source: CapturedReasoningContinuation['source']): number {
  return source === 'done' ? 2 : source === 'output' ? 1 : 0;
}

function parseReasoningSummary(
  value: unknown,
  allowMissing: boolean,
  context: ParseContext,
): readonly CodexReasoningSummaryItem[] {
  if (value === undefined && allowMissing) return Object.freeze([]);
  if (!Array.isArray(value)) {
    throw protocol(context, 'invalid_reasoning_summary', 'The GPT subscription reasoning summary was malformed.');
  }
  if (value.length > MAX_REASONING_SUMMARY_ITEMS) {
    throw protocol(context, 'reasoning_continuation_limit', 'The GPT subscription reasoning continuation exceeded the summary item limit.');
  }
  return Object.freeze(value.map((entry) => {
    const record = asRecord(entry);
    if (record?.['type'] !== 'summary_text' || typeof record['text'] !== 'string') {
      throw protocol(context, 'invalid_reasoning_summary', 'The GPT subscription reasoning summary was malformed.');
    }
    return Object.freeze({ type: 'summary_text' as const, text: record['text'] });
  }));
}

function removeReasoningContinuation(key: string, context: ParseContext): void {
  const previous = context.reasoningContinuation.get(key);
  if (previous === undefined) return;
  context.reasoningBytes -= previous.byte_length;
  context.reasoningContinuation.delete(key);
}

/** Emit an independent semantic event. Any pending delta is flushed first so
 * ordering across text, reasoning, tool calls, usage, and terminal events is
 * preserved exactly as observed on the wire. */
function pushEvent(event: ModelEvent, context: ParseContext): void {
  flushPending(context);
  appendEvent(event, context);
}

function appendEvent(event: ModelEvent, context: ParseContext): void {
  if (context.events.length >= MAX_SEMANTIC_EVENTS) throw protocol(context, 'event_limit', 'The GPT subscription response exceeded the collected event limit.');
  context.events.push(event);
  context.diagnostics.semantic_event_count = context.events.length;
}

function rejectExactCredentialMaterial(value: unknown, context: ParseContext): void {
  if (containsExactCredentialMaterial(value, context.exact_credentials)) {
    throw credentialMaterialProtocol(context);
  }
}

function credentialMaterialProtocol(context: ParseContext): CodexResponsesParseError {
  return new CodexResponsesParseError(
    'protocol_error',
    'credential_material_response',
    'The GPT subscription response contained configured credential material.',
    snapshot(context.diagnostics),
    Object.freeze([]),
  );
}

function protocol(context: ParseContext, code: string, message: string): CodexResponsesParseError {
  return new CodexResponsesParseError(
    'protocol_error',
    safeCode(code),
    safeMessage(message),
    snapshot(context.diagnostics),
    Object.freeze([...context.events]),
  );
}

function snapshot(value: MutableDiagnostics): CodexResponsesDiagnostics {
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
  });
}

function recordEventType(value: string, context: ParseContext): void {
  const safe = safeMessage(value).slice(0, MAX_EVENT_TYPE_LENGTH);
  if (safe.length === 0 || context.diagnostics.event_types.size >= MAX_EVENT_TYPES) return;
  context.diagnostics.event_types.add(safe);
}

function looksLikeSse(body: string): boolean {
  return /(?:^|\n)(?:event:\s*[^\n]*\n)?data:\s*/u.test(body) || body.trim() === '[DONE]';
}

function safeCode(value: unknown): string {
  const text = typeof value === 'string' ? redactSecrets(value) : 'provider_error';
  const cleaned = text.replaceAll(/[^A-Za-z0-9_.-]/gu, '_').slice(0, 128);
  return cleaned.length === 0 ? 'provider_error' : cleaned;
}

function safeMessage(value: unknown): string {
  const text = typeof value === 'string' ? value : 'The GPT subscription request failed.';
  return Array.from(redactSecrets(text), (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f ? ' ' : character;
  }).join('').slice(0, 2048);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 ? value : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined;
}
