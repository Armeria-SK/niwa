import type { BrowserInteraction } from './interaction.ts';
import type { Readable, Writable } from 'node:stream';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { BrowserWire } from './wire.ts';
import { BrowserRequests } from './requests.ts';
import type { BrowserSnapshot } from './page.ts';
import { formSchema } from './form.ts';

export const snapshotSchema = Type.Object({
  revision: Type.String({ minLength: 1, maxLength: 64 }), url: Type.String({ maxLength: 4096 }),
  title: Type.String({ maxLength: 500 }), text: Type.String({ maxLength: 20000 }), untrusted: Type.Literal(true),
  elements: Type.Array(Type.Object({ ref: Type.Integer({ minimum: 0, maximum: 99 }), role: Type.String({ maxLength: 100 }),
    name: Type.String({ maxLength: 200 }), href: Type.Optional(Type.String({ maxLength: 4096 })) }, { additionalProperties: false }), { maxItems: 100 }),
  blocked: Type.Array(Type.String({ maxLength: 100 }), { maxItems: 10 }),
  form: Type.Optional(formSchema),
}, { additionalProperties: false });
const resourceSchema = Type.Object({ url: Type.String({ maxLength: 4096 }), method: Type.String({ maxLength: 16 }),
  resourceType: Type.String({ maxLength: 32 }) }, { additionalProperties: false });

/** Trusted side of a worker pipe. The worker cannot choose headers, credentials, or unrestricted network requests. */
export class BrowserSession {
  #wire: BrowserWire; #active: BrowserRequests | undefined; #busy = false; #snapshot: BrowserSnapshot | undefined;
  constructor(input: Readable, output: Writable, private dispose: () => Promise<void>,
    private broker: (url: string) => BrowserRequests = url => new BrowserRequests(url)) {
    this.#wire = new BrowserWire(input, output, async (method, request, signal) => {
      if (method !== 'resource.read' || !this.#active || !Value.Check(resourceSchema, request)) throw new Error('Unexpected resource request');
      return this.#active.get(request, signal);
    });
  }
  async #action(method: string, input: unknown, url?: string, signal?: AbortSignal): Promise<BrowserSnapshot> {
    if (this.#busy) throw new Error('Browser session busy');
    const broker = url ? this.broker(url) : undefined;
    this.#busy = true; this.#snapshot = undefined; this.#active = broker;
    const abort = () => { void this.close().catch(() => {}); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const result = await this.#wire.request(method, input, signal);
      if (!Value.Check(snapshotSchema, result) || new Set(result.elements.map(el => el.ref)).size !== result.elements.length)
        throw new Error('Invalid browser observation');
      this.#snapshot = result; return structuredClone(result);
    } catch (error) { await this.close(); throw error; }
    finally { signal?.removeEventListener('abort', abort); this.#active = undefined; this.#busy = false; }
  }
  navigate(url: string, signal?: AbortSignal) { return this.#action('browser.navigate', { url }, url, signal); }
  snapshot(signal?: AbortSignal) { return this.#action('browser.snapshot', {}, undefined, signal); }
  follow(revision: string, ref: number, signal?: AbortSignal) {
    const element = this.#snapshot?.elements.find(item => item.ref === ref);
    if (!revision || revision !== this.#snapshot?.revision || !element?.href) throw new Error('Browser reference is stale or is not a link');
    return this.#action('browser.follow', { revision, ref }, element.href, signal);
  }
  interact(input: BrowserInteraction, signal?: AbortSignal) {
    if (!input.revision || input.revision !== this.#snapshot?.revision) throw new Error('Stale interaction reference');
    return this.#action('browser.interact', input, undefined, signal);
  }
  prepareForm(revision: string, ref: number, fields: { ref: number; value: string }[], signal?: AbortSignal) {
    if (!revision || revision !== this.#snapshot?.revision || !this.#snapshot.elements.some(element => element.ref === ref)) throw new Error('Stale form reference');
    return this.#action('browser.form', { revision, ref, fields }, undefined, signal);
  }
  #closing: Promise<void> | undefined;
  close() { return this.#closing ??= (async () => { this.#snapshot = undefined; this.#wire.close(); await this.dispose(); })(); }
}
