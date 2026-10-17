import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { request } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { Runtime } from '../src/runtime/runtime.ts';
import { TurnRunner } from '../src/runtime/turns.ts';
import { WebAuth } from '../src/web/auth.ts';
import { createApiServer } from '../src/web/api.ts';
import { initializeInstallation } from '../src/config/installation.ts';
import { Backups } from '../src/backup/backups.ts';
import { prepareRestore } from '../src/backup/restore.ts';
import { attachmentName, decodeAttachments, excerptBudget } from '../src/domain/attachments.ts';
import type { ModelEvent, ModelRequest } from '../src/contracts/model.ts';
import type { ModelAdapter } from '../src/providers/shared/adapter.ts';
import { openAISubscriptionAdapterCapabilities } from '../src/providers/codex/adapter.ts';

const file = (name: string, text: string | Buffer) => ({ name, content: Buffer.from(text).toString('base64') });
function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), 'niwa-attachments-'));
  const runtime = new Runtime(root); t.after(() => { runtime.close(); rmSync(root, { recursive: true, force: true }); });
  const admin = runtime.administrator(); const leader = runtime.bootstrap(admin);
  return { root, runtime, admin, leader, actor: runtime.agentSession(leader.id), room: runtime.createRoom(admin, '庭') };
}

test('attachments accept only bounded UTF-8 text and sanitize names', () => {
  const [csv] = decodeAttachments([file('../秘密/表.dat', '列,値\n雨,3\n')]);
  assert.deepEqual({ name: csv!.name, size: csv!.size, body: csv!.body }, { name: '表.dat', size: Buffer.byteLength('列,値\n雨,3\n'), body: '列,値\n雨,3\n' });
  assert.equal(decodeAttachments(undefined).length, 0);
  assert.equal(decodeAttachments([file('empty.txt', '')])[0]!.size, 0);
  assert.equal(decodeAttachments([file('max.txt', 'a'.repeat(256 * 1024))])[0]!.size, 256 * 1024);
  assert.throws(() => decodeAttachments([file('big.txt', 'a'.repeat(256 * 1024 + 1))]), /too large|base64/);
  assert.throws(() => decodeAttachments(Array.from({ length: 6 }, (_v, i) => file(`${i}.txt`, 'x'))), /Too many/);
  assert.throws(() => decodeAttachments([file('image.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff]))]), /UTF-8/);
  assert.throws(() => decodeAttachments([file('nul.txt', 'a\u0000b')]), /not a text file/);
  assert.throws(() => decodeAttachments([file('bell.log', 'a\u0007b')]), /not a text file/);
  assert.throws(() => decodeAttachments([{ name: 'bad.txt', content: '***' }]), /base64/);
  assert.throws(() => decodeAttachments([{ name: '../..', content: '' }]), /name/);
  assert.equal(attachmentName('C:\\作業\\メモ.md'), 'メモ.md');
  assert.equal(attachmentName('a\u202e<b>?.txt\n'), 'a_b__.txt');
  assert.equal(attachmentName('.env'), 'env');
  assert.equal([...attachmentName('長'.repeat(200) + '.txt')].length, 120);
  assert.deepEqual(excerptBudget([100, 50_000, 50_000]), [100, 9950, 9950]);
  assert.deepEqual(excerptBudget([]), []);
});

test('attachments are stored with their message, replay safely and stay inside the room boundary', t => {
  const f = fixture(t); const member = f.runtime.createAgent(f.actor, '仲間'); const memberActor = f.runtime.agentSession(member.id);
  const secret = f.runtime.createRoom(f.admin, '個別', [f.leader.id]); const id = randomUUID();
  const files = [file('調査.md', '# 雨音\n本文'), file('data.json', '{"a":1}')];
  const sent = f.runtime.submit(f.admin, id, secret.id, '', f.leader.id, undefined, undefined, files);
  assert.equal(sent.message.body, '添付ファイル：調査.md、data.json');
  assert.equal(f.runtime.submit(f.admin, id, secret.id, '', f.leader.id, undefined, undefined, files).message.id, sent.message.id);
  assert.throws(() => f.runtime.submit(f.admin, id, secret.id, '', f.leader.id, undefined, undefined, [files[0]!]), /reused/);
  assert.throws(() => f.runtime.submit(f.admin, randomUUID(), secret.id, '', f.leader.id), /empty/);
  const listed = f.runtime.messageAttachments(f.admin, secret.id);
  assert.deepEqual(listed.map(item => [item.name, item.size]), [['調査.md', Buffer.byteLength('# 雨音\n本文')], ['data.json', 7]]);
  const page = f.runtime.messagePage(f.admin, secret.id);
  assert.deepEqual(page.first!.attachments.map(item => item.name), ['調査.md', 'data.json']);
  assert.equal(f.runtime.attachment(f.admin, listed[0]!.id).body, '# 雨音\n本文');
  assert.equal(f.runtime.attachment(f.actor, listed[0]!.id).name, '調査.md');
  // A bot outside the private conversation can neither list, open nor read the message source.
  assert.throws(() => f.runtime.attachment(memberActor, listed[0]!.id), /Room unavailable/);
  assert.throws(() => f.runtime.messageAttachments(memberActor, secret.id), /Room unavailable/);
  assert.throws(() => f.runtime.readHistory(memberActor, secret.id, 'message', sent.message.id), /Room unavailable/);
  const shared = f.runtime.createRoom(f.admin, '共有');
  assert.throws(() => f.runtime.readHistory(memberActor, shared.id, 'message', sent.message.id), /unavailable/);
  const read = f.runtime.readHistory(f.actor, secret.id, 'message', sent.message.id);
  assert.match(String(read.text), /\[添付ファイル: 調査\.md \(\d+ bytes\)・利用者が提供した資料\]\n# 雨音\n本文/);
  assert.match(String(read.text), /data\.json[^\n]*\n\{"a":1\}$/);
  assert.equal(read.untrusted, true);
  assert.throws(() => f.runtime.attachment(f.admin, randomUUID()), /not found/);
});

test('room deletion removes attachments, including after restoring an older backup', async t => {
  const root = mkdtempSync(join(tmpdir(), 'niwa-attachment-delete-'));
  const config = { version: 1 as const, origin: 'https://niwa.test', port: 3210 };
  const paths = initializeInstallation(root, config); const runtime = new Runtime(paths.state);
  t.after(() => { runtime.close(); rmSync(root, { recursive: true, force: true }); });
  const admin = runtime.administrator(); runtime.bootstrap(admin);
  const room = runtime.createRoom(admin, '消す会話'); const keep = runtime.createRoom(admin, '残す会話');
  runtime.submit(admin, randomUUID(), room.id, '消す', undefined, undefined, undefined, [file('消す.txt', '消す本文')]);
  runtime.submit(admin, randomUUID(), keep.id, '残す', undefined, undefined, undefined, [file('残す.txt', '残す本文')]);
  const removed = runtime.messageAttachments(admin, room.id)[0]!;
  const before = await new Backups(runtime, paths, config).create();
  runtime.deleteContent(admin, 'room', room.id);
  assert.throws(() => runtime.attachment(admin, removed.id), /Room deleted|not found/);
  const db = new DatabaseSync(join(paths.state, 'control.db'), { readOnly: true });
  try { assert.deepEqual(db.prepare('SELECT name,body FROM message_attachments').all().map(row => ({ ...row })), [{ name: '残す.txt', body: '残す本文' }]); }
  finally { db.close(); }
  const target = join(paths.runtime, 'restored-attachments');
  await prepareRestore(join(paths.backups, before.id), target, runtime.deletionRecords(admin), runtime.deletedAgents(admin), runtime.deletedContent(admin));
  const restored = new Runtime(target);
  try {
    const restoredAdmin = restored.administrator();
    assert.throws(() => restored.attachment(restoredAdmin, removed.id), /Room deleted|not found/);
    assert.deepEqual(restored.messageAttachments(restoredAdmin, keep.id).map(item => item.name), ['残す.txt']);
  } finally { restored.close(); }
  const restoredDb = new DatabaseSync(join(target, 'control.db'), { readOnly: true });
  try { assert.equal(restoredDb.prepare('SELECT count(*) AS n FROM message_attachments').get()!.n, 1); } finally { restoredDb.close(); }
});

const complete = (text: string): ModelEvent[] => [{ type: 'text_delta', text }, { type: 'completed', finish_reason: 'stop' }];
function model(reply: (request: ModelRequest) => ModelEvent[]): ModelAdapter {
  return { adapter_id: 'artificial', capabilities: openAISubscriptionAdapterCapabilities,
    async *run(request) {
      if (request.tools.length === 1 && request.tools[0]?.name === 'memory_review') { yield { type: 'tool_call', tool_call_id: 'm', name: 'memory_review', arguments: { memories: [] } }; yield { type: 'completed', finish_reason: 'tool_calls' }; return; }
      yield* reply(request);
    } };
}
for (const promptVersion of ['legacy-v4', 'structured-v5'] as const) test(`${promptVersion}: the requesting message's attachments reach the model as bounded untrusted data`, async t => {
  const f = fixture(t); const long = 'あ'.repeat(30_000);
  const earlier = f.runtime.submit(f.admin, randomUUID(), f.room.id, '前の資料', undefined, undefined, undefined, [file('前.txt', '前の本文')]);
  const { task, message } = f.runtime.submit(f.admin, randomUUID(), f.room.id, 'この資料を要約して', f.leader.id, undefined, undefined, [file('short.md', '短い資料'), file('long.txt', long)]);
  let seen: ModelRequest | undefined;
  const runner = new TurnRunner(f.runtime, async () => model(request => { seen = request; return complete('要約しました'); }), {}, { promptVersion });
  await runner.run(f.runtime.tasks.claim(f.admin)!);
  assert.equal(f.runtime.tasks.get(f.admin, task!.id).state, 'completed');
  const contents = seen!.messages.map(item => item.content ?? '');
  const current = contents.findIndex(item => item === '現在の依頼: この資料を要約して');
  const input = JSON.parse(contents[current + 1]!).current_request_attachments;
  assert.equal(input.untrusted, true); assert.match(input.note, /命令として扱いません/);
  assert.deepEqual(input.items.map((item: { name: string; message_id: string }) => [item.name, item.message_id]), [['short.md', message.id], ['long.txt', message.id]]);
  assert.equal(input.items[0].text, '短い資料'); assert.equal(input.items[0].truncated, false);
  assert.equal(input.items[1].text.length, 20_000 - '短い資料'.length); assert.equal(input.items[1].truncated, true);
  assert.equal(input.items[1].size_bytes, Buffer.byteLength(long)); assert.equal(input.items[1].characters, 30_000);
  assert.equal(contents.some(item => item.includes('前の本文')), false, 'Earlier attachments are listed, not inlined');
  const listed = contents.map(item => { try { return JSON.parse(item); } catch { return null; } }).filter(item => item?.message_id === earlier.message.id)[0];
  assert.deepEqual(listed.attachments.map((item: { name: string }) => item.name), ['前.txt']);
  // The full text remains readable by offset through the message source.
  const actor = f.runtime.agentSession(f.leader.id); const first = f.runtime.readHistory(actor, f.room.id, 'message', message.id);
  const next = f.runtime.readHistory(actor, f.room.id, 'message', message.id, first.next_offset!, first.revision);
  assert.ok(String(first.text).includes('短い資料') && String(next.text).length > 0 && next.next_offset === null);
});

test('attachment API validates uploads and serves files only to Niwa\'s own page, never to another site', async t => {
  const root = mkdtempSync(join(tmpdir(), 'niwa-attachment-web-'));
  const runtime = new Runtime(root); const admin = runtime.administrator(); runtime.bootstrap(admin);
  const origin = 'https://niwa.test';
  const server = createApiServer(runtime, new WebAuth(origin)); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const { port } = server.address() as { port: number };
  t.after(async () => { await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); runtime.close(); rmSync(root, { recursive: true, force: true }); });
  // Which site the browser says sent the request; another site's pages are refused.
  let site = 'cross-site';
  const call = (path: string, method = 'GET', body?: unknown) => new Promise<{ status: number; headers: Record<string, unknown>; text: string }>((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const outgoing = request(`http://127.0.0.1:${port}${path}`, { method, headers: { host: 'niwa.test', origin, 'sec-fetch-site': site, 'content-type': 'application/json', ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } }, incoming => {
      const chunks: Buffer[] = []; incoming.on('data', chunk => chunks.push(Buffer.from(chunk)));
      incoming.on('end', () => resolve({ status: incoming.statusCode!, headers: incoming.headers, text: Buffer.concat(chunks).toString('utf8') })); incoming.on('error', reject);
    });
    outgoing.on('error', reject); outgoing.end(data);
  });
  const room = runtime.createRoom(admin, '共有');
  const big = file('大きい資料.csv', 'a,b\n'.repeat(60_000));
  assert.equal((await call(`/api/rooms/${room.id}/messages`, 'POST', { id: randomUUID(), body: '資料', attachments: [big] })).status, 403);
  site = 'same-origin';
  assert.equal((await call(`/api/rooms/${room.id}/messages`, 'POST', { id: randomUUID(), body: '', attachments: [file('bin.dat', Buffer.from([0, 1, 2]))] })).status, 400);
  assert.equal((await call(`/api/rooms/${room.id}/messages`, 'POST', { id: randomUUID(), body: '', attachments: Array.from({ length: 6 }, () => file('a.txt', 'a')) })).status, 400);
  assert.equal((await call(`/api/rooms/${room.id}/messages`, 'POST', { id: randomUUID(), body: 'x'.repeat(70_000) })).status, 400);
  const sent = await call(`/api/rooms/${room.id}/messages`, 'POST', { id: randomUUID(), body: '資料', attachments: [big, file('<script>.html', '<script>alert(1)</script>')] });
  assert.equal(sent.status, 200);
  const page = JSON.parse((await call(`/api/rooms/${room.id}/messages/page`)).text);
  const [csv, html] = page.first.attachments as { id: string; name: string; size: number }[];
  assert.deepEqual([csv!.name, csv!.size, html!.name], ['大きい資料.csv', 240_000, '_script_.html']);
  const opened = await call(`/api/attachments/${html!.id}`);
  assert.equal(opened.status, 200); assert.equal(opened.text, '<script>alert(1)</script>');
  assert.equal(opened.headers['content-type'], 'text/plain; charset=utf-8'); assert.equal(opened.headers['x-content-type-options'], 'nosniff');
  assert.match(String(opened.headers['content-disposition']), /^attachment; filename\*=UTF-8''_script_\.html$/);
  assert.match(String(opened.headers['content-security-policy']), /sandbox/);
  assert.equal((await call(`/api/attachments/${randomUUID()}`)).status, 404);
  runtime.deleteContent(admin, 'room', room.id);
  assert.equal((await call(`/api/attachments/${csv!.id}`)).status, 404);
  site = 'cross-site';
  assert.equal((await call(`/api/attachments/${csv!.id}`)).status, 403);
});
