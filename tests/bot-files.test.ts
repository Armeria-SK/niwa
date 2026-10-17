import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Runtime } from '../src/runtime/runtime.ts';
import { DomainError } from '../src/domain/types.ts';
import type { JsonObject } from '../src/contracts/model.ts';

const KEY = 'sk-ant-api03-artificial-0123456789abcdefghijklmnop';
function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'niwa-bot-file-'));
  const runtime = new Runtime(root);
  t.after(() => { runtime.close(); rmSync(root, { recursive: true, force: true }); });
  const admin = runtime.administrator(), leader = runtime.bootstrap(admin), bot = runtime.agentSession(leader.id);
  runtime.updateProfile(admin, leader.id, { role: '案内係', persona: `ていねいに話す。メモ：${KEY}`, shape: 'cloud', color: '#336699', motion: 'float' });
  const shared = runtime.createRoom(admin, '共有の相談'), secret = runtime.createRoom(admin, '個別の相談', [leader.id]);
  const open = runtime.remember(bot, runtime.post(admin, shared.id, '集合は北口').id, '集合は北口');
  const hidden = runtime.remember(bot, runtime.post(admin, secret.id, '家の鍵は植木鉢の下').id, '家の鍵は植木鉢の下');
  // Procedures are saved by the Bot's tools; here they are written directly into its memory database.
  const memory = new DatabaseSync(join(root, 'agents', leader.id, 'memory.db'));
  const procedure = (id: string, room: string, title: string) => {
    memory.prepare('INSERT INTO procedures(id,room_id,revision,enabled) VALUES (?,?,1,1)').run(id, room);
    memory.prepare('INSERT INTO procedure_versions VALUES (?,1,?,?)').run(id, JSON.stringify({ title, conditions: '集合の案内を頼まれたとき', steps: ['場所を確かめる', `時刻を書く ${KEY}`], sources: [] }), Date.now());
  };
  procedure('a'.repeat(64), shared.id, '集合の案内'); procedure('b'.repeat(64), secret.id, '家の手順');
  memory.close();
  return { runtime, admin, leader, bot, open, hidden };
}

test('the export lists only what came from shared conversations and counts the private rest', t => {
  const { runtime, admin, leader, open } = fixture(t);
  const options = runtime.botFiles.options(admin, leader.id);
  assert.deepEqual(options.procedures.map(item => [item.id, item.title]), [['a'.repeat(64), '集合の案内']]);
  assert.equal(options.private_procedures, 1);
  assert.deepEqual(options.memories.map(item => item.id), [open.id]);
  assert.equal(options.private_memories, 1);
  assert.ok(!JSON.stringify(options).includes('植木鉢'));
});

test('the file holds the personality, look and chosen procedures, no memories unless chosen, and hides secrets', t => {
  const { runtime, admin, leader, open } = fixture(t);
  const plain = runtime.botFiles.build(admin, leader.id, { procedures: ['a'.repeat(64)], memories: [] }, Date.UTC(2026, 9, 17, 3));
  assert.match(plain.filename, /^niwa-bot-リーダー-20261017\.json$/);
  const file = JSON.parse(plain.text);
  assert.deepEqual(Object.keys(file), ['format', 'version', 'exported_at', 'note', 'bot', 'appearance', 'procedures', 'memories']);
  assert.equal(file.format, 'niwa-bot'); assert.equal(file.version, 1);
  assert.deepEqual(file.bot.name, 'リーダー'); assert.equal(file.bot.role, '案内係');
  assert.deepEqual(file.appearance, { shape: 'cloud', color: '#336699', motion: 'float' });
  assert.deepEqual(file.procedures.map((item: { title: string }) => item.title), ['集合の案内']);
  assert.deepEqual(file.memories, []);
  assert.ok(!plain.text.includes(KEY) && plain.text.includes('[REDACTED]'), 'secret-looking text is hidden everywhere');
  assert.ok(!plain.text.includes(leader.id) && !plain.text.includes('共有の相談'), 'no ids or conversation names');
  const withMemory = JSON.parse(runtime.botFiles.build(admin, leader.id, { procedures: [], memories: [open.id] }).text);
  assert.deepEqual(withMemory.memories, [{ body: '集合は北口' }]); assert.deepEqual(withMemory.procedures, []);
});

test('anything from a private conversation is refused, and only the administrator can export', t => {
  const { runtime, admin, leader, bot, hidden } = fixture(t);
  assert.throws(() => runtime.botFiles.build(admin, leader.id, { procedures: ['b'.repeat(64)], memories: [] }), (error: unknown) => error instanceof DomainError && error.code === 'forbidden');
  assert.throws(() => runtime.botFiles.build(admin, leader.id, { procedures: [], memories: [hidden.id] }), (error: unknown) => error instanceof DomainError && error.code === 'forbidden');
  assert.throws(() => runtime.botFiles.options(bot, leader.id), /Administrator required/);
});

const IMPORT = '00000000-0000-4000-8000-000000000001', AGAIN = '00000000-0000-4000-8000-000000000002';
function exported(t: { after(fn: () => void): void }) {
  const f = fixture(t);
  return { ...f, text: f.runtime.botFiles.build(f.admin, f.leader.id, { procedures: ['a'.repeat(64)], memories: [f.open.id] }).text };
}
const refused = (code: string) => (error: unknown) => error instanceof DomainError && error.code === code;

test('reading a file back shows its full text and what it makes first, then makes a new Bot whose procedures and memories cite your messages', t => {
  const { runtime, admin, leader, text } = exported(t);
  const agents = runtime.agents(admin).length, rooms = runtime.rooms(admin).length, leaderProfile = runtime.profile(admin, leader.id);
  const preview = runtime.botFiles.preview(admin, text);
  assert.ok(preview.ok);
  assert.equal(preview.text, text, 'a file Niwa wrote is shown exactly as written');
  assert.equal(preview.hidden, 0);
  assert.deepEqual(preview.bot, { name: 'リーダー', role: '案内係', persona: 'ていねいに話す。メモ：[REDACTED]' });
  assert.deepEqual(preview.appearance, { shape: 'cloud', color: '#336699', motion: 'float' });
  assert.deepEqual(preview.procedures, [{ title: '集合の案内', steps: 2 }]); assert.equal(preview.memories, 1);
  assert.equal(preview.room_title, 'ファイルから迎えたリーダーの手順と記憶');
  assert.deepEqual([preview.members, preview.limit], [0, 10]);
  assert.equal(runtime.agents(admin).length, agents, 'looking makes nothing');
  assert.equal(runtime.rooms(admin).length, rooms);

  const made = runtime.botFiles.import(admin, IMPORT, text, { procedures: true, memories: true });
  assert.deepEqual([made.procedures, made.memories], [1, 1]);
  const bot = runtime.agents(admin).find(item => item.id === made.agent_id)!;
  assert.ok(bot.id !== leader.id && bot.name === 'リーダー');
  assert.deepEqual(runtime.profile(admin, bot.id), { role: '案内係', persona: 'ていねいに話す。メモ：[REDACTED]', shape: 'cloud', color: '#336699', motion: 'float' });
  assert.deepEqual(runtime.profile(admin, leader.id), leaderProfile, 'the Bot the file came from is not changed');

  const room = runtime.rooms(admin).find(item => item.id === made.room_id)!;
  assert.deepEqual([room.title, room.visibility], ['ファイルから迎えたリーダーの手順と記憶', 'shared']);
  const messages = runtime.messages(admin, room.id);
  assert.deepEqual(messages.map(message => message.author_id), ['administrator', 'administrator', 'administrator']);
  assert.match(messages[0]!.body, /手順1件と記憶1件/);
  assert.equal(messages[1]!.body, '手順：集合の案内\n使うとき：集合の案内を頼まれたとき\n1. 場所を確かめる\n2. 時刻を書く [REDACTED]');
  assert.equal(messages[2]!.body, '集合は北口');

  // The memory shows where it came from, like any other: your words in that conversation.
  const [memory] = runtime.memoryPageWithSources(admin, bot.id).items;
  assert.equal(memory!.body, '集合は北口');
  assert.deepEqual([memory!.source_message_id, memory!.source?.room_title, memory!.source?.excerpt, memory!.source?.author_id], [messages[2]!.id, room.title, '集合は北口', 'administrator']);

  // The new Bot can use the procedure; its source is checked each time it is read, as for a procedure it saved itself.
  const [procedure] = runtime.procedureBook(admin, bot.id);
  assert.deepEqual([procedure!.title, procedure!.enabled, procedure!.room_title, procedure!.private, procedure!.imported], ['集合の案内', true, room.title, false, true]);
  const other = runtime.createRoom(admin, '別の相談');
  runtime.tasks.create(admin, bot.id, other.id, '集合を案内して');
  const actor = runtime.agentSession(bot.id), lease = runtime.tasks.claim(admin)!;
  const run = (name: string, args: JsonObject) => runtime.procedureTool(actor, lease, name, name, args);
  assert.deepEqual((run('procedure_search', { query: '集合' }).results as JsonObject[]).map(item => item.id), [procedure!.id]);
  const read = run('procedure_read', { id: procedure!.id, revision: null });
  assert.equal(read.origin, 'imported'); assert.ok(!('source_task_id' in read));
  assert.deepEqual(read.sources, [{ kind: 'message', source_id: messages[1]!.id, revision: runtime.readHistory(actor, other.id, 'message', messages[1]!.id).revision }]);
  assert.deepEqual(run('procedure_apply', { id: procedure!.id, revision: 1, plan_revision: 0, applicability: '集合の案内を頼まれた' }), { id: procedure!.id, revision: 1, plan_revision: 1 });

  // Deleting the conversation takes them away, as it does for any conversation.
  runtime.deleteContent(admin, 'room', room.id);
  assert.deepEqual(runtime.memories(admin, bot.id), []); assert.deepEqual(runtime.procedureBook(admin, bot.id), []);
});

test('a procedure from a file can be updated by its Bot in that conversation and restored to the version from the file', t => {
  const { runtime, admin, text } = exported(t);
  const made = runtime.botFiles.import(admin, IMPORT, text, { procedures: true, memories: false });
  const room = made.room_id!, actor = runtime.agentSession(made.agent_id), id = runtime.procedureBook(admin, made.agent_id)[0]!.id;
  const done = runtime.tasks.create(admin, made.agent_id, room, '集合を案内する');
  runtime.tasks.finish(actor, runtime.tasks.claim(admin)!, '北口で案内した');
  runtime.tasks.create(admin, made.agent_id, room, '次の案内');
  const lease = runtime.tasks.claim(admin)!, run = (name: string, args: JsonObject) => runtime.procedureTool(actor, lease, name, name, args);
  const message = runtime.messages(admin, room)[1]!;
  run('procedure_save', { id, expected_revision: 1, procedure: { title: '集合の案内', conditions: '集合の案内を頼まれたとき', steps: ['北口へ行く'], source_task_id: done.id,
    sources: [{ kind: 'message', source_id: message.id, revision: runtime.readHistory(actor, room, 'message', message.id).revision }] } });
  const saved = run('procedure_read', { id, revision: null });
  assert.deepEqual([saved.steps, saved.source_task_id, 'origin' in saved], [['北口へ行く'], done.id, false]);
  assert.deepEqual(run('procedure_restore', { id, expected_revision: 2, revision: 1 }), { id, revision: 3 });
  const restored = run('procedure_read', { id, revision: null });
  assert.deepEqual([restored.origin, restored.steps, 'source_task_id' in restored], ['imported', ['場所を確かめる', '時刻を書く [REDACTED]'], false]);
});

test('leaving procedures and memories out brings only the personality and look, and a resent request makes nothing twice', t => {
  const { runtime, admin, text } = exported(t);
  const agents = runtime.agents(admin).length, rooms = runtime.rooms(admin).length;
  const plain = runtime.botFiles.import(admin, IMPORT, text, { procedures: false, memories: false });
  assert.deepEqual(plain, { agent_id: plain.agent_id, room_id: null, procedures: 0, memories: 0 });
  assert.equal(runtime.rooms(admin).length, rooms, 'no conversation is made when nothing needs a source');
  assert.deepEqual(runtime.memories(admin, plain.agent_id), []); assert.deepEqual(runtime.procedureBook(admin, plain.agent_id), []);
  assert.deepEqual(runtime.botFiles.import(admin, IMPORT, text, { procedures: false, memories: false }), plain);
  assert.throws(() => runtime.botFiles.import(admin, IMPORT, text, { procedures: true, memories: false }), refused('conflict'));
  const full = runtime.botFiles.import(admin, AGAIN, text, { procedures: true, memories: true });
  assert.deepEqual(runtime.botFiles.import(admin, AGAIN, text, { procedures: true, memories: true }), full);
  assert.equal(runtime.agents(admin).length, agents + 2);
  assert.equal(runtime.rooms(admin).length, rooms + 1);
  assert.equal(runtime.messages(admin, full.room_id!).length, 3);
  assert.equal(runtime.memories(admin, full.agent_id).length, 1); assert.equal(runtime.procedureBook(admin, full.agent_id).length, 1);
});

test('a file that is not exactly what Niwa writes is refused, with where it differs, and nothing is made', t => {
  const { runtime, admin, bot, text } = exported(t);
  const agents = runtime.agents(admin).length, rooms = runtime.rooms(admin).length;
  const changed = (edit: (file: Record<string, any>) => void) => { const file = JSON.parse(text); edit(file); return JSON.stringify(file); };
  const cases: [string, unknown][] = [
    ['{ "format": ', [{ kind: 'json', path: '' }]],
    ['[]', [{ kind: 'format', path: '' }]],
    [changed(file => { file.format = 'niwa-seed'; }), [{ kind: 'format', path: '/format' }]],
    [changed(file => { file.version = 2; }), [{ kind: 'version', path: '/version' }]],
    [changed(file => { file.appearance.shape = 'dragon'; }), [{ kind: 'value', path: '/appearance/shape' }]],
    [changed(file => { file.appearance.color = 'red'; file.appearance.motion = 'spin'; }), [{ kind: 'value', path: '/appearance/color' }, { kind: 'value', path: '/appearance/motion' }]],
    [changed(file => { file.bot.model = 'gpt'; }), [{ kind: 'unknown', path: '/bot/model' }]],
    [changed(file => { delete file.appearance.motion; }), [{ kind: 'missing', path: '/appearance/motion' }]],
    [changed(file => { file.bot.name = '   '; }), [{ kind: 'blank', path: '/bot/name' }]],
    [changed(file => { file.procedures[0].steps = Array.from({ length: 31 }, () => '手順'); }), [{ kind: 'value', path: '/procedures/0/steps' }]],
    [changed(file => { file.procedures[0].steps = Array.from({ length: 30 }, () => 'あ'.repeat(600)); }), [{ kind: 'too_long', path: '/procedures/0' }]],
    ['x'.repeat(6_000_001), [{ kind: 'size', path: '' }]],
  ];
  for (const [input, problems] of cases) {
    assert.deepEqual(runtime.botFiles.preview(admin, input), { ok: false, problems }, input.slice(0, 80));
    assert.throws(() => runtime.botFiles.import(admin, IMPORT, input, { procedures: true, memories: true }), refused('invalid'));
  }
  assert.deepEqual([runtime.agents(admin).length, runtime.rooms(admin).length], [agents, rooms]);
  assert.throws(() => runtime.botFiles.preview(bot, text), /Administrator required/);
  assert.throws(() => runtime.botFiles.import(bot, IMPORT, text, { procedures: false, memories: false }), /Administrator required/);
});

test('secret-looking text in a file stays hidden in what is shown and in the Bot that is made', t => {
  const { runtime, admin, text } = exported(t);
  const file = JSON.parse(text);
  file.bot.persona = `合言葉は ${KEY}`; file.memories[0].body = `鍵 ${KEY}`;
  const edited = JSON.stringify(file), preview = runtime.botFiles.preview(admin, edited);
  assert.ok(preview.ok && preview.hidden === 2 && !preview.text.includes(KEY) && preview.text.includes('合言葉は [REDACTED]'));
  const made = runtime.botFiles.import(admin, IMPORT, edited, { procedures: true, memories: true });
  assert.equal(runtime.profile(admin, made.agent_id).persona, '合言葉は [REDACTED]');
  assert.deepEqual(runtime.memories(admin, made.agent_id).map(memory => memory.body), ['鍵 [REDACTED]']);
  assert.ok(!JSON.stringify(runtime.messages(admin, made.room_id!)).includes(KEY));
});

test('the Bot limit is kept: at the limit the file is shown but no Bot or conversation is made', t => {
  const { runtime, admin, text } = exported(t);
  runtime.updateSettings(admin, { generatedLimit: 0 });
  const agents = runtime.agents(admin).length, rooms = runtime.rooms(admin).length, preview = runtime.botFiles.preview(admin, text);
  assert.ok(preview.ok); assert.deepEqual([preview.members, preview.limit], [0, 0]);
  assert.throws(() => runtime.botFiles.import(admin, IMPORT, text, { procedures: true, memories: true }), refused('limit'));
  assert.deepEqual([runtime.agents(admin).length, runtime.rooms(admin).length], [agents, rooms]);
});
