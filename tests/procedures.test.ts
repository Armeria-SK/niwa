import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Runtime } from '../src/runtime/runtime.ts';
import type { JsonObject } from '../src/contracts/model.ts';
import { DatabaseSync } from 'node:sqlite';

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'niwa-procedures-'));
  const runtime = new Runtime(root);
  t.after(() => { runtime.close(); rmSync(root, { recursive: true, force: true }); });
  const admin = runtime.administrator(), leader = runtime.bootstrap(admin), actor = runtime.agentSession(leader.id);
  const room = runtime.createRoom(admin, '共有');
  const source = runtime.post(admin, room.id, '人工の検証資料');
  const completed = runtime.tasks.create(admin, leader.id, room.id, '前の仕事');
  runtime.tasks.finish(actor, runtime.tasks.claim(admin)!, '検証済みの結果');
  const task = runtime.tasks.create(admin, leader.id, room.id, '次の仕事'), lease = runtime.tasks.claim(admin)!;
  const procedure = { title: '資料確認', conditions: '同じ資料の更新を調べるとき', steps: ['原文を読む', '前回と比較する'],
    source_task_id: completed.id, sources: [{ kind: 'message', source_id: source.id, revision: runtime.readHistory(actor, room.id, 'message', source.id).revision }] };
  const run = (name: string, args: JsonObject, op = name) => runtime.procedureTool(actor, lease, op, name, args);
  return { root, runtime, admin, actor, leader, room, task, lease, completed, source, procedure, run };
}

test('procedures retain versions, restore old steps, record actual use results and reject stale application', t => {
  const f = fixture(t);
  assert.throws(() => f.run('procedure_save', { id: null, expected_revision: 0, procedure: { ...f.procedure, source_task_id: f.task.id } }, 'unfinished'), /completed task/);
  const created = f.run('procedure_save', { id: null, expected_revision: 0, procedure: f.procedure }, 'create');
  assert.deepEqual(f.run('procedure_save', { id: null, expected_revision: 0, procedure: f.procedure }, 'create'), created);
  const id = created.id;
  assert.equal((f.run('procedure_search', { query: '資料確認' }).results as JsonObject[]).length, 1);
  f.run('procedure_save', { id, expected_revision: 1, procedure: { ...f.procedure, steps: ['別の手順'] } }, 'update');
  assert.throws(() => f.run('procedure_save', { id, expected_revision: 1, procedure: f.procedure }, 'stale'), /revision changed/);
  assert.deepEqual(f.run('procedure_restore', { id, expected_revision: 2, revision: 1 }, 'restore'), { id, revision: 3 });
  assert.deepEqual(f.run('procedure_read', { id, revision: null }).steps, f.procedure.steps);
  assert.deepEqual(f.run('procedure_read', { id, revision: null }).versions, [3, 2, 1]);
  assert.throws(() => f.run('procedure_apply', { id, revision: 1, plan_revision: 0, applicability: '同じ資料' }, 'old-version'), /current enabled/);
  f.run('procedure_set_enabled', { id, enabled: false }, 'disable');
  assert.equal((f.run('procedure_search', { query: '資料確認' }).results as JsonObject[]).length, 0);
  assert.throws(() => f.run('procedure_apply', { id, revision: 3, plan_revision: 0, applicability: '同じ資料' }, 'disabled-use'), /current enabled/);
  f.run('procedure_set_enabled', { id, enabled: true }, 'enable');
  const input = { id, revision: 3, plan_revision: 0, applicability: '同じ資料の次回更新なので適用' };
  f.run('procedure_apply', input, 'apply'); f.run('procedure_apply', input, 'apply');
  const state = f.runtime.tasks.workState(f.actor, f.lease);
  assert.deepEqual(state.remaining_plan.remaining, f.procedure.steps);
  assert.equal(state.applied_procedures.length, 1);
  assert.equal(state.external_operations.length, 0);
  f.runtime.tasks.finish(f.actor, f.lease, '今回の更新結果');
  const next = f.runtime.tasks.create(f.admin, f.leader.id, f.room.id, '結果を確認');
  const nextLease = f.runtime.tasks.claim(f.admin)!;
  const uses = f.runtime.procedureTool(f.actor, nextLease, 'read', 'procedure_read', { id, revision: null }).uses as JsonObject[];
  assert.equal(uses[0]!.state, 'completed'); assert.equal(uses[0]!.result, '今回の更新結果');
  assert.notEqual(uses[0]!.task_id, next.id);
});

test('procedure use remains scoped to the bot and private conversation, including use reasons', t => {
  const f = fixture(t);
  const id = f.run('procedure_save', { id: null, expected_revision: 0, procedure: f.procedure }).id;
  const child = f.runtime.createAgent(f.actor, '別Bot');
  assert.throws(() => f.runtime.procedureTool(f.runtime.agentSession(child.id), f.lease, 'other', 'procedure_read', { id, revision: null }), /active/);
  f.runtime.tasks.create(f.admin, child.id, f.room.id, '別Botの仕事');
  const childActor = f.runtime.agentSession(child.id), childLease = f.runtime.tasks.claim(f.admin)!;
  assert.throws(() => f.runtime.procedureTool(childActor, childLease, 'own-read', 'procedure_read', { id, revision: null }), /unavailable/);
  f.runtime.tasks.finish(childActor, childLease, '終了');
  f.runtime.tasks.finish(f.actor, f.lease, '保存完了');
  const privateRoom = f.runtime.createRoom(f.admin, '個別', [f.leader.id]);
  f.runtime.tasks.create(f.admin, f.leader.id, privateRoom.id, '個別の仕事');
  const privateLease = f.runtime.tasks.claim(f.admin)!;
  f.runtime.procedureTool(f.actor, privateLease, 'private-use', 'procedure_apply', { id, revision: 1, plan_revision: 0, applicability: '私的な理由' });
  assert.throws(() => f.runtime.procedureTool(f.actor, privateLease, 'private-update', 'procedure_save',
    { id, expected_revision: 1, procedure: { ...f.procedure, conditions: '私的な条件' } }), /original conversation/);
  const privateId = f.runtime.procedureTool(f.actor, privateLease, 'private-copy', 'procedure_save', { id: null, expected_revision: 0, procedure: f.procedure }).id;
  f.runtime.tasks.finish(f.actor, privateLease, '私的な結果');
  f.runtime.tasks.create(f.admin, f.leader.id, f.room.id, '共有へ戻る');
  const sharedLease = f.runtime.tasks.claim(f.admin)!;
  const read = f.runtime.procedureTool(f.actor, sharedLease, 'shared-read', 'procedure_read', { id, revision: null });
  assert.deepEqual(read.uses, []);
  assert.throws(() => f.runtime.procedureTool(f.actor, sharedLease, 'private-read', 'procedure_read', { id: privateId, revision: null }), /unavailable/);
});

test('procedures persist across restart but changed sources cannot be used and memory deletion purges old versions', t => {
  const f = fixture(t);
  const id = f.run('procedure_save', { id: null, expected_revision: 0, procedure: f.procedure }).id;
  const memory = f.runtime.remember(f.actor, f.source.id, '削除する人工記憶');
  f.runtime.close();
  const runtime = new Runtime(f.root);
  const db = new DatabaseSync(join(f.root, 'control.db'));
  try {
    const admin = runtime.administrator(), actor = runtime.agentSession(f.leader.id);
    runtime.tasks.recover(admin); const lease = runtime.tasks.claim(admin)!;
    assert.equal(runtime.procedureTool(actor, lease, 'read', 'procedure_read', { id, revision: null }).revision, 1);
    db.prepare('UPDATE messages SET body=? WHERE id=?').run('変更済みの原文', f.source.id);
    assert.deepEqual(runtime.procedureTool(actor, lease, 'search', 'procedure_search', { query: '資料確認' }).results, []);
    assert.throws(() => runtime.procedureTool(actor, lease, 'apply', 'procedure_apply', { id, revision: 1, plan_revision: 0, applicability: '条件' }), /source changed/);
    runtime.deleteMemory(admin, f.leader.id, memory.id, 1);
    assert.throws(() => runtime.procedureTool(actor, lease, 'read-again', 'procedure_read', { id, revision: null }), /unavailable/);
  } finally { db.close(); runtime.close(); }
});
