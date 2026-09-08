import type { BrowserInteraction } from './interaction.ts';
import { randomUUID } from 'node:crypto';
import { CdpPipe, type CdpEvent } from './cdp.ts';
import { BrowserRequests, BrowserRequestBlocked } from './requests.ts';
import { normalizeForm, type PublicForm } from './form.ts';

export interface BrowserSnapshot {
  revision: string; url: string; title: string; text: string;
  elements: { ref: number; role: string; name: string; href?: string }[];
  blocked: string[]; untrusted: true;
  form?: PublicForm;
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
        ['Page.enable', {}], ['Page.setLifecycleEventsEnabled', { enabled: true }], ['Network.enable', {}], ['Network.setBypassServiceWorker', { bypass: true }],
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
      // Navigation/cancellation can already have disposed this intercepted request.
      await this.#send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }).catch(() => {});
    }
  }
  async navigate(url: string, signal?: AbortSignal): Promise<BrowserSnapshot> {
    if (!this.#session || this.#closed || this.#busy) throw new Error('Browser page unavailable');
    new BrowserRequests(url); // URL validation also applies when using a parent-process broker.
    const broker = this.broker(url); // Validate before issuing browser commands.
    this.#busy = true; this.#revision = '';
    const controller = new AbortController();
    const combined = AbortSignal.any([this.#lifetime.signal, controller.signal, AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]);
    this.#active = { broker, signal: combined, blocked: new Set() };
    let dispose = () => {};
    let expectedLoader = ''; const loadedIds = new Set<string>(); let resolveLoaded = () => {};
    const loaded = new Promise<void>((resolve, reject) => {
      resolveLoaded = resolve;
      const abort = () => reject(new Error('Browser navigation interrupted'));
      const off = this.cdp.onEvent(event => {
        if (event.sessionId === this.#session && event.method === 'Page.lifecycleEvent' && event.params.name === 'load') {
          loadedIds.add(String(event.params.loaderId));
          if (event.params.loaderId === expectedLoader) resolve();
        }
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
      expectedLoader = String(result.loaderId ?? '');
      if (!expectedLoader || loadedIds.has(expectedLoader)) resolveLoaded();
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
      const roots = [document], nodes = [], texts = [];
      // Traverse open component roots with the same observation and output limits.
      for (let i = 0; i < roots.length && i < 100; i++) {
        const root = roots[i];
        for (const el of root.querySelectorAll('*')) {
          if (el.shadowRoot && visible(el) && roots.length < 100) roots.push(el.shadowRoot);
          if (el.tagName === 'IFRAME' && visible(el) && roots.length < 100 && el.contentDocument) roots.push(el.contentDocument);
          if (nodes.length < 100 && el.matches('a[href],button,input,textarea,select,[role="button"]') && visible(el)) nodes.push(el);
        }
        const text = root.nodeType === 9 ? root.body?.innerText : Array.from(root.children).filter(visible).map(el => el.innerText || '').join('\\n');
        texts.push((text || '').slice(0,20000));
      }
      const elements = nodes.map((el, ref) => ({ref, role: el.getAttribute('role') || el.tagName.toLowerCase(),
        name: (el.getAttribute('aria-label') || el.innerText || el.getAttribute('placeholder') || '').slice(0,200),
        ...(el.tagName === 'A' ? {href: el.href} : {})}));
      globalThis.niwaObservation = {nodes, elements, revision: ${JSON.stringify(revision)}};
      return {url: location.href, title: document.title.slice(0,500), text: texts.join('\\n').slice(0,20000), elements};
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
  /** Local DOM interaction only: the parent broker remains closed for every network request. */
  async interact(input: BrowserInteraction, signal?: AbortSignal): Promise<BrowserSnapshot> {
    if (this.#busy || this.#closed || input.revision !== this.#revision) throw new Error('Browser reference is stale');
    this.#busy = true;
    const cancellation = AbortSignal.any([this.#lifetime.signal, AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]);
    try {
      await this.#evaluate(`(() => {
        const action = ${JSON.stringify(input)}, s = globalThis.niwaObservation;
        if (s?.revision !== action.revision) throw Error('Stale observation');
        if (action.action === 'scroll') { window.scrollBy(0, action.pixels); return; }
        const el = s.nodes[action.ref];
        if (!el?.isConnected || !el.getClientRects().length || el.matches(':disabled')) throw Error('Unavailable control');
        if (action.action === 'fill') {
          if (!['INPUT','TEXTAREA','SELECT'].includes(el.tagName) ||
              (el.tagName === 'INPUT' && !['text','search','email','url','tel','number','date'].includes(el.type)) || el.readOnly || el.multiple)
            throw Error('Credentials and files require a dedicated operation');
          el.value = action.value;
          if (el.value !== action.value) throw Error('Invalid field value');
          el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          if (!(el.matches('button[type="button"],input[type="button"],input[type="checkbox"],input[type="radio"],[role="button"]')) ||
              el.tagName === 'A' || el.type === 'submit' || el.type === 'image' || el.type === 'file')
            throw Error('Use follow or prepare an approved form');
          HTMLElement.prototype.click.call(el);
        }
      })()`, cancellation);
      // Snapshot recreates the observation world after DOM changes; old refs are invalidated.
      return { ...await this.#snapshot(cancellation), blocked: ['network_disabled_during_interaction'] };
    } finally { this.#busy = false; }
  }
  async close() {
    if (this.#closed) return;
    this.#closed = true; this.#lifetime.abort(); this.#revision = ''; this.#active = undefined; this.#unsubscribe();
    if (this.#context) await this.cdp.send('Target.disposeBrowserContext', { browserContextId: this.#context }, { timeoutMs: 5_000 }).catch(() => {});
  }
  /** Snapshot a native form without invoking submit handlers or allowing network traffic. */
  async prepareForm(revision: string, ref: number, fields: { ref: number; value: string }[], signal?: AbortSignal): Promise<BrowserSnapshot> {
    if (this.#busy || this.#closed || revision !== this.#revision || !revision || !Number.isInteger(ref) || ref < 0 || ref >= 100 ||
      !Array.isArray(fields) || fields.length > 32 || new Set(fields.map(field => field.ref)).size !== fields.length ||
      fields.some(field => !Number.isInteger(field.ref) || field.ref < 0 || field.ref >= 100 || typeof field.value !== 'string' || field.value.length > 1000)) throw new Error('Invalid form reference');
    this.#busy = true;
    const cancellation = AbortSignal.any([this.#lifetime.signal, AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]);
    try {
      const value = await this.#evaluate(`(() => {
        const s = globalThis.niwaObservation, submitter = s?.nodes[${ref}];
        if (s?.revision !== ${JSON.stringify(revision)} || !submitter?.isConnected || submitter.type !== 'submit' || !submitter.form || submitter.disabled) throw Error('Select a current submit button');
        const form = submitter.form, changes = ${JSON.stringify(fields)}, saved = [];
        if (Array.from(form.elements).some(el => el.name && !el.matches(':disabled') && ['file','password'].includes(el.type))) throw Error('Credentials and uploads require a dedicated connector');
        const method = (submitter.getAttribute('formmethod') || form.method || 'get').toUpperCase();
        const enctype = submitter.getAttribute('formenctype') || form.enctype;
        if (!['GET','POST'].includes(method) || enctype !== 'application/x-www-form-urlencoded') throw Error('Unsupported form encoding');
        const url = new URL(submitter.getAttribute('formaction') || form.getAttribute('action') || form.ownerDocument.URL, form.ownerDocument.baseURI).href;
        try {
          for (const change of changes) {
            const el = s.nodes[change.ref];
            if (!el?.isConnected || el.form !== form || !el.name || el.matches(':disabled') ||
                !['INPUT','TEXTAREA','SELECT'].includes(el.tagName) || ['file','password','checkbox','radio','submit','button','reset','image'].includes(el.type) || el.multiple) throw Error('Unsupported field');
            saved.push([el, el.value]); el.value = change.value;
            if (el.value !== change.value) throw Error('Invalid field value');
          }
          const fields = Array.from(new FormData(form, submitter), ([name,value]) => {
            if (typeof value !== 'string') throw Error('File fields are unsupported'); return {name,value};
          });
          return {url,method,fields};
        } finally { for (const [el,value] of saved) el.value = value; }
      })()`, cancellation);
      const form = normalizeForm(value);
      return { ...await this.#snapshot(cancellation), form };
    } finally { this.#busy = false; }
  }
}
