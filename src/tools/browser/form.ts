import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { request } from 'node:https';
import { pageUrl, publicAddress } from '../web/public-page.ts';

export const formSchema = Type.Object({
  url: Type.String({ minLength: 1, maxLength: 1000 }), method: Type.Union([Type.Literal('GET'), Type.Literal('POST')]),
  fields: Type.Array(Type.Object({ name: Type.String({ minLength: 1, maxLength: 200 }), value: Type.String({ maxLength: 1000 }) },
    { additionalProperties: false }), { maxItems: 32 }),
}, { additionalProperties: false });
export type PublicForm = Static<typeof formSchema>;
export interface FormResponse { url: string; status: number; text: string; truncated: boolean; untrusted: true }

/** This value is also the complete human-readable approval payload. No hidden caller-selected headers. */
export function normalizeForm(input: unknown): PublicForm {
  if (!Value.Check(formSchema, input)) throw new Error('Invalid form');
  const url = pageUrl(input.url);
  if (url.protocol !== 'https:') throw new Error('Form submission requires public HTTPS');
  if (input.method === 'GET') url.search = ''; // Native GET forms replace the action query with their fields.
  const form = { url: url.href, method: input.method, fields: input.fields.map(({ name, value }) => ({ name, value })) };
  if (JSON.stringify(form, null, 2).length > 2000) throw new Error('Form exceeds approval display limit');
  return form;
}

export type FormTransport = (url: URL, method: 'GET' | 'POST', body: string, address: string, signal: AbortSignal) => Promise<FormResponse>;
const transport: FormTransport = (url, method, body, address, signal) => new Promise((resolve, reject) => {
  const req = request(url, { method, agent: false, signal, family: 4,
    lookup: (_host, _options, callback) => callback(null, address, 4),
    headers: { accept: 'text/html,text/plain,application/json', 'accept-encoding': 'identity', 'user-agent': 'Niwa/0.1 (approved form)',
      ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body) } : {}) },
  }, response => {
    // Never follow redirects: a new destination or repeated POST is a separate operation.
    const status = response.statusCode ?? 0; const type = response.headers['content-type'] ?? '';
    if (status >= 300 && status < 400 || status === 204) { response.destroy(); resolve({ url: url.href, status, text: '', truncated: false, untrusted: true }); return; }
    if (!/^(text\/(html|plain)|application\/json)(;|$)/i.test(type) ||
      (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') || Number(response.headers['content-length']) > 256 * 1024) {
      response.destroy(); reject(new Error('Form response unsupported; outcome unknown')); return;
    }
    const chunks: Buffer[] = []; let size = 0;
    response.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 256 * 1024) response.destroy(new Error('Form response too large')); else chunks.push(chunk); });
    response.on('error', reject);
    response.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); resolve({ url: url.href, status, text: text.slice(0, 20000), truncated: text.length > 20000, untrusted: true }); });
  });
  req.on('error', reject); req.end(method === 'POST' ? body : undefined);
});

/** Only invoke after exact-content approval and a durable intent. No cookies, auth, redirect or retry. */
export async function submitPublicForm(input: PublicForm, signal?: AbortSignal, send: FormTransport = transport,
  resolveAddress: typeof publicAddress = publicAddress): Promise<FormResponse> {
  const form = normalizeForm(input); const url = new URL(form.url);
  const body = new URLSearchParams(form.fields.map(({ name, value }) => [name, value])).toString();
  if (form.method === 'GET') url.search = body;
  const cancellation = AbortSignal.any([AbortSignal.timeout(20_000), ...(signal ? [signal] : [])]);
  const address = await resolveAddress(url.hostname, cancellation);
  cancellation.throwIfAborted();
  return send(url, form.method, body, address, cancellation);
}
