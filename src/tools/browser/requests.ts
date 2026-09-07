import { readPublicResource } from '../web/public-page.ts';

export interface BrowserRequest { url: string; method: string; resourceType: string }
export class BrowserRequestBlocked extends Error {
  constructor(readonly reason: 'approval_required' | 'request_limit' | 'response_limit') { super(reason); }
}
type Reader = typeof readPublicResource;

/** One navigation/action budget. Production also requires a network-isolated browser; interception alone is insufficient. */
export class BrowserRequests {
  #document: string;
  #requests = 0;
  #bytes = 0;
  constructor(documentUrl: string, private read: Reader = readPublicResource) { this.#document = this.#url(documentUrl); }
  #url(input: string): string {
    const url = new URL(input);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) throw new Error('Public HTTP/HTTPS URL required');
    url.hash = ''; return url.href;
  }
  async get(request: BrowserRequest, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const url = this.#url(request.url);
    const document = request.resourceType === 'Document';
    if (request.method !== 'GET' || (document ? url !== this.#document : !['Stylesheet', 'Script', 'Image', 'Font'].includes(request.resourceType)))
      throw new BrowserRequestBlocked('approval_required');
    if (++this.#requests > 64) throw new BrowserRequestBlocked('request_limit');
    const resource = await this.read(url, signal);
    signal?.throwIfAborted();
    const bytes = Buffer.from(resource.body_base64, 'base64');
    if (bytes.toString('base64') !== resource.body_base64 || bytes.length > 256 * 1024 || (this.#bytes += bytes.length) > 8 * 1024 * 1024)
      throw new BrowserRequestBlocked('response_limit');
    if (document) this.#document = this.#url(resource.url); // A redirect was checked by the anonymous public reader.
    return resource;
  }
}
