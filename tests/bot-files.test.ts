import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Runtime } from '../src/runtime/runtime.ts';
import { DomainError } from '../src/domain/types.ts';

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
