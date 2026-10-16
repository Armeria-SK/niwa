interface Lane { active: number; waiters: Array<() => void> }

/** Per-endpoint concurrency gate. Ollama queues excess requests itself, which would make the wait count against our timeouts. */
export class LocalLlmLimiter {
  #lanes = new Map<string, Lane>();

  /** Resolves with a one-shot release. An aborted waiter leaves the queue without taking a slot. */
  async acquire(key: string, limit: () => number, signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    const lane = this.#lanes.get(key) ?? { active: 0, waiters: [] };
    this.#lanes.set(key, lane);
    const pump = () => {
      while (lane.waiters.length && lane.active < limit()) { lane.active++; lane.waiters.shift()!(); }
      if (!lane.active && !lane.waiters.length && this.#lanes.get(key) === lane) this.#lanes.delete(key);
    };
    const release = () => {
      let done = false;
      return () => { if (!done) { done = true; lane.active--; pump(); } };
    };
    if (!lane.waiters.length && lane.active < limit()) { lane.active++; return release(); }
    await new Promise<void>((resolve, reject) => {
      const waiter = () => { signal?.removeEventListener('abort', onAbort); resolve(); };
      const onAbort = () => {
        const index = lane.waiters.indexOf(waiter);
        if (index >= 0) lane.waiters.splice(index, 1);
        pump(); reject(signal!.reason);
      };
      lane.waiters.push(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    return release();
  }
}
