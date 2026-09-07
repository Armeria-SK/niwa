// Derived from Carried c695f855419ffc69d1e62b04f1de8de36c7c162d, core/providers/src/codex-function-call-state.ts.
// Apache-2.0. Modified for Niwa; see THIRD_PARTY_NOTICES.md and provenance/carried.json.
/**
 * Host-owned assembly state for the Responses function-call event stream.
 *
 * Responses uses two identifiers for a function call: `item_id` correlates
 * stream events while `call_id` identifies the tool result sent back by the
 * host.  They must never be conflated.  This module deliberately retains no
 * provider payload outside of the bounded argument text needed to construct a
 * ModelEvent.
 */

const MAX_ID_LENGTH = 128;
const MAX_NAME_LENGTH = 128;
const MAX_ARGUMENT_BYTES = 2 * 1024 * 1024;

export type FunctionCallStateErrorCode =
  | 'function_call_collision'
  | 'malformed_tool_call'
  | 'malformed_tool_arguments'
  | 'arguments_limit';

export class FunctionCallStateError extends Error {
  override readonly name = 'FunctionCallStateError';

  constructor(readonly code: FunctionCallStateErrorCode, message: string) {
    super(message);
  }
}

export interface FunctionCallStateSnapshot {
  readonly item_id?: string;
  readonly call_id?: string;
  readonly name?: string;
  readonly arguments_text: string;
  readonly item_done: boolean;
  readonly arguments_done: boolean;
  readonly emitted: boolean;
}

export interface AssembledFunctionCall {
  readonly call_id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

interface MutableFunctionCallState {
  item_id?: string;
  call_id?: string;
  name?: string;
  arguments_text: string;
  item_done: boolean;
  arguments_done: boolean;
  emitted: boolean;
}

/**
 * Incrementally assembles function calls.  Events may arrive in either
 * identifier form and may be duplicated; one state object is always shared by
 * both indexes.  Validation of incomplete arguments is intentionally delayed
 * until an explicit finalization boundary.
 */
export class CodexFunctionCallAssembler {
  readonly by_item_id = new Map<string, FunctionCallStateSnapshot>();
  readonly by_call_id = new Map<string, FunctionCallStateSnapshot>();

  #states: MutableFunctionCallState[] = [];

  registerOutputItem(value: Record<string, unknown> | undefined): void {
    if (value?.['type'] !== 'function_call') return;
    const state = this.#resolve(value['id'] ?? value['item_id'], value['call_id'], true);
    this.#mergeFields(state, value);
  }

  markItemDone(value: Record<string, unknown> | undefined): readonly AssembledFunctionCall[] {
    if (value?.['type'] !== 'function_call') return [];
    const state = this.#resolve(value['id'] ?? value['item_id'], value['call_id'], true);
    this.#mergeFields(state, value);
    state.item_done = true;
    return this.#emitReady(state);
  }

  appendArguments(
    itemId: unknown,
    callId: unknown,
    delta: unknown,
  ): void {
    if (typeof delta !== 'string') return;
    const state = this.#resolve(itemId, callId, true);
    const next = `${state.arguments_text}${delta}`;
    if (Buffer.byteLength(next, 'utf8') > MAX_ARGUMENT_BYTES) {
      throw new FunctionCallStateError('arguments_limit', 'The GPT subscription tool arguments exceeded the collected limit.');
    }
    state.arguments_text = next;
  }

  completeArguments(
    itemId: unknown,
    callId: unknown,
    argumentsValue: unknown,
    name: unknown,
  ): readonly AssembledFunctionCall[] {
    const state = this.#resolve(itemId, callId, true);
    if (typeof name === 'string') this.#mergeName(state, name);
    if (typeof argumentsValue === 'string') {
      if (Buffer.byteLength(argumentsValue, 'utf8') > MAX_ARGUMENT_BYTES) {
        throw new FunctionCallStateError('arguments_limit', 'The GPT subscription tool arguments exceeded the collected limit.');
      }
      if (state.arguments_text.length === 0 || argumentsValue.length >= state.arguments_text.length) state.arguments_text = argumentsValue;
    }
    state.arguments_done = true;
    return this.#emitReady(state, true);
  }

  /** Finalize every pending call at response.completed. */
  finalize(): readonly AssembledFunctionCall[] {
    const calls: AssembledFunctionCall[] = [];
    for (const state of this.#states) calls.push(...this.#emitReady(state, true));
    return calls;
  }

  snapshots(): readonly FunctionCallStateSnapshot[] {
    return Object.freeze(this.#states.map((state) => this.#snapshot(state)));
  }

  #resolve(itemIdValue: unknown, callIdValue: unknown, create: boolean): MutableFunctionCallState {
    if (itemIdValue !== undefined && normalizeId(itemIdValue) === undefined) {
      throw new FunctionCallStateError('malformed_tool_call', 'The GPT subscription tool call was malformed.');
    }
    if (callIdValue !== undefined && normalizeId(callIdValue) === undefined) {
      throw new FunctionCallStateError('malformed_tool_call', 'The GPT subscription tool call was malformed.');
    }
    const itemId = normalizeId(itemIdValue);
    const callId = normalizeId(callIdValue);
    const byItem = itemId === undefined ? undefined : this.#findByItem(itemId);
    // Some Responses fixtures (and older compatible endpoints) expose the
    // call identifier in the `item_id` field. If no item index matches, treat
    // that value as a call-id alias; a real item-id match always wins.
    const callLookupId = callId ?? (byItem === undefined ? itemId : undefined);
    const byCall = callLookupId === undefined ? undefined : this.#findByCall(callLookupId);
    if (byItem !== undefined && byCall !== undefined && byItem !== byCall) {
      throw new FunctionCallStateError('function_call_collision', 'The GPT subscription tool call identifiers conflicted.');
    }
    let state = byItem ?? byCall;
    if (state !== undefined && byItem !== undefined && callId !== undefined && state.call_id !== undefined && state.call_id !== callId) {
      throw new FunctionCallStateError('function_call_collision', 'The GPT subscription tool call identifiers conflicted.');
    }
    if (state !== undefined && byCall !== undefined && itemId !== undefined && state.item_id !== undefined && state.item_id !== itemId) {
      throw new FunctionCallStateError('function_call_collision', 'The GPT subscription tool call identifiers conflicted.');
    }
    if (state === undefined) {
      if (!create) throw new FunctionCallStateError('malformed_tool_call', 'The GPT subscription tool call was malformed.');
      state = {
        arguments_text: '',
        item_done: false,
        arguments_done: false,
        emitted: false,
      };
      this.#states.push(state);
    }
    this.#bind(state, itemId, callId);
    return state;
  }

  #bind(state: MutableFunctionCallState, itemId: string | undefined, callId: string | undefined): void {
    if (itemId !== undefined) {
      const existing = this.#findByItem(itemId);
      if (existing !== undefined && existing !== state) {
        throw new FunctionCallStateError('function_call_collision', 'The GPT subscription tool call identifiers conflicted.');
      }
      state.item_id ??= itemId;
      this.by_item_id.set(itemId, this.#snapshot(state));
    }
    if (callId !== undefined) {
      const existing = this.#findByCall(callId);
      if (existing !== undefined && existing !== state) {
        throw new FunctionCallStateError('function_call_collision', 'The GPT subscription tool call identifiers conflicted.');
      }
      state.call_id ??= callId;
      this.by_call_id.set(callId, this.#snapshot(state));
    }
    this.#refreshIndexes(state);
  }

  #mergeFields(state: MutableFunctionCallState, value: Record<string, unknown>): void {
    this.#mergeName(state, value['name']);
    const argumentsValue = value['arguments'];
    if (typeof argumentsValue === 'string') {
      if (Buffer.byteLength(argumentsValue, 'utf8') > MAX_ARGUMENT_BYTES) {
        throw new FunctionCallStateError('arguments_limit', 'The GPT subscription tool arguments exceeded the collected limit.');
      }
      // A streamed delta is authoritative when a later item snapshot omits
      // arguments.  A complete snapshot can replace the empty initial value,
      // but never silently discard accumulated text.
      if (state.arguments_text.length === 0 || argumentsValue.length >= state.arguments_text.length) state.arguments_text = argumentsValue;
    }
    this.#refreshIndexes(state);
  }

  #mergeName(state: MutableFunctionCallState, value: unknown): void {
    if (value === undefined) return;
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_NAME_LENGTH) {
      throw new FunctionCallStateError('malformed_tool_call', 'The GPT subscription tool call was malformed.');
    }
    if (state.name !== undefined && state.name !== value) {
      throw new FunctionCallStateError('function_call_collision', 'The GPT subscription tool identifiers conflicted.');
    }
    state.name = value;
  }

  #emitReady(state: MutableFunctionCallState, atFinalization = false): readonly AssembledFunctionCall[] {
    if (state.emitted) return [];
    // item.done is allowed to arrive before argument deltas are complete.  A
    // complete arguments.done, however, is a finalization boundary.
    if (!state.arguments_done && !atFinalization && !state.item_done) return [];
    if (state.call_id === undefined || state.name === undefined || state.name.length === 0) {
      if (!atFinalization) return [];
      throw new FunctionCallStateError('malformed_tool_call', 'The GPT subscription tool call was malformed.');
    }
    if (state.arguments_text.length === 0) {
      if (!atFinalization) return [];
      throw new FunctionCallStateError('malformed_tool_call', 'The GPT subscription tool call was malformed.');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(state.arguments_text);
    } catch {
      if (!atFinalization) return [];
      throw new FunctionCallStateError('malformed_tool_arguments', 'The GPT subscription tool arguments were malformed.');
    }
    if (!isRecord(parsed)) {
      throw new FunctionCallStateError('malformed_tool_arguments', 'The GPT subscription tool arguments were not an object.');
    }
    state.emitted = true;
    this.#refreshIndexes(state);
    return [{ call_id: state.call_id, name: state.name, arguments: parsed }];
  }

  #findByItem(itemId: string): MutableFunctionCallState | undefined {
    return this.#states.find((state) => state.item_id === itemId);
  }

  #findByCall(callId: string): MutableFunctionCallState | undefined {
    return this.#states.find((state) => state.call_id === callId);
  }

  #refreshIndexes(state: MutableFunctionCallState): void {
    const snapshot = this.#snapshot(state);
    if (state.item_id !== undefined) this.by_item_id.set(state.item_id, snapshot);
    if (state.call_id !== undefined) this.by_call_id.set(state.call_id, snapshot);
  }

  #snapshot(state: MutableFunctionCallState): FunctionCallStateSnapshot {
    return Object.freeze({
      ...(state.item_id === undefined ? {} : { item_id: state.item_id }),
      ...(state.call_id === undefined ? {} : { call_id: state.call_id }),
      ...(state.name === undefined ? {} : { name: state.name }),
      arguments_text: state.arguments_text,
      item_done: state.item_done,
      arguments_done: state.arguments_done,
      emitted: state.emitted,
    });
  }
}

function normalizeId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
