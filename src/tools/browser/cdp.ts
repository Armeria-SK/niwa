import type { Readable, Writable } from 'node:stream';

export interface CdpEvent { method: string; params: Record<string, unknown>; sessionId?: string }
type Pending = { sessionId: string | undefined; resolve(value: Record<string, unknown>): void; reject(error: Error): void };

/** Chromium's dedicated debugging pipe, owned by the browser worker. Never discovers desktop tabs or ports. */
export class CdpPipe {
  #next = 0;
  #pending = new Map<number, Pending>();
  #buffer = Buffer.alloc(0);
  #closed = false;
  #listeners = new Set<(event: CdpEvent) => void>();
  constructor(private input: Readable, private output: Writable) {
    input.on('data', this.#receive); input.once('end', this.close); input.once('close', this.close); input.once('error', this.close);
    output.once('error', this.close); output.once('close', this.close);
  }
  onEvent(listener: (event: CdpEvent) => void): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  send(method: string, params: Record<string, unknown> = {}, options: { sessionId?: string; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<Record<string, unknown>> {
    const timeoutMs = options.timeoutMs ?? 30_000;
    if (this.#closed || this.#pending.size >= 128 || !/^[A-Za-z]+\.[A-Za-z]+$/.test(method) ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000 || options.signal?.aborted)
      return Promise.reject(new Error('Browser command is unavailable or invalid'));
    const id = ++this.#next;
    const message = Buffer.from(JSON.stringify({ id, method, params, ...(options.sessionId ? { sessionId: options.sessionId } : {}) }) + '\0');
    if (message.length > 8 * 1024 * 1024) return Promise.reject(new Error('Browser command is too large'));
    return new Promise((resolve, reject) => {
      const finish = (error?: Error, value: Record<string, unknown> = {}) => {
        if (!this.#pending.delete(id)) return;
        clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(value);
      };
      const abort = () => finish(new Error('Browser command interrupted; outcome unknown'));
      const timer = setTimeout(() => finish(new Error('Browser command timed out; outcome unknown')), timeoutMs);
      this.#pending.set(id, { sessionId: options.sessionId, resolve: value => finish(undefined, value), reject: error => finish(error) });
      options.signal?.addEventListener('abort', abort, { once: true });
      try { this.output.write(message, error => { if (error) this.close(); }); } catch { this.close(); }
    });
  }
  #receive = (chunk: Buffer) => {
    if (this.#closed) return;
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    if (this.#buffer.length > 8 * 1024 * 1024) { this.close(); return; }
    for (let end = this.#buffer.indexOf(0); end !== -1; end = this.#buffer.indexOf(0)) {
      const raw = this.#buffer.subarray(0, end); this.#buffer = this.#buffer.subarray(end + 1);
      try {
        const message: unknown = JSON.parse(raw.toString('utf8'));
        if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid browser frame');
        const frame = message as Record<string, unknown>;
        if (typeof frame.id === 'number') {
          const pending = this.#pending.get(frame.id);
          if (pending && frame.sessionId !== pending.sessionId) { this.close(); return; }
          if (frame.error) pending?.reject(new Error('Browser rejected the command'));
          else pending?.resolve((frame.result ?? {}) as Record<string, unknown>);
        } else if (typeof frame.method === 'string') {
          const event = { method: frame.method, params: (frame.params ?? {}) as Record<string, unknown>,
            ...(typeof frame.sessionId === 'string' ? { sessionId: frame.sessionId } : {}) };
          for (const listener of this.#listeners) listener(event);
        }
      } catch { this.close(); return; }
    }
  };
  close = () => {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) pending.reject(new Error('Browser connection closed; outcome unknown'));
    this.#pending.clear(); this.#listeners.clear(); this.#buffer = Buffer.alloc(0);
    this.input.off('data', this.#receive); this.input.off('end', this.close);
  };
}
