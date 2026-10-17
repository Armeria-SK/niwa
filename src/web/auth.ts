import type { IncomingMessage } from 'node:http';

/** A Tailscale login name such as alice@example.com: no spaces, and no comma (two copies of the header arrive joined by one). */
const LOGIN = /^[^\s,]{1,256}$/;

/** The browser-facing origin Niwa answers to. There is no login: whoever can reach this origin (for example over the owner's Tailscale network)
 * uses Niwa as its administrator, and so can any program on this computer that calls it. What stays enforced is where a request comes from:
 * it must name this host (a DNS-rebinding page names another), every write must come from this origin, and a request a browser marks as sent
 * by another site is refused, so pages the owner visits elsewhere can neither change nor read anything here.
 * When the origin is not this computer, a request must also carry the Tailscale-User-Login header that Tailscale Serve adds for a person on the
 * owner's tailnet. Serve removes the same header sent from outside, and Funnel (public) traffic never gets it, so a Funnel set up by mistake
 * does not hand the administrator to the internet. Niwa listens only on 127.0.0.1, so only programs on this computer could forge it directly;
 * a reverse proxy other than Serve passes a forged header through, so this is no safeguard behind one. */
export class WebAuth {
  readonly origin: string;
  readonly #local: boolean;
  readonly #logins: ReadonlySet<string>;
  /** `logins` (config/niwa.json `tailscaleLogins`) narrows remote access to these Tailscale accounts; empty lets anyone Serve identifies in. */
  constructor(origin: string, logins: readonly string[] = []) {
    const url = new URL(origin);
    if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol)) throw new Error('Expected an exact web origin');
    this.#local = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
    if (url.protocol !== 'https:' && !this.#local) throw new Error('Remote web access requires HTTPS');
    if (logins.some(login => !LOGIN.test(login))) throw new Error('Invalid Tailscale login');
    this.origin = origin;
    this.#logins = new Set(logins.map(login => login.toLowerCase()));
  }
  /** A local origin needs nothing more. A remote one needs the person Tailscale Serve names (one value, no list), and one of the allowed accounts when any are set. */
  fromTailnet(req: IncomingMessage): boolean {
    if (this.#local) return true;
    const login = req.headers['tailscale-user-login'];
    return typeof login === 'string' && LOGIN.test(login) && (!this.#logins.size || this.#logins.has(login.toLowerCase()));
  }
  validOrigin(req: IncomingMessage): boolean {
    return req.headers.host === new URL(this.origin).host
      && (!req.headers.origin || req.headers.origin === this.origin)
      && (!['POST', 'PATCH', 'DELETE', 'PUT'].includes(req.method ?? '') || req.headers.origin === this.origin);
  }
  /** Browsers say who sent a request. Niwa's own page is the same origin; typing the address or a bookmark is 'none'. Other programs send nothing. */
  sentByThisSite(req: IncomingMessage): boolean {
    const site = req.headers['sec-fetch-site'];
    return site === undefined || site === 'same-origin' || site === 'none';
  }
}
