import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { request } from 'node:http';
import { createApiServer } from '../src/web/api.ts';
import { WebAuth } from '../src/web/auth.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { deflateSync } from 'node:zlib';
import { Runtime } from '../src/runtime/runtime.ts';
import { TurnRunner } from '../src/runtime/turns.ts';
import { decodeAttachments, imageInfo } from '../src/domain/attachments.ts';
import type { ModelEvent, ModelRequest } from '../src/contracts/model.ts';
import type { ModelAdapter } from '../src/providers/shared/adapter.ts';
import { openAISubscriptionAdapterCapabilities } from '../src/providers/codex/adapter.ts';
import { fitContext, IMAGE_TOKENS } from '../src/runtime/context/fit.ts';

const file = (name: string, bytes: Buffer | string) => ({ name, content: Buffer.from(bytes).toString('base64') });
/** Headers are enough: Niwa reads the kind and size and never decodes pixels. */
const png = (width: number, height: number) => { const b = Buffer.alloc(33); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b); b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(width, 16); b.writeUInt32BE(height, 20); return b; };
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x20, 0x00, 0x40, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
const gif = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.from([0x0a, 0x00, 0x05, 0x00, 0, 0, 0])]);
const webp = (() => { const b = Buffer.alloc(30); b.write('RIFF', 0, 'latin1'); b.write('WEBP', 8, 'latin1'); b.write('VP8X', 12, 'latin1'); b.writeUIntLE(99, 24, 3); b.writeUIntLE(49, 27, 3); return b; })();
function pdf(text: string) {
  const content = deflateSync(Buffer.from(`BT /F1 12 Tf 72 712 Td (${text}) Tj ET`, 'latin1'));
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>'];
  let out = '%PDF-1.4\n'; objects.forEach((body, index) => { out += `${index + 1} 0 obj\n${body}\nendobj\n`; });
  out += `4 0 obj\n<< /Length ${content.length} /Filter /FlateDecode >>\nstream\n${content.toString('latin1')}\nendstream\nendobj\n5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'niwa-media-'));
  const runtime = new Runtime(root);
  const db = new DatabaseSync(join(root, 'control.db'));
  t.after(() => { db.close(); runtime.close(); rmSync(root, { recursive: true, force: true }); });
  const admin = runtime.administrator(), leader = runtime.bootstrap(admin);
  return { root, runtime, db, admin, leader, bot: runtime.agentSession(leader.id), room: runtime.createRoom(admin, '写真の相談') };
}

test('images are recognized by their headers, PDFs give their text, and everything else must be UTF-8 text', () => {
  assert.deepEqual([png(640, 480), jpeg, gif, webp].map(bytes => imageInfo(bytes)), [
    { media_type: 'image/png', width: 640, height: 480 }, { media_type: 'image/jpeg', width: 64, height: 32 }, { media_type: 'image/gif', width: 10, height: 5 }, { media_type: 'image/webp', width: 100, height: 50 }]);
  const [image, document, note] = decodeAttachments([file('庭.png', png(640, 480)), file('案内.pdf', pdf('Meet at the north gate')), file('memo.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>')]);
  assert.deepEqual([image!.media_type, image!.body, image!.data!.length], ['image/png', '', 33]);
  assert.deepEqual([document!.media_type, document!.body], ['application/pdf', 'Meet at the north gate']);
  // An SVG is text, never an image: it stays an inert text download.
  assert.deepEqual([note!.media_type, note!.data], ['text/plain', null]);
  assert.throws(() => decodeAttachments([file('big.png', Buffer.concat([png(10, 10), Buffer.alloc(3 * 1024 * 1024)]))]), /Image is too large/);
  assert.throws(() => decodeAttachments([file('fake.png', Buffer.concat([png(0, 10), Buffer.from([0xff, 0x00])]))]), /UTF-8|text/);
  assert.throws(() => decodeAttachments(Array.from({ length: 3 }, (_v, i) => file(`${i}.png`, Buffer.concat([png(10, 10), Buffer.alloc(2_900_000)])))), /together/);
});

test('attachments keep their kind and bytes, history explains images and PDFs, and image bytes go only to the task owner', t => {
  const { runtime, admin, leader, bot, room } = fixture(t);
  const { message } = runtime.submit(admin, randomUUID(), room.id, 'この写真と案内を見て', leader.id, undefined, undefined, [file('庭.png', png(640, 480)), file('案内.pdf', pdf('North gate at 10'))]);
  const listed = runtime.messageAttachments(admin, room.id);
  assert.deepEqual(listed.map(item => [item.name, item.media_type]), [['庭.png', 'image/png'], ['案内.pdf', 'application/pdf']]);
  const stored = runtime.attachment(admin, listed[0]!.id);
  assert.deepEqual(Buffer.from(stored.data!), png(640, 480));
  const read = String(runtime.readHistory(bot, room.id, 'message', message.id).text);
  assert.match(read, /\[添付画像: 庭\.png \(33 bytes\)・文字としては読めません\]/);
  assert.match(read, /\[添付PDF: 案内\.pdf \(\d+ bytes\)・利用者が提供した資料。PDFから取り出した文字\]\nNorth gate at 10/);
  const lease = runtime.tasks.claim(admin)!;
  const files = runtime.taskAttachments(bot, lease);
  assert.deepEqual(files.map(item => [item.name, item.kind, item.text]), [['庭.png', 'image', ''], ['案内.pdf', 'pdf', 'North gate at 10']]);
  assert.deepEqual(runtime.taskImages(bot, lease).map(item => [item.name, item.media_type, Buffer.from(item.data, 'base64').length]), [['庭.png', 'image/png', 33]]);
  const other = runtime.agentSession(runtime.createAgent(bot, '別のBot').id);
  assert.throws(() => runtime.taskImages(other, lease), /another agent/);
});

const complete = (text: string): ModelEvent[] => [{ type: 'text_delta', text }, { type: 'completed', finish_reason: 'stop' }];
function model(seeing: boolean, sent: ModelRequest[]): ModelAdapter {
  return { adapter_id: 'artificial', capabilities: { ...openAISubscriptionAdapterCapabilities, supports_image_input: seeing },
    async *run(request) {
      if (request.tools.length === 1 && request.tools[0]?.name === 'memory_review') { yield { type: 'tool_call', tool_call_id: 'm', name: 'memory_review', arguments: { memories: [] } }; yield { type: 'completed', finish_reason: 'tool_calls' }; return; }
      sent.push(request); yield* complete(seeing ? '北口の写真ですね。' : 'この画像は認識できません。');
    } };
}
for (const seeing of [true, false]) test(`a model that ${seeing ? 'can' : 'cannot'} see images ${seeing ? 'receives the image' : 'is told to say it cannot recognize it, and the message notes it'}`, async t => {
  const { runtime, admin, leader, room } = fixture(t);
  runtime.submit(admin, randomUUID(), room.id, 'この写真の場所は？', leader.id, undefined, undefined, [file('庭.png', png(640, 480))]);
  const sent: ModelRequest[] = [];
  await new TurnRunner(runtime, async () => model(seeing, sent)).run(runtime.tasks.claim(admin)!);
  const carrying = sent[0]!.messages.find(message => message.role === 'user' && message.content.includes('current_request_attachments'));
  assert.ok(carrying && carrying.role === 'user');
  const input = JSON.parse(carrying.content).current_request_attachments;
  if (seeing) {
    assert.deepEqual(carrying.images?.map(image => [image.media_type, Buffer.from(image.data, 'base64').length]), [['image/png', 33]]);
    assert.match(input.images, /見られるようにしています/);
    assert.equal(runtime.messageAttachments(admin, room.id)[0]!.unseen_by, undefined);
  } else {
    assert.equal(carrying.images, undefined);
    assert.match(input.images, /画像を認識できないことを利用者に伝えてください/);
    assert.deepEqual(runtime.messageAttachments(admin, room.id)[0]!.unseen_by, [leader.id]);
  }
  // The image is counted by an allowance, not by the length of its base64 text.
  const plain: ModelRequest = { ...sent[0]!, messages: sent[0]!.messages.map(message => { if (message.role !== 'user') return message; const { images: _images, ...rest } = message; return rest; }) };
  const extra = fitContext(sent[0]!, [], undefined).estimated_input_tokens - fitContext(plain, [], undefined).estimated_input_tokens;
  assert.ok(seeing ? extra >= IMAGE_TOKENS && extra < IMAGE_TOKENS + 50 : extra === 0, `extra=${extra}`);
});

test('upgrading widens the size limit in place and replays safely', t => {
  const { root, runtime, db } = fixture(t);
  const sql = () => String(db.prepare("SELECT sql FROM sqlite_schema WHERE name='message_attachments'").get()!.sql);
  assert.match(sql(), /BETWEEN 0 AND 4194304/);
  runtime.close();
  db.exec('PRAGMA user_version=59');
  const reopened = new Runtime(root);
  try { assert.match(sql(), /BETWEEN 0 AND 4194304/); assert.equal(db.prepare('PRAGMA quick_check').get()!.quick_check, 'ok'); }
  finally { reopened.close(); }
});

test('the API shows an image inline only when asked, serves a PDF as a download and its text on request, all inert', async t => {
  const { runtime, admin, room } = fixture(t);
  const origin = 'https://niwa.test';
  const server = createApiServer(runtime, new WebAuth(origin)); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const { port } = server.address() as { port: number };
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const call = (path: string, method = 'GET', body?: unknown) => new Promise<{ status: number; headers: Record<string, unknown>; body: Buffer }>((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const outgoing = request(`http://127.0.0.1:${port}${path}`, { method, headers: { host: 'niwa.test', 'tailscale-user-login': 'owner@example.com', origin, 'content-type': 'application/json', ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } }, incoming => {
      const chunks: Buffer[] = []; incoming.on('data', chunk => chunks.push(Buffer.from(chunk)));
      incoming.on('end', () => resolve({ status: incoming.statusCode!, headers: incoming.headers, body: Buffer.concat(chunks) })); incoming.on('error', reject);
    });
    outgoing.on('error', reject); outgoing.end(data);
  });
  const big = Buffer.concat([png(10, 10), Buffer.alloc(2 * 1024 * 1024)]);
  assert.equal((await call(`/api/rooms/${room.id}/messages`, 'POST', { id: randomUUID(), body: '写真', attachments: [file('庭.png', big), file('案内.pdf', pdf('Gate 10'))] })).status, 200);
  const [image, document] = runtime.messageAttachments(admin, room.id);
  const shown = await call(`/api/attachments/${image!.id}?view=1`);
  assert.deepEqual([shown.status, shown.headers['content-type'], String(shown.headers['content-disposition']).split(';')[0], shown.body.length], [200, 'image/png', 'inline', big.length]);
  assert.match(String(shown.headers['content-security-policy']), /sandbox/); assert.equal(shown.headers['x-content-type-options'], 'nosniff');
  assert.equal(String((await call(`/api/attachments/${image!.id}`)).headers['content-disposition']).split(';')[0], 'attachment');
  const downloaded = await call(`/api/attachments/${document!.id}?view=1`);
  assert.deepEqual([downloaded.headers['content-type'], String(downloaded.headers['content-disposition']).split(';')[0], downloaded.body.subarray(0, 5).toString()], ['application/pdf', 'attachment', '%PDF-']);
  const text = await call(`/api/attachments/${document!.id}?text=1`);
  assert.deepEqual([text.headers['content-type'], text.body.toString()], ['text/plain; charset=utf-8', 'Gate 10']);
});
