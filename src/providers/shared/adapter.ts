// Derived from Carried c695f855419ffc69d1e62b04f1de8de36c7c162d, core/providers/src/model-adapter.ts.
// Apache-2.0. Modified for Niwa; see THIRD_PARTY_NOTICES.md and provenance/carried.json.
import type {
  ModelAdapterCapabilities,
  ModelEvent,
  ModelEventLimitDimension,
  ModelFailureCode,
  ModelRequest,
  ReasoningEffort,
} from '../../contracts/index.ts';
import { modelEventSchema } from '../../contracts/index.ts';
import { Value } from '@sinclair/typebox/value';
import { redactSecrets, sanitizeModelInputText } from '../../shared/redaction.ts';

export type { ModelEvent } from '../../contracts/index.ts';

export interface ModelRunOptions {
  timeout_ms: number;
  signal?: AbortSignal;
}

/** Strict one-shot event stream. Providers expose an AsyncIterable only. */
export type ModelEventStream = AsyncIterable<ModelEvent>;

export type ModelEventSource = AsyncIterable<ModelEvent>;

export interface CollectModelEventsPolicy {
  readonly signal?: AbortSignal;
  readonly timeout_ms?: number;
  readonly max_events?: number;
  readonly max_total_bytes?: number;
  readonly max_tool_calls?: number;
  /** Called after a structurally valid Usage event is observed. Usage is
   * advisory: its presence, consistency, and reported totals never determine
   * whether the collector accepts the surrounding response. */
  readonly on_usage?: (usage: Extract<ModelEvent, { readonly type: 'usage' }>) => void;
  /** Called for every attempted tool-call-shaped event, including one that
   * later fails schema validation, so callers cannot evade call accounting. */
  readonly on_tool_call?: () => void;
}

/**
 * Consume exactly one provider stream with bounded, ordered validation. A
 * malformed iterator or safety-limit violation becomes a safe terminal `failed`
 * event so every caller observes the same structured failure contract.
 */
export async function collectModelEvents(
  source: ModelEventSource,
  policy: CollectModelEventsPolicy = {},
): Promise<readonly ModelEvent[]> {
  const maxEvents = boundedLimit(policy.max_events, 1_000, 1_000_000, 1);
  const maxBytes = boundedLimit(policy.max_total_bytes, 16 * 1024 * 1024, 256 * 1024 * 1024, 0);
  const maxToolCalls = boundedLimit(policy.max_tool_calls, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 0);
  if (maxEvents === undefined || maxBytes === undefined || maxToolCalls === undefined) {
    return [streamFailure('INVALID_REQUEST', 'The model stream limits are invalid.')];
  }
  if (policy.timeout_ms !== undefined && (!Number.isSafeInteger(policy.timeout_ms) || policy.timeout_ms < 1)) {
    return [streamFailure('INVALID_REQUEST', 'The model stream timeout is invalid.')];
  }

  let iterator: AsyncIterator<ModelEvent> | undefined;
  const values: ModelEvent[] = [];
  let totalBytes = 0;
  let toolCalls = 0;
  let terminal = false;
  let aborted = false;
  let timeout = false;
  let iteratorCancelled = false;
  const startedAt = Date.now();
  const cancel = (): void => {
    if (iteratorCancelled) return;
    iteratorCancelled = true;
    cancelIterator(iterator);
  };
  const onAbort = (): void => { aborted = true; cancel(); };
  policy.signal?.addEventListener('abort', onAbort, { once: true });
  const cleanup = (): void => policy.signal?.removeEventListener('abort', onAbort);
  try {
    if (source === null || source === undefined || typeof (source as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] !== 'function') {
      return [streamFailure('INVALID_RESPONSE', 'The Model Adapter returned a non-AsyncIterable stream.')];
    }
    iterator = toAsyncIterator(source);
    for (;;) {
      if (aborted || policy.signal?.aborted) { cancel(); return [streamFailure('ABORTED', 'The model stream was aborted.')]; }
      const remainingTimeout = policy.timeout_ms === undefined
        ? undefined
        : policy.timeout_ms - (Date.now() - startedAt);
      if (remainingTimeout !== undefined && remainingTimeout <= 0) {
        timeout = true;
        cancel();
        return [streamFailure('TIMED_OUT', 'The model stream timed out.')];
      }
      const next = await nextWithTimeout(iterator, remainingTimeout, policy.signal, () => { timeout = true; cancel(); }, () => { aborted = true; cancel(); });
      if (next === undefined) {
        cancel();
        if (aborted || policy.signal?.aborted) return [streamFailure('ABORTED', 'The model stream was aborted.')];
        return [streamFailure(timeout ? 'TIMED_OUT' : 'PROVIDER_ERROR', timeout ? 'The model stream timed out.' : 'The model stream could not be read.')];
      }
      if (next.done) {
        if (!terminal) { cancel(); return [streamFailure('INVALID_RESPONSE', 'The model stream ended without a terminal event.')]; }
        return Object.freeze(values);
      }
      const event = next.value;
      if (terminal) { cancel(); return [streamFailure('INVALID_RESPONSE', 'The model stream emitted an event after its terminal event.')]; }
      if (isRecord(event) && event['type'] === 'tool_call') {
        try { policy.on_tool_call?.(); } catch { /* accounting observers are advisory */ }
      }
      if (!Value.Check(modelEventSchema, event)) { cancel(); return [streamFailure('INVALID_RESPONSE', 'The model stream emitted an invalid event.')]; }
      const serialized = JSON.stringify(event);
      const nextEventCount = values.length + 1;
      const nextTotalBytes = totalBytes + Buffer.byteLength(serialized, 'utf8');
      const nextToolCalls = toolCalls + (event.type === 'tool_call' ? 1 : 0);
      const limitCounters: ModelEventLimitCounters = {
        event_count: nextEventCount,
        max_events: maxEvents,
        total_bytes: nextTotalBytes,
        max_total_bytes: maxBytes,
        tool_call_count: nextToolCalls,
        max_tool_calls: maxToolCalls,
      };
      if (nextEventCount > maxEvents) { cancel(); return [streamLimitFailure('event_count', limitCounters)]; }
      if (nextTotalBytes > maxBytes) { cancel(); return [streamLimitFailure('bytes', limitCounters)]; }
      totalBytes = nextTotalBytes;
      if (event.type === 'usage') {
        try { policy.on_usage?.(event); } catch { /* accounting observers are advisory */ }
      }
      if (event.type === 'tool_call') {
        toolCalls = nextToolCalls;
        if (toolCalls > maxToolCalls) { cancel(); return [streamLimitFailure('tool_call_count', limitCounters)]; }
      }
      let safeEvent: ModelEvent;
      try {
        safeEvent = sanitizeModelEvent(event);
      } catch {
        cancel();
        return [streamFailure('INVALID_RESPONSE', 'The model stream emitted secret-like tool arguments.')];
      }
      values.push(safeEvent);
      if (safeEvent.type === 'completed' || safeEvent.type === 'failed') {
        terminal = true;
      }
    }
  } catch (error) {
    cancel();
    if (aborted || policy.signal?.aborted) return [streamFailure('ABORTED', 'The model stream was aborted.')];
    if (timeout) return [streamFailure('TIMED_OUT', 'The model stream timed out.')];
    if (error instanceof InvalidModelEventError) return [streamFailure('INVALID_RESPONSE', error.message)];
    return [streamFailure('PROVIDER_ERROR', `The model stream failed safely: ${safeStreamError(error)}`)];
  } finally {
    cleanup();
  }
}

/** Wrap a buffered response in a strict one-shot async stream. */
export function createBufferedModelEventStream(
  source: Promise<readonly ModelEvent[]> | readonly ModelEvent[],
  onCancel?: () => void,
): ModelEventStream {
  const promise = Promise.resolve(source);
  promise.catch(() => undefined);
  let consumed = false;
  let cancelled = false;
  return {
    [Symbol.asyncIterator](): AsyncIterator<ModelEvent> {
      if (consumed) {
        return { next: async () => { throw new Error('Model event streams can only be consumed once.'); } };
      }
      consumed = true;
      let events: readonly ModelEvent[] | undefined;
      let index = 0;
      return {
        async next(): Promise<IteratorResult<ModelEvent>> {
          events ??= await promise;
          if (index >= events.length) return { done: true, value: undefined };
          return { done: false, value: events[index++] as ModelEvent };
        },
        async return(): Promise<IteratorResult<ModelEvent>> {
          index = Number.MAX_SAFE_INTEGER;
          if (!cancelled) {
            cancelled = true;
            try { onCancel?.(); } catch { /* cancellation is best effort */ }
          }
          return { done: true, value: undefined };
        },
      };
    },
  };
}

/** @deprecated Use createBufferedModelEventStream. */
export const createModelEventStream = createBufferedModelEventStream;

export interface ModelAdapter {
  readonly adapter_id: string;
  readonly capabilities: ModelAdapterCapabilities;
  /** Provider-advertised active/default capacity in tokens; absent means unknown, not the request budget. */
  readonly context_window?: number;
  readonly supported_efforts?: readonly ReasoningEffort[];
  /** Providers return a one-shot AsyncIterable only. */
  run(request: ModelRequest, options: ModelRunOptions): ModelEventSource;
}

function toAsyncIterator(source: ModelEventSource): AsyncIterator<ModelEvent> {
  return source[Symbol.asyncIterator]();
}

async function nextWithTimeout(
  iterator: AsyncIterator<ModelEvent>,
  timeoutMs: number | undefined,
  signal: AbortSignal | undefined,
  onTimeout: () => void,
  onAbort: () => void,
): Promise<IteratorResult<ModelEvent> | undefined> {
  const pending = Promise.resolve().then(async () => await iterator.next());
  // A provider iterator is untrusted; ensure a late rejection after timeout
  // or cancellation cannot become an unhandled process-level rejection.
  pending.catch(() => undefined);
  if (timeoutMs === undefined && signal === undefined) return await pending;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  try {
    const waits: Array<Promise<IteratorResult<ModelEvent> | undefined>> = [pending];
    if (timeoutMs !== undefined) waits.push(new Promise<undefined>((resolve) => { timer = setTimeout(() => { onTimeout(); resolve(undefined); }, timeoutMs); }));
    if (signal !== undefined) {
      waits.push(new Promise<undefined>((resolve) => {
        abortListener = () => { onAbort(); resolve(undefined); };
        signal.addEventListener('abort', abortListener, { once: true });
        if (signal.aborted) abortListener();
      }));
    }
    return await Promise.race(waits);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abortListener !== undefined) signal?.removeEventListener('abort', abortListener);
  }
}

function cancelIterator(iterator: AsyncIterator<ModelEvent> | undefined): void {
  if (iterator?.return === undefined) return;
  try { void Promise.resolve(iterator.return()).catch(() => undefined); }
  catch { /* a hostile iterator must not escape the fail-closed path */ }
}

function streamFailure(code: ModelFailureCode, message: string): ModelEvent {
  return { type: 'failed', error: { code, message: redactSecrets(message).slice(0, 2_048), retryable: code === 'TIMED_OUT' || code === 'PROVIDER_ERROR' } };
}

interface ModelEventLimitCounters {
  readonly event_count: number;
  readonly max_events: number;
  readonly total_bytes: number;
  readonly max_total_bytes: number;
  readonly tool_call_count: number;
  readonly max_tool_calls: number;
}

function streamLimitFailure(
  dimension: ModelEventLimitDimension,
  counters: ModelEventLimitCounters,
): ModelEvent {
  const observed = dimension === 'event_count'
    ? counters.event_count
    : dimension === 'bytes'
      ? counters.total_bytes
      : counters.tool_call_count;
  const maximum = dimension === 'event_count'
    ? counters.max_events
    : dimension === 'bytes'
      ? counters.max_total_bytes
      : counters.max_tool_calls;
  return {
    type: 'failed',
    error: {
      code: 'OUTPUT_LIMIT',
      message: `The model stream exceeded its ${dimension} limit (${observed}/${maximum}).`,
      retryable: false,
      limit_dimension: dimension,
      ...counters,
    },
  };
}

function sanitizeModelEvent(event: ModelEvent): ModelEvent {
  if (event.type === 'text_delta') return { ...event, text: sanitizeModelInputText(event.text).text };
  if (event.type === 'reasoning_summary') return { ...event, summary: sanitizeModelInputText(event.summary).text };
  if (event.type === 'failed') return { ...event, error: { ...event.error, message: redactSecrets(event.error.message).slice(0, 2_048) } };
  if (event.type === 'tool_call' && containsSecretLikeToolArguments(event.arguments)) {
    throw new InvalidModelEventError();
  }
  return event;
}

class InvalidModelEventError extends Error {
  override readonly name = 'InvalidModelEventError';
  constructor() { super('The model stream emitted secret-like tool arguments.'); }
}

function containsSecretLikeToolArguments(value: unknown, depth = 0): boolean {
  if (depth > 8) return true;
  if (typeof value === 'string') return redactSecrets(value) !== value;
  if (Array.isArray(value)) return value.some((entry) => containsSecretLikeToolArguments(entry, depth + 1));
  if (typeof value !== 'object' || value === null) return false;
  return Object.entries(value).some(([key, child]) => /(?:token|secret|password|passwd|api[_-]?key|auth|cookie|credential)/iu.test(key) || containsSecretLikeToolArguments(child, depth + 1));
}

function safeStreamError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'iterator failure';
  return Array.from(redactSecrets(message), (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f ? ' ' : character;
  }).join('').slice(0, 512);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedLimit(value: number | undefined, fallback: number, maximum: number, minimum: number): number | undefined {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum) return undefined;
  return Math.min(value, maximum);
}
