import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** Host-supplied random admin key; provider credentials are never accepted as a login. */
export class WebAuth {
  #key: Buffer;
  #sessions = new Map<string, number>();
  #failures = new Map<string, number[]>();
  readonly origin: string;
  #cookie: string;
  #secure: boolean;
  constructor(origin: string, adminKey: string) {
    const url = new URL(origin);
    if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol)) throw new Error('Expected an exact web origin');
    if (url.protocol !== 'https:' && !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) throw new Error('Remote web access requires HTTPS');
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(adminKey)) throw new Error('Use a random admin key of at least 32 bytes');
    this.origin = origin; this.#key = this.#hash(adminKey); this.#secure = url.protocol === 'https:';
    this.#cookie = this.#secure ? '__Host-niwa-session' : 'niwa-session';
  }
  #hash(value: string): Buffer { return createHash('sha256').update(value).digest(); }
  validOrigin(req: IncomingMessage): boolean {
    return req.headers.host === new URL(this.origin).host
      && (!req.headers.origin || req.headers.origin === this.origin)
      && (!['POST', 'PATCH', 'DELETE', 'PUT'].includes(req.method ?? '') || req.headers.origin === this.origin);
  }
  #token(req: IncomingMessage): string {
    return (req.headers.cookie ?? '').split(';').map(item => item.trim()).find(item => item.startsWith(`${this.#cookie}=`))?.slice(this.#cookie.length + 1) ?? '';
  }
  #prune(): void { for (const [token, expiry] of this.#sessions) if (expiry <= Date.now()) this.#sessions.delete(token); }
  authenticated(req: IncomingMessage): boolean {
    this.#prune();
    return this.#sessions.has(this.#hash(this.#token(req)).toString('hex'));
  }
  /** Failures are counted per client address, so a stranger's guesses cannot lock out the administrator on another address. */
  login(key: string, req: IncomingMessage, res: ServerResponse): 'ok' | 'denied' | { retryAfter: number } {
    const client = req.socket.remoteAddress ?? '', now = Date.now();
    for (const [address, times] of this.#failures) if (times.every(time => time <= now - 60_000)) this.#failures.delete(address);
    const recent = (this.#failures.get(client) ?? []).filter(time => time > now - 60_000);
    if (recent.length >= 10) return { retryAfter: Math.max(1, Math.ceil((recent[0]! + 60_000 - now) / 1000)) };
    if (!timingSafeEqual(this.#hash(key), this.#key)) {
      this.#failures.delete(client); this.#failures.set(client, [...recent, now]);
      if (this.#failures.size > 256) this.#failures.delete(this.#failures.keys().next().value!);
      return 'denied';
    }
    this.#failures.delete(client);
    this.#prune();
    this.#sessions.delete(this.#hash(this.#token(req)).toString('hex'));
    if (this.#sessions.size >= 32) this.#sessions.delete(this.#sessions.keys().next().value!);
    const token = randomBytes(32).toString('base64url');
    this.#sessions.set(this.#hash(token).toString('hex'), Date.now() + 8 * 60 * 60_000);
    this.#setCookie(res, token, 8 * 60 * 60);
    return 'ok';
  }
  logout(req: IncomingMessage, res: ServerResponse): void {
    this.#sessions.delete(this.#hash(this.#token(req)).toString('hex'));
    this.#setCookie(res, '', 0);
  }
  #setCookie(res: ServerResponse, token: string, seconds: number): void {
    res.setHeader('Set-Cookie', `${this.#cookie}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${seconds}${this.#secure ? '; Secure' : ''}`);
  }
}
