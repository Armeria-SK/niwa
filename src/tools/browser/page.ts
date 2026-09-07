import { randomUUID } from 'node:crypto';
import { CdpPipe, type CdpEvent } from './cdp.ts';
import { BrowserRequests, BrowserRequestBlocked } from './requests.ts';

export interface BrowserSnapshot {
  revision: string; url: string; title: string; text: string;
  elements: { ref: number; role: string; name: string; href?: string }[];
  blocked: string[]; untrusted: true;
}
type Broker = (url: string) => Pick<BrowserRequests, 'get'>;

/** Owned context only. The caller must also enforce OS-level network isolation. */
export class BrowserPage {
  #context = ''; #session = ''; #world = 0; #revision = ''; #busy = false; #closed = false;
  #lifetime = new AbortController();
  #active: { broker: ReturnType<Broker>; signal: AbortSignal; blocked: Set<string> } | undefined;
  #unsubscribe: () => void;
  constructor(private cdp: CdpPipe, private broker: Broker = url => new BrowserRequests(url)) {
    this.#unsubscribe = cdp.onEvent(event => { void this.#event(event).catch(() => this.close()); });
  }
  async open(signal?: AbortSignal) {
    if (this.#context || this.#closed) throw new Error('Browser page already opened or closed');
    const options = signal ? { signal } : {};
    try {
      const context = await this.cdp.send('Target.createBrowserContext', { disposeOnDetach: true }, options);
      this.#context = String(context.browserContextId);
      await this.cdp.send('Browser.setDownloadBehavior', { behavior: 'deny', browserContextId: this.#context }, options);
      const target = await this.cdp.send('Target.createTarget', { url: 'about:blank', browserContextId: this.#context }, options);
      const session = await this.cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true }, options);
      this.#session = String(session.sessionId);
      for (const [method, params] of [
        ['Page.enable', {}], ['Network.enable', {}], ['Network.setBypassServiceWorker', { bypass: true }],
        ['Network.setCacheDisabled', { cacheDisabled: true }], ['Fetch.enable', { patterns: [{ urlPattern: '*' }] }],
      ] as const) await this.#send(method, params, signal);
    } catch (error) { await this.close(); throw error; }
  }
  #send(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal) {
    return this.cdp.send(method, params, { sessionId: this.#session, ...(signal ? { signal } : {}) });
  }
  async #event(event: CdpEvent) {
    if (event.sessionId !== this.#session || this.#closed) return;
    if (event.method === 'Page.javascriptDialogOpening') {
      await this.#send('Page.handleJavaScriptDialog', { accept: false }); return;
    }
    if (event.method !== 'Fetch.requestPaused') return;
    const requestId = event.params.requestId;
    const active = this.#active;
    try {
      if (!active) throw new BrowserRequestBlocked('approval_required');
      const request = event.params.request as { url: string; method: string };
      const resource = await active.broker.get({ ...request, resourceType: String(event.params.resourceType) }, active.signal);
      if (this.#active !== active) throw new Error('Browser action finished');
      const redirected = new URL(resource.url).href !== new URL(request.url).href;
      await this.#send('Fetch.fulfillRequest', { requestId, responseCode: redirected ? 302 : 200,
        responseHeaders: redirected ? [{ name: 'Location', value: resource.url }] : [
          { name: 'Content-Type', value: resource.content_type }, { name: 'Cache-Control', value: 'no-store' },
        ], body: redirected ? '' : resource.body_base64 }, active.signal);
    } catch (error) {
      active?.blocked.add(error instanceof BrowserRequestBlocked ? error.reason : 'resource_failed');
      await this.#send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
    }
  }
  async navigate(url: string, signal?: AbortSignal): Promise<BrowserSnapshot> {
    if (!this.#session || this.#closed || this.#busy) throw new Error('Browser page unavailable');
    const broker = this.broker(url); // Validate before issuing browser commands.
    this.#busy = true; this.#revision = '';
    const controller = new AbortController();
    const combined = AbortSignal.any([this.#lifetime.signal, controller.signal, AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]);
    this.#active = { broker, signal: combined, blocked: new Set() };
    let dispose = () => {};
    const loaded = new Promise<void>((resolve, reject) => {
      const abort = () => reject(new Error('Browser navigation interrupted'));
      const off = this.cdp.onEvent(event => {
        if (event.sessionId === this.#session && event.method === 'Page.loadEventFired') resolve();
      });
      combined.addEventListener('abort', abort, { once: true });
      dispose = () => { off(); combined.removeEventListener('abort', abort); };
    });
    // A failed navigate may reject before the load promise is awaited.
    void loaded.catch(() => {});
    try {
      combined.throwIfAborted();
      const result = await this.#send('Page.navigate', { url }, combined);
      if (result.errorText) throw new Error('Browser navigation failed');
      await loaded;
      return await this.#snapshot(combined);
    } finally {
      dispose(); controller.abort(); this.#active = undefined;
      await this.#send('Page.stopLoading').catch(() => {}); this.#busy = false;
    }
  }
  async #evaluate(expression: string, signal?: AbortSignal) {
    const result = await this.#send('Runtime.evaluate', { expression, contextId: this.#world, returnByValue: true, timeout: 5_000 }, signal);
    if (result.exceptionDetails) throw new Error('Browser document changed; obtain a new snapshot');
    return (result.result as { value: unknown }).value;
  }
  async snapshot(signal?: AbortSignal): Promise<BrowserSnapshot> {
    if (!this.#session || this.#closed || this.#busy) throw new Error('Browser page unavailable');
    this.#busy = true; this.#revision = '';
    try { return await this.#snapshot(AbortSignal.any([this.#lifetime.signal, AbortSignal.timeout(10_000), ...(signal ? [signal] : [])])); }
    finally { this.#busy = false; }
  }
  async #snapshot(signal: AbortSignal): Promise<BrowserSnapshot> {
    const tree = await this.#send('Page.getFrameTree', {}, signal);
    const frame = (tree.frameTree as { frame: { id: string } }).frame;
    const world = await this.#send('Page.createIsolatedWorld', { frameId: frame.id, worldName: 'niwa-observation' }, signal);
    this.#world = Number(world.executionContextId);
    const revision = randomUUID();
    const value = await this.#evaluate(`(() => {
      const visible = el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
      const nodes = Array.from(document.querySelectorAll('a[href],button,input,textarea,select,[role="button"]')).filter(visible).slice(0,100);
      const elements = nodes.map((el, ref) => ({ref, role: el.getAttribute('role') || el.tagName.toLowerCase(),
        name: (el.getAttribute('aria-label') || el.innerText || el.getAttribute('placeholder') || '').slice(0,200),
        ...(el.tagName === 'A' ? {href: el.href} : {})}));
      globalThis.niwaObservation = {nodes, elements, revision: ${JSON.stringify(revision)}};
      return {url: location.href, title: document.title.slice(0,500), text: (document.body?.innerText || '').slice(0,20000), elements};
    })()`, signal) as Omit<BrowserSnapshot, 'revision' | 'blocked' | 'untrusted'>;
    this.#revision = revision;
    return { ...value, revision, blocked: [...(this.#active?.blocked ?? [])], untrusted: true };
  }
  /** Follow an observed hyperlink without running click handlers. Other controls require a classified action. */
  async follow(revision: string, ref: number, signal?: AbortSignal) {
    if (this.#busy || this.#closed || !revision || revision !== this.#revision || !Number.isSafeInteger(ref) || ref < 0 || ref >= 100)
      throw new Error('Browser reference is stale or invalid');
    this.#busy = true;
    let href: unknown;
    try {
      href = await this.#evaluate(`(() => {
        const s = globalThis.niwaObservation, el = s?.nodes[${ref}], old = s?.elements[${ref}];
        if (s?.revision !== ${JSON.stringify(revision)} || !el?.isConnected || el.tagName !== 'A' ||
            !el.getClientRects().length || el.href !== old.href || el.hasAttribute('download')) return null;
        return el.href;
      })()`, signal);
    } finally { this.#busy = false; }
    if (typeof href !== 'string') throw new Error('Browser reference changed or action requires approval');
    return this.navigate(href, signal);
  }
  async close() {
    if (this.#closed) return;
    this.#closed = true; this.#lifetime.abort(); this.#revision = ''; this.#active = undefined; this.#unsubscribe();
    if (this.#context) await this.cdp.send('Target.disposeBrowserContext', { browserContextId: this.#context }, { timeoutMs: 5_000 }).catch(() => {});
  }
}
