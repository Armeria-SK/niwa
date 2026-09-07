import type { Readable, Writable } from 'node:stream';
import { BrowserRequestBlocked } from './requests.ts';

type Handler = (method: string, input: unknown, signal: AbortSignal) => Promise<unknown>;
/** Private parent/worker pipe. No socket discovery and no JavaScript or shell evaluation. */
export class BrowserWire {
  #next = 0; #buffer = Buffer.alloc(0); #closed = false;
  #pending = new Map<number, { finish(error?: Error, value?: unknown): void }>();
  #handling = new Set<number>(); #lifetime = new AbortController();
  constructor(private input: Readable, private output: Writable, private handler: Handler) {
    input.on('data', this.#receive); input.once('end', this.close); input.once('close', this.close); input.once('error', this.close);
    output.once('error', this.close); output.once('close', this.close);
  }
  #write(frame: unknown) {
    const bytes = Buffer.from(JSON.stringify(frame) + '\n');
    if (this.#closed || bytes.length > 512 * 1024 || this.output.writableLength > 1024 * 1024) throw new Error('Browser worker channel unavailable');
    this.output.write(bytes, error => { if (error) this.close(); });
  }
  request(method: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.#closed || this.#pending.size >= 64 || !/^[a-z]+\.[a-z]+$/.test(method) || signal?.aborted)
      return Promise.reject(new Error('Browser worker request unavailable'));
    const id = ++this.#next;
    return new Promise((resolve, reject) => {
      const abort = () => finish(new Error('Browser worker request interrupted; outcome unknown'));
      const timer = setTimeout(abort, 35_000);
      const finish = (error?: Error, value?: unknown) => {
        if (!this.#pending.delete(id)) return;
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(value);
      };
      this.#pending.set(id, { finish }); signal?.addEventListener('abort', abort, { once: true });
      try { this.#write({ id, method, input }); } catch { finish(new Error('Browser worker send failed')); }
    });
  }
  #receive = (chunk: Buffer) => {
    if (this.#closed) return;
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    if (this.#buffer.length > 1024 * 1024) { this.close(); return; }
    for (let end = this.#buffer.indexOf(10); end !== -1; end = this.#buffer.indexOf(10)) {
      const raw = this.#buffer.subarray(0, end); this.#buffer = this.#buffer.subarray(end + 1);
      try {
        if (raw.length > 512 * 1024) throw new Error('Oversized worker frame');
        const frame = JSON.parse(raw.toString('utf8'));
        if (!frame || !Number.isSafeInteger(frame.id) || frame.id < 1) throw new Error('Invalid worker frame');
        if (typeof frame.method === 'string') {
          if (!/^[a-z]+\.[a-z]+$/.test(frame.method) || this.#handling.has(frame.id) || this.#handling.size >= 64)
            throw new Error('Invalid worker request');
          this.#handling.add(frame.id); void this.#handle(frame.id, frame.method, frame.input);
        } else if (typeof frame.ok === 'boolean') {
          const error = ['approval_required', 'request_limit', 'response_limit'].includes(frame.reason) ?
            new BrowserRequestBlocked(frame.reason) : new Error('Browser worker rejected request');
          this.#pending.get(frame.id)?.finish(frame.ok ? undefined : error, frame.value);
        } else throw new Error('Invalid worker response');
      } catch { this.close(); return; }
    }
    if (this.#buffer.length > 512 * 1024) this.close();
  };
  async #handle(id: number, method: string, input: unknown) {
    try { this.#write({ id, ok: true, value: await this.handler(method, input, this.#lifetime.signal) }); }
    catch (error) { try { this.#write({ id, ok: false, ...(error instanceof BrowserRequestBlocked ? { reason: error.reason } : {}) }); } catch { this.close(); } }
    finally { this.#handling.delete(id); }
  }
  close = () => {
    if (this.#closed) return;
    this.#closed = true; this.#lifetime.abort(); this.#buffer = Buffer.alloc(0);
    for (const request of this.#pending.values()) request.finish(new Error('Browser worker disconnected; outcome unknown'));
    this.input.off('data', this.#receive); this.input.destroy(); this.output.destroy();
  };
}
