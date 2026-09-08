import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runtime } from '../src/runtime/runtime.ts';
import { executeTurnTool } from '../src/runtime/turn-tools.ts';

test('public work notes persist without messages or dispatch, replay once and close only for their own reply', t => {
  const root = mkdtempSync(join(tmpdir(), 'niwa-notes-'));
  const r = new Runtime(root), admin = r.administrator(), leader = r.bootstrap(admin), actor = r.agentSession(leader.id);
  t.after(() => { r.close(); rmSync(root, { recursive: true, force: true }); });
  const bot = r.createAgent(actor, '仲間'), room = r.createRoom(admin, '作業');
  r.tasks.create(admin, leader.id, room.id, '公開資料を確認');
  const lease = r.tasks.claim(admin)!;
  const call = { name: 'work_note', tool_call_id: 'note', arguments: { body: '公開資料の更新日を確認しています。' } };
  executeTurnTool(r, actor, lease, call, '0:0');
  executeTurnTool(r, actor, lease, call, '0:0');
  r.addWorkNote(actor, lease, call.arguments.body);
  assert.equal(r.workNotes(admin, room.id).length, 1);
  assert.equal(r.messages(admin, room.id).length, 0);
  assert.equal(r.tasks.list(admin).length, 1);
  assert.equal(r.tasks.get(admin, lease.task.id).state, 'running');
  r.tasks.create(admin, bot.id, room.id, '別の調査');
  const second = r.tasks.claim(admin)!;
  r.addWorkNote(r.agentSession(bot.id), second, '別の資料を確認しています。');
  r.respond(actor, lease, '公開資料の更新日を確認しました。', []);
  assert.ok(r.workNotes(admin, room.id).find(n => n.task_id === lease.task.id)!.reply_id);
  assert.equal(r.workNotes(admin, room.id).find(n => n.task_id === second.task.id)!.reply_id, null);
  assert.throws(() => r.addWorkNote(actor, lease, '終了後の追記'), /lease/);
  const reopened = new Runtime(root);
  try { assert.deepEqual(reopened.workNotes(reopened.administrator(), room.id), r.workNotes(admin, room.id)); }
  finally { reopened.close(); }
});

test('work notes enforce participant, active owner and size limits, and disappear with deleted room content', t => {
  const root = mkdtempSync(join(tmpdir(), 'niwa-private-notes-'));
  const r = new Runtime(root), admin = r.administrator(), leader = r.bootstrap(admin), actor = r.agentSession(leader.id);
  t.after(() => { r.close(); rmSync(root, { recursive: true, force: true }); });
  const bot = r.createAgent(actor, '別のBot'), room = r.createRoom(admin, '個別', [leader.id]);
  r.tasks.create(admin, leader.id, room.id, '個別の作業');
  const lease = r.tasks.claim(admin)!;
  r.addWorkNote(actor, lease, 'この会話にだけ公開する進捗です。');
  assert.throws(() => r.workNotes(r.agentSession(bot.id), room.id), /unavailable/);
  assert.throws(() => r.addWorkNote(r.agentSession(bot.id), lease, '他者の作業'), /lease/);
  assert.throws(() => r.addWorkNote(actor, { ...lease, token: 'stale' }, '古い実行'), /lease/);
  assert.throws(() => r.addWorkNote(actor, lease, ' '.repeat(3)), /short/);
  assert.throws(() => r.addWorkNote(actor, lease, 'x'.repeat(301)), /short/);
  r.applyContentDeletions(admin, [{ kind: 'room', id: room.id, deleted_at: Date.now() }]);
  assert.throws(() => r.workNotes(admin, room.id), /deleted/);
});
