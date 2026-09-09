import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { createHash, randomUUID } from 'node:crypto';
import { request } from 'node:https';
import { pageUrl, publicAddress } from '../web/public-page.ts';

export const formSchema = Type.Object({
  url: Type.String({ minLength: 1, maxLength: 1000 }), method: Type.Union([Type.Literal('GET'), Type.Literal('POST')]),
  fields: Type.Array(Type.Object({ name: Type.String({ minLength: 1, maxLength: 200 }), value: Type.String({ maxLength: 1000 }) },
    { additionalProperties: false }), { maxItems: 32 }),
  json: Type.Optional(Type.String({ maxLength: 1000 })),
  files: Type.Optional(Type.Array(Type.Object({
    name: Type.String({minLength:1,maxLength:100,pattern:'^[A-Za-z0-9_.-]+$'}),
    workarea_id: Type.Optional(Type.String({pattern:'^[a-f0-9-]{36}$'})),
    path: Type.String({minLength:1,maxLength:512}),
    filename: Type.String({minLength:1,maxLength:100,pattern:'^[A-Za-z0-9_.-]+$'}),
    revision: Type.String({pattern:'^[a-f0-9]{64}$'}),
    size: Type.Integer({minimum:0,maximum:256*1024}),
  },{additionalProperties:false}),{minItems:1,maxItems:4})),
}, { additionalProperties: false });
export type PublicForm = Static<typeof formSchema>;
export type FormFileReader=(path:string,signal?:AbortSignal,area?:string)=>Promise<{data:string;revision:string}>;
export interface FormResponse { url: string; status: number; text: string; truncated: boolean; untrusted: true; content_type?: string }

/** This value is also the complete human-readable approval payload. No hidden caller-selected headers. */
export function normalizeForm(input: unknown): PublicForm {
  if (!Value.Check(formSchema, input)) throw new Error('Invalid form');
  const url = pageUrl(input.url);
  if (url.protocol !== 'https:') throw new Error('Form submission requires public HTTPS');
  if (input.method === 'GET') url.search = ''; // Native GET forms replace the action query with their fields.
  if (input.files && (input.method !== 'POST' || input.fields.some(field => !/^[A-Za-z0-9_.-]+$/.test(field.name)))) throw new Error('Invalid multipart form');
  if (input.json !== undefined) {
    if (input.method !== 'POST' || input.files || input.fields.length) throw new Error('Invalid JSON request');
    JSON.parse(input.json);
  }
  const form = { url: url.href, method: input.method, fields: input.fields.map(({ name, value }) => ({ name, value })),
    ...(input.json !== undefined ? { json: input.json } : {}),
    ...(input.files ? {files: input.files.map(file => ({...file}))} : {}) };
  if (JSON.stringify(form, null, 2).length > 2000) throw new Error('Form exceeds approval display limit');
  return form;
}

export type FormTransport = (url: URL, method: 'GET' | 'POST', body: string | Buffer, address: string, signal: AbortSignal, contentType?: string) => Promise<FormResponse>;
const transport: FormTransport = (url, method, body, address, signal, contentType) => new Promise((resolve, reject) => {
  const req = request(url, { method, agent: false, signal, family: 4,
    lookup: (_host, _options, callback) => callback(null, address, 4),
    headers: { accept: 'text/html,text/plain,application/json', 'accept-encoding': 'identity', 'user-agent': 'Niwa/0.1 (approved form)',
      ...(method === 'POST' ? { 'content-type': contentType ?? 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body) } : {}) },
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
    response.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); resolve({ url: url.href, status, text: text.slice(0, 20000), truncated: text.length > 20000, untrusted: true, content_type: type.split(';')[0]!.toLowerCase() }); });
  });
  req.on('error', reject); req.end(method === 'POST' ? body : undefined);
});

/** Only invoke after exact-content approval and a durable intent. No cookies, auth, redirect or retry. */
export async function submitPublicForm(input: PublicForm, signal?: AbortSignal, send: FormTransport = transport,
  resolveAddress: typeof publicAddress = publicAddress, readFile?: FormFileReader): Promise<FormResponse> {
  const form = normalizeForm(input); const url = new URL(form.url);
  const body = new URLSearchParams(form.fields.map(({ name, value }) => [name, value])).toString();
  if (form.method === 'GET') url.search = body;
  const cancellation = AbortSignal.any([AbortSignal.timeout(20_000), ...(signal ? [signal] : [])]);
  let payload: string | Buffer = body, contentType: string | undefined;
  if (form.json !== undefined) { payload = form.json; contentType = 'application/json'; }
  if (form.files) {
    if (!readFile) throw new Error('Shared file reader required');
    const boundary = `niwa-${randomUUID()}`, chunks: Buffer[] = [];
    const append = (text: string) => chunks.push(Buffer.from(text));
    for (const field of form.fields) append(`--${boundary}\r\nContent-Disposition: form-data; name="${field.name}"\r\n\r\n${field.value}\r\n`);
    for (const file of form.files) {
      const saved = await readFile(file.path, cancellation, file.workarea_id), bytes = Buffer.from(saved.data, 'base64');
      if (bytes.length !== file.size || saved.revision !== file.revision || bytes.toString('base64') !== saved.data ||
          createHash('sha256').update(bytes).digest('hex') !== file.revision) throw new Error('Approved file changed');
      append(`--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
      chunks.push(bytes); append('\r\n');
    }
    append(`--${boundary}--\r\n`); payload = Buffer.concat(chunks); contentType = `multipart/form-data; boundary=${boundary}`;
  }
  const address = await resolveAddress(url.hostname, cancellation);
  cancellation.throwIfAborted();
  return send(url, form.method, payload, address, cancellation, contentType);
}
