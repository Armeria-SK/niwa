import { spawn } from 'node:child_process';

export interface Captured { code: number; stdout: string; stderr: string; truncated: boolean; timedOut: boolean }
export interface CaptureOptions { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal | undefined; tail?: number; strict?: number }

/** Last `limit` bytes as valid UTF-8 that never exceeds `limit` bytes, even when invalid input expands to U+FFFD. */
export function tailText(bytes: Buffer, limit: number): string {
  let start = Math.max(0, bytes.length - limit);
  while (start > 0 && start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
  const text = bytes.subarray(start).toString('utf8');
  return Buffer.byteLength(text) > limit ? tailText(Buffer.from(text), limit) : text;
}

class Tail {
  #chunks: Buffer[] = []; #size = 0; dropped = false;
  constructor(private limit: number, private strict?: number) {}
  push(chunk: Buffer): boolean {
    this.#chunks.push(chunk); this.#size += chunk.length;
    if (this.strict !== undefined) return this.#size <= this.strict;
    if (this.#size > this.limit * 2) { const all = Buffer.concat(this.#chunks); this.#chunks = [all.subarray(all.length - this.limit)]; this.#size = this.limit; this.dropped = true; }
    return true;
  }
  text() { const all = Buffer.concat(this.#chunks); if (all.length > this.limit) this.dropped = true; return tailText(all, this.limit); }
}

/**
 * Runs a process to completion while keeping only the last bytes of each stream, so noisy output never kills the program.
 * `strict` instead rejects (and kills) when a stream exceeds that many bytes. Our own timeout resolves with `timedOut`;
 * an abort, a spawn failure or an outside signal rejects because the outcome is then unknown.
 */
export function capture(file: string, args: string[], options: CaptureOptions): Promise<Captured> {
  return new Promise((resolve, reject) => {
    const tail = options.tail ?? 65536, out = new Tail(tail, options.strict), err = new Tail(tail, options.strict);
    let timedOut = false, settled = false;
    const interrupted = () => new Error('Isolated program interrupted; outcome unknown');
    if (options.signal?.aborted) { reject(interrupted()); return; }
    const child = spawn(file, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const finish = (action: () => void) => { if (settled) return; settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort', abort); action(); };
    const abort = () => { child.kill('SIGKILL'); finish(() => reject(interrupted())); };
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, options.timeoutMs);
    options.signal?.addEventListener('abort', abort, { once: true });
    const feed = (sink: Tail) => (chunk: Buffer) => { if (!sink.push(chunk)) { child.kill('SIGKILL'); finish(() => reject(interrupted())); } };
    child.stdout.on('data', feed(out)); child.stderr.on('data', feed(err));
    child.on('error', () => finish(() => reject(interrupted())));
    child.on('close', (code, signal) => finish(() => {
      if (!timedOut && (signal || typeof code !== 'number')) { reject(interrupted()); return; }
      resolve({ code: timedOut ? 124 : code!, stdout: out.text(), stderr: err.text(), truncated: out.dropped || err.dropped, timedOut });
    }));
  });
}
