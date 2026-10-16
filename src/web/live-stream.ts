import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Runtime, Actor } from '../runtime/runtime.ts';
import type { LiveEvent } from '../runtime/live.ts';
import type { WebAuth } from './auth.ts';

export const STREAMS_PER_SESSION = 4;
const MAX_STREAMS = 32, MAX_BUFFERED = 1024 * 1024;
type Stream = { session: string; req: IncomingMessage; res: ServerResponse };

/** Authenticated server-sent hints. Payloads carry only change counters and drafts from rooms the administrator can read. */
export class LiveStreams {
  readonly #runtime: Runtime; readonly #admin: Actor; readonly #auth: WebAuth;
  readonly #heartbeatMs: number; readonly #pollMs: number;
  #streams = new Set<Stream>();
  #heartbeat: ReturnType<typeof setInterval> | undefined; #poll: ReturnType<typeof setInterval> | undefined;
  #unsubscribe: (() => void) | undefined; #version = 0;
  constructor(runtime: Runtime, admin: Actor, auth: WebAuth, options: { heartbeatMs?: number; pollMs?: number } = {}) {
    this.#runtime = runtime; this.#admin = admin; this.#auth = auth;
    this.#heartbeatMs = options.heartbeatMs ?? 15_000; this.#pollMs = options.pollMs ?? 300;
  }
  get size(): number { return this.#streams.size; }
  /** Caller has already checked origin and authentication. */
  open(req: IncomingMessage, res: ServerResponse): void {
    const session = this.#auth.session(req);
    if (!session) { this.#reject(res, 401, 'authentication_required'); return; }
    if ([...this.#streams].filter(item => item.session === session).length >= STREAMS_PER_SESSION || this.#streams.size >= MAX_STREAMS) { this.#reject(res, 429, 'too_many_streams'); return; }
    const stream: Stream = { session, req, res };
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
    req.socket.setTimeout(0); req.socket.setKeepAlive(true, this.#heartbeatMs);
    this.#streams.add(stream); this.#start();
    const done = (): void => this.#remove(stream);
    req.once('close', done); res.once('close', done); res.once('error', done);
    this.#write(stream, `retry: 5000\n`);
    this.#send(stream, 'ready', { version: this.#version, drafts: this.#visibleDrafts() });
  }
  close(): void { for (const stream of [...this.#streams]) { stream.res.end(); this.#remove(stream); } }
  #reject(res: ServerResponse, status: number, error: string): void {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify({ error }));
  }
  #start(): void {
    if (this.#unsubscribe) return;
    this.#version = this.#readVersion();
    this.#unsubscribe = this.#runtime.live.subscribe(event => this.#relay(event));
    this.#heartbeat = setInterval(() => this.#beat(), this.#heartbeatMs); this.#heartbeat.unref();
    this.#poll = setInterval(() => this.#check(), this.#pollMs); this.#poll.unref();
  }
  #stop(): void {
    this.#unsubscribe?.(); this.#unsubscribe = undefined;
    clearInterval(this.#heartbeat); clearInterval(this.#poll); this.#heartbeat = this.#poll = undefined;
  }
  #remove(stream: Stream): void {
    if (!this.#streams.delete(stream)) return;
    if (!stream.res.writableEnded) stream.res.end();
    if (!this.#streams.size) this.#stop();
  }
  #readVersion(): number { try { return this.#runtime.changeVersion(this.#admin); } catch { return this.#version; } }
  #check(): void {
    const version = this.#readVersion();
    if (version === this.#version) return;
    this.#version = version;
    for (const stream of [...this.#streams]) this.#send(stream, 'changed', { version });
  }
  #beat(): void {
    for (const stream of [...this.#streams]) {
      // Logout or expiry ends the stream; the client then falls back to polling and sees the 401.
      if (this.#auth.session(stream.req) !== stream.session) { this.#remove(stream); continue; }
      this.#write(stream, ': ping\n\n');
    }
  }
  #visibleRooms(): Set<string> { try { return new Set(this.#runtime.rooms(this.#admin).map(room => room.id)); } catch { return new Set(); } }
  #visibleDrafts() { const rooms = this.#visibleRooms(); return this.#runtime.live.drafts().filter(draft => rooms.has(draft.room_id)); }
  #relay(event: LiveEvent): void {
    const room = event.type === 'draft' ? event.draft.room_id : event.room_id;
    if (!this.#visibleRooms().has(room)) return;
    const [name, data] = event.type === 'draft' ? ['draft', event.draft] as const : ['draft_end', { room_id: event.room_id, agent_id: event.agent_id, task_id: event.task_id, reason: event.reason }] as const;
    for (const stream of [...this.#streams]) this.#send(stream, name, data);
  }
  #send(stream: Stream, event: string, data: unknown): void { this.#write(stream, `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
  #write(stream: Stream, text: string): void {
    if (stream.res.writableEnded || stream.res.destroyed) { this.#remove(stream); return; }
    // A stalled viewer is dropped instead of buffering drafts without bound; it reconnects or polls.
    if (stream.res.writableLength > MAX_BUFFERED) { stream.res.destroy(); this.#remove(stream); return; }
    stream.res.write(text);
  }
}
