export class RetrievalFailure extends Error { constructor(readonly code:'not_found'|'refused'|'http_failure'|'invalid_response'|'policy_blocked'|'invalid_request'|'aborted',message='Page could not be read'){super(message);} }
import { lookup } from 'node:dns/promises';
import { isIPv4 } from 'node:net';
import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';

const MAX_BYTES = 256 * 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
let activeDownloads = 0;
const PAGE_TYPES = /^(text\/(html|plain)|application\/json)(;|$)/i;
const RESOURCE_TYPES = /^(text\/(html|plain|css|javascript)|application\/(json|javascript|x-javascript)|image\/(png|jpeg|gif|webp|avif|svg\+xml|x-icon|vnd.microsoft.icon)|font\/(woff|woff2|ttf|otf))(;|$)/i;
export interface PageResponse { status: number; location?: string; contentType: string; body: string | Buffer }
export interface PageNetwork {
  resolve(host: string): Promise<string[]>;
  get(url: URL, address: string, signal: AbortSignal): Promise<PageResponse>;
}

/** Deliberately IPv4-only until IPv6 transition/special-use ranges are covered. */
export function publicIPv4(address: string): boolean {
  if (!isIPv4(address)) return false;
  const [a, b, c] = address.split('.').map(Number) as [number, number, number, number];
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113));
}

export function pageUrl(input: string): URL {
  if (input.length > 4096) throw new RetrievalFailure('invalid_request','URL is too long');
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port ||
    url.hostname.includes(':') || !url.hostname.includes('.') ||
    /\.(localhost|local|internal|home|lan|test|invalid|example|onion)\.?$/i.test(url.hostname)) {
    throw new RetrievalFailure('policy_blocked','Only public HTTP/HTTPS pages on standard ports are supported');
  }
  url.hash = '';
  return url;
}

const networkFor = (accept: string, types: RegExp, maxBytes = MAX_BYTES): PageNetwork => ({
  resolve: async host => (await lookup(host, { family: 4, all: true })).map(item => item.address),
  get: (url, address, signal) => new Promise((resolve, reject) => {
    // Keep Host/SNI from the original URL, pin the checked address, and do not use proxies or pooled sockets.
    const request = (url.protocol === 'https:' ? httpsGet : httpGet)(url, {
      agent: false, signal, family: 4,
      lookup: (_host, _options, callback) => callback(null, address, 4),
      headers: { accept, 'accept-encoding': 'identity', 'user-agent': 'Niwa/0.1 (public page reader)' },
    }, response => {
      const status = response.statusCode ?? 0;
      const contentType = response.headers['content-type'] ?? '';
      const location = response.headers.location;
      if (status >= 300 && status < 400) {
        response.destroy(); resolve({ status, contentType, body: '', ...(location ? { location } : {}) }); return;
      }
      if (status !== 200 || !types.test(contentType) ||
        (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') ||
        Number(response.headers['content-length']) > maxBytes) {
        response.destroy(); reject(new RetrievalFailure(status===404?'not_found':[401,403,429].includes(status)?'refused':status!==200?'http_failure':'invalid_response','Page status, type, encoding or size is unsupported')); return;
      }
      const chunks: Buffer[] = []; let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) { response.destroy(new RetrievalFailure('invalid_response','Page exceeds size limit')); return; }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => resolve({ status, contentType, body: Buffer.concat(chunks) }));
    });
    request.on('error', reject);
  }),
});
const network = networkFor('text/html,text/plain,application/json', PAGE_TYPES);
const resourceNetwork = networkFor('*/*', RESOURCE_TYPES);

export async function publicAddress(host: string, signal: AbortSignal, resolveHost: PageNetwork['resolve'] = network.resolve): Promise<string> {
  signal.throwIfAborted();
  const addresses = await new Promise<string[]>((resolve, reject) => {
    const abort = () => reject(new RetrievalFailure('aborted','Page request cancelled'));
    signal.addEventListener('abort', abort, { once: true });
    resolveHost(host).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
  signal.throwIfAborted();
  if (!addresses.length || !addresses.every(publicIPv4)) throw new RetrievalFailure('policy_blocked','Page host is not a public IPv4 destination');
  return addresses[0]!;
}

async function fetchPublic(input: string, types: RegExp, signal: AbortSignal | undefined, transport: PageNetwork, maxBytes = MAX_BYTES) {
  const cancellation = AbortSignal.any([AbortSignal.timeout(maxBytes === MAX_FILE_BYTES ? 60_000 : 15_000), ...(signal ? [signal] : [])]);
  let url = pageUrl(input);
  for (let redirects = 0; redirects <= 5; redirects++) {
    cancellation.throwIfAborted();
    // DNS cannot open a socket; abort the wait promptly even when the OS lookup continues.
    const address = await publicAddress(url.hostname, cancellation, transport.resolve);
    const response = await transport.get(url, address, cancellation);
    cancellation.throwIfAborted();
    if ([301, 302, 303, 307, 308].includes(response.status) && response.location) {
      if (redirects === 5) throw new RetrievalFailure('invalid_response','Too many page redirects');
      const next = pageUrl(new URL(response.location, url).href);
      if (url.protocol === 'https:' && next.protocol === 'http:') throw new Error('HTTPS downgrade is not supported');
      url = next; continue;
    }
    if(response.status!==200)throw new RetrievalFailure(response.status===404?'not_found':[401,403,429].includes(response.status)?'refused':'http_failure');
    if (!types.test(response.contentType) || /[\r\n]/.test(response.contentType) ||
      Buffer.byteLength(response.body) > maxBytes) throw new RetrievalFailure('invalid_response');
    return { url: url.href, content_type: response.contentType, body: Buffer.from(response.body), fetched_at: new Date().toISOString(), untrusted: true };
  }
  throw new RetrievalFailure('invalid_response');
}

export async function readPublicPage(input: string, signal?: AbortSignal, transport: PageNetwork = network) {
  const { body, ...source } = await fetchPublic(input, PAGE_TYPES, signal, transport);
  const text = body.toString('utf8');
  return { ...source, text: text.slice(0, 20_000), truncated: text.length > 20_000 };
}

/** Broker-only anonymous GET. No caller-controlled headers, cookies, body, credentials or proxy. */
export async function readPublicResource(input: string, signal?: AbortSignal, transport: PageNetwork = resourceNetwork) {
  const { body, ...source } = await fetchPublic(input, RESOURCE_TYPES, signal, transport);
  return { ...source, body_base64: body.toString('base64') };
}

/** Bounded anonymous download; never execute the returned bytes or accept a remote filename. */
export async function readPublicFile(input: string, signal?: AbortSignal, transport: PageNetwork = networkFor('*/*', /^[^\r\n]+$/, MAX_FILE_BYTES)) {
  // Bound simultaneous network/body buffering; the turn runner also bounds complete transfers.
  if (activeDownloads >= 2) throw new Error('Download capacity reached');
  activeDownloads++;
  try {
    const { body, ...source } = await fetchPublic(input, /^[^\r\n]+$/, signal, transport, MAX_FILE_BYTES);
    return { ...source, body_base64: body.toString('base64') };
  } finally { activeDownloads--; }
}
