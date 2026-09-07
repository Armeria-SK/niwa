import type { ModelAdapter } from './adapter.ts';
import { collectModelEvents } from './adapter.ts';

/** Share one gate per account; keep each bot/task's adapter and continuation separate. */
export class ConnectionGate {
  #tail: Promise<void> = Promise.resolve();

  async #acquire(signal: AbortSignal): Promise<() => void> {
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>(resolve => { release = resolve; });
    let onAbort!: () => void;
    try {
      await Promise.race([previous, new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      })]);
      signal.throwIfAborted();
      return release;
    } catch (error) {
      // Cancelling a queued request must not let its successors bypass the active request.
      void previous.then(release);
      throw error;
    } finally { signal.removeEventListener('abort', onAbort); }
  }

  wrap(adapter: ModelAdapter): ModelAdapter {
    if (adapter.capabilities.supports_parallel_sessions) return adapter;
    const gate = this;
    return {
      adapter_id: adapter.adapter_id,
      capabilities: adapter.capabilities,
      ...(adapter.supported_efforts ? { supported_efforts: adapter.supported_efforts } : {}),
      ...(adapter.context_window === undefined ? {} : { context_window: adapter.context_window }),
      async *run(request, options) {
        if (!Number.isSafeInteger(options.timeout_ms) || options.timeout_ms < 1 || options.timeout_ms > 2_147_483_647) {
          yield { type: 'failed', error: { code: 'INVALID_REQUEST', message: 'Invalid model timeout.', retryable: false } }; return;
        }
        const timeout = AbortSignal.timeout(options.timeout_ms);
        const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
        let release: (() => void) | undefined;
        try {
          release = await gate.#acquire(signal);
          const events = await collectModelEvents(adapter.run(request, { ...options, signal }),
            { signal, timeout_ms: options.timeout_ms, max_tool_calls: request.budget.max_tool_calls });
          release(); release = undefined;
          yield* events;
        } catch {
          yield { type: 'failed', error: { code: options.signal?.aborted ? 'ABORTED' : timeout.aborted ? 'TIMED_OUT' : 'PROVIDER_ERROR',
            message: 'Model connection could not complete.', retryable: true } };
        } finally { release?.(); }
      },
    };
  }
}
