import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runtime } from '../src/runtime/runtime.ts';
import { openDatabase } from '../src/storage/database.ts';
import { controlSchema, memoryMigrations } from '../src/storage/schema.ts';

test('memory schema upgrade preserves existing work and purges derived plans on revision changes', t => {
  const root = mkdtempSync(join(tmpdir(), 'niwa-plan-upgrade-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'memory.db');
  const old = openDatabase(path, memoryMigrations.slice(0, 2));
  old.prepare('INSERT INTO task_steps VALUES (?,?,?,?,0)').run('artificial-task', 0, 0, '[]');
  old.close();
  const upgraded = openDatabase(path, memoryMigrations);
  try {
    assert.equal(upgraded.prepare('SELECT count(*) AS count FROM task_steps').get()!.count, 1);
    upgraded.prepare('INSERT INTO task_plans VALUES (?,?,?,?,?,?)').run('artificial-task', 1, 0, '["old private plan"]', 'operation', 'hash');
    upgraded.exec('UPDATE memory_state SET revision=revision+1 WHERE id=1');
    assert.equal(upgraded.prepare('SELECT count(*) AS count FROM task_plans').get()!.count, 0);
    assert.equal(upgraded.prepare('SELECT count(*) AS count FROM task_steps').get()!.count, 1);
  } finally { upgraded.close(); }
});

function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), 'niwa-tasks-'));
  const runtime = new Runtime(root);
  t.after(() => { runtime.close(); rmSync(root, { recursive: true, force: true }); });
  const admin = runtime.administrator();
  const leader = runtime.bootstrap(admin);
  const parentActor = runtime.agentSession(leader.id);
  const child = runtime.createAgent(parentActor, '人工の子');
  const childActor = runtime.agentSession(child.id);
  const room = runtime.createRoom(admin, '庭');
  return { root, runtime, admin, leader, parentActor, child, childActor, room, tasks: runtime.tasks };
}

test('remaining plans survive restart, reject stale writes and disappear on memory correction or new instructions', t => {
  const f = fixture(t);
  const source = f.runtime.post(f.admin, f.room.id, '計画の出所');
  const memory = f.runtime.remember(f.parentActor, source.id, '計画用の記憶');
  const task = f.tasks.create(f.admin, f.leader.id, f.room.id, '長い仕事');
  const lease = f.tasks.claim(f.admin)!;
  assert.deepEqual(f.tasks.workState(f.parentActor, lease).remaining_plan, { revision: 0, remaining: [] });
  const remaining = ['資料を確認', '結論を検証'];
  assert.deepEqual(f.tasks.updatePlan(f.parentActor, lease, 'plan-1', 0, remaining), { revision: 1 });
  assert.deepEqual(f.tasks.updatePlan(f.parentActor, lease, 'plan-1', 0, remaining), { revision: 1 });
  assert.throws(() => f.tasks.updatePlan(f.parentActor, lease, 'plan-1', 0, ['改変']), /input changed/);
  assert.throws(() => f.tasks.updatePlan(f.parentActor, lease, 'stale', 0, []), /Plan changed/);
  assert.throws(() => f.tasks.updatePlan(f.childActor, lease, 'other', 1, []), /another agent/);
  f.runtime.close();
  const reopened = new Runtime(f.root);
  try {
    const admin = reopened.administrator(), actor = reopened.agentSession(f.leader.id);
    reopened.tasks.recover(admin); let resumed = reopened.tasks.claim(admin)!;
    assert.deepEqual(reopened.tasks.workState(actor, resumed).remaining_plan, { revision: 1, remaining });
    reopened.tasks.updatePlan(actor, resumed, 'plan-2', 1, ['結論を検証']);
    reopened.correctMemory(admin, f.leader.id, memory.id, 1, '訂正後');
    assert.deepEqual(reopened.tasks.workState(actor, resumed).remaining_plan, { revision: 0, remaining: [] });
    reopened.tasks.updatePlan(actor, resumed, 'plan-3', 0, ['訂正後の計画']);
    reopened.tasks.instruct(admin, task.id, '方針を変更');
    resumed = reopened.tasks.claim(admin)!;
    assert.deepEqual(reopened.tasks.workState(actor, resumed).remaining_plan, { revision: 0, remaining: [] });
    reopened.tasks.updatePlan(actor, resumed, 'plan-4', 0, ['管理者の回答を確認']);
    reopened.tasks.wait(actor, resumed, 'waiting_user', '質問');
    reopened.tasks.resume(admin, task.id, '回答');
    resumed = reopened.tasks.claim(admin)!;
    assert.deepEqual(reopened.tasks.workState(actor, resumed).remaining_plan, { revision: 0, remaining: [] });
    assert.equal(reopened.tasks.get(admin, task.id).state, 'running');
  } finally { reopened.close(); }
});

test('private task history pages survive restart and reject changed results, revisions and other bots', t => {
  const f = fixture(t);
  const source = f.runtime.post(f.admin, f.room.id, '人工の出所');
  const memory = f.runtime.remember(f.parentActor, source.id, '人工の記憶');
  const task = f.tasks.create(f.admin, f.leader.id, f.room.id, '過去交換を確認');
  const lease = f.tasks.claim(f.admin)!;
  const input = { name: 'web_read', arguments: { url: 'https://example.com/' } };
  f.tasks.saveStep(f.parentActor, lease, 0, [
    { type: 'text_delta', text: '作業中の記録'.repeat(5000) },
    { type: 'tool_call', tool_call_id: 'page', ...input }, { type: 'completed', finish_reason: 'tool_calls' },
  ]);
  const before = f.tasks.readStep(f.parentActor, lease, 0);
  assert.equal(typeof before.next_offset, 'number');
  f.tasks.once(f.parentActor, lease, '0:0', input, () => ({ text: '保存済みの資料' }));
  assert.throws(() => f.tasks.readStep(f.parentActor, lease, 0, before.next_offset as number, before.revision as string), /changed/);
  assert.throws(() => f.tasks.readStep(f.childActor, lease, 0), /another agent/);
  assert.throws(() => f.tasks.readStep(f.parentActor, lease, 0, 1), /revision/);
  assert.throws(() => f.tasks.readStep(f.parentActor, lease, -1), /position/);
  const first = f.tasks.readStep(f.parentActor, lease, 0);
  f.runtime.close();
  const reopened = new Runtime(f.root);
  try {
    const admin = reopened.administrator(), actor = reopened.agentSession(f.leader.id);
    reopened.tasks.recover(admin);
    const resumed = reopened.tasks.claim(admin)!;
    let content = first.text as string, next = first.next_offset;
    while (typeof next === 'number') {
      const page = reopened.tasks.readStep(actor, resumed, 0, next, first.revision as string);
      content += page.text; next = page.next_offset;
    }
    assert.equal(JSON.parse(content).tool_results[0].result.text, '保存済みの資料');
    assert.equal(JSON.parse(content).events[0].text, '作業中の記録'.repeat(5000));
    reopened.correctMemory(admin, f.leader.id, memory.id, 1, '訂正済み');
    assert.throws(() => reopened.tasks.readStep(actor, resumed, 0), /unavailable/);
    const step = reopened.tasks.saveStep(actor, resumed, 1, [{ type: 'text_delta', text: '新しい記録' }]);
    assert.match(String(reopened.tasks.readStep(actor, resumed, step).text), /新しい記録/);
    reopened.tasks.instruct(admin, task.id, '追加指示');
    const instructed = reopened.tasks.claim(admin)!;
    assert.throws(() => reopened.tasks.readStep(actor, instructed, step), /unavailable/);
  } finally { reopened.close(); }
});

test('work state is rebuilt after restart with scoped facts and without lease tokens or private transcript', async t => {
  const root = mkdtempSync(join(tmpdir(), 'niwa-work-state-'));
  let runtime = new Runtime(root);
  t.after(() => { runtime.close(); rmSync(root, { recursive: true, force: true }); });
  let admin = runtime.administrator();
  const leader = runtime.bootstrap(admin);
  let actor = runtime.agentSession(leader.id);
  const child = runtime.createAgent(actor, '子');
  const room = runtime.createRoom(admin, '共有');
  const task = runtime.tasks.create(admin, leader.id, room.id, '最初の依頼');
  let lease = runtime.tasks.claim(admin)!;
  runtime.tasks.saveStep(actor, lease, 0, [{ type: 'text_delta', text: '私的な途中思考' }]);
  runtime.reportUpdate(actor, room.id, 'decision', '決定', '採用した方針', task.id);
  const artifact = runtime.createArtifact(actor, room.id, '成果.md', '資料', '検証済み資料', '全文は別取得', task.id);
  const unrelated = runtime.tasks.create(admin, child.id, room.id, '別の仕事');
  runtime.reportUpdate(actor, room.id, 'decision', '混ぜない決定', '別件の内容', unrelated.id);
  runtime.tasks.cancel(admin, unrelated.id);
  await runtime.tasks.externalOnce(actor, lease, 'write', { path: '成果.md' }, async () => ({ revision: 'saved' }));
  const delegated = runtime.tasks.delegate(actor, lease, child.id, '担当分');
  const childLease = runtime.tasks.claim(admin)!;
  runtime.tasks.finish(runtime.agentSession(child.id), childLease, '子の完了報告');
  runtime.tasks.instruct(admin, task.id, '次は更新する');
  lease = runtime.tasks.claim(admin)!;
  assert.throws(() => runtime.tasks.workState(runtime.agentSession(child.id), lease), /another agent/);
  const oldToken = lease.token;
  runtime.close(); runtime = new Runtime(root); admin = runtime.administrator(); actor = runtime.agentSession(leader.id);
  runtime.tasks.recover(admin);
  assert.throws(() => runtime.tasks.workState(actor, lease), /lease/);
  lease = runtime.tasks.claim(admin)!;
  const state = runtime.tasks.workState(actor, lease);
  assert.equal(state.task.prompt, '最初の依頼');
  assert.equal(state.administrator_replies[0]!.body, '次は更新する');
  assert.equal(state.child_results[0]!.task_id, delegated.id);
  assert.equal(state.child_results[0]!.result, '子の完了報告');
  assert.equal(state.artifacts[0]!.id, artifact);
  assert.equal(state.saved_model_steps, 1);
  assert.equal(state.external_operations[0]!.outcome, 'recorded');
  assert.deepEqual(state.external_operations[0]!.result, { revision: 'saved' });
  const encoded = JSON.stringify(state);
  assert.match(encoded, /採用した方針/);
  for (const excluded of [oldToken, lease.token, '私的な途中思考', '混ぜない決定', '別件の内容', '全文は別取得']) assert.equal(encoded.includes(excluded), false);
  runtime.tasks.pause(admin, task.id);
  assert.throws(() => runtime.tasks.workState(actor, lease), /lease/);
});

test('late external completion is recorded after pause without resuming or repeating the operation', async t => {
  const f = fixture(t);
  const task = f.tasks.create(f.admin, f.leader.id, f.room.id, '共有資料を保存');
  const lease = f.tasks.claim(f.admin)!;
  let calls = 0;
  const input = { name: 'workspace_write', path: 'research.md', content: '人工資料' };
  await assert.rejects(f.tasks.externalOnce(f.childActor, lease, 'write', input, async () => { calls++; return {}; }));
  const output = await f.tasks.externalOnce(f.parentActor, lease, 'write', input, async executionId => {
    assert.match(executionId, /^[a-f0-9-]{36}$/); calls++;
    f.tasks.pause(f.admin, task.id); return { path: 'research.md', revision: 'artificial-revision' };
  });
  assert.equal(f.tasks.get(f.admin, task.id).paused, 1); assert.equal(f.tasks.claim(f.admin), undefined);
  f.tasks.resume(f.admin, task.id); const resumed = f.tasks.claim(f.admin)!;
  assert.deepEqual(await f.tasks.externalOnce(f.parentActor, resumed, 'write', input, async () => { calls++; return {}; }), output);
  await assert.rejects(f.tasks.externalOnce(f.parentActor, resumed, 'write', { ...input, content: '変更' }, async () => { calls++; return {}; }), /input changed/);
  assert.equal(calls, 1);
});

test('unknown external operations wait and keep their executor id across a runtime restart', async t => {
  const root = mkdtempSync(join(tmpdir(), 'niwa-external-'));
  let runtime = new Runtime(root);
  t.after(() => { runtime.close(); rmSync(root, { recursive: true, force: true }); });
  let admin = runtime.administrator(); const leader = runtime.bootstrap(admin);
  const room = runtime.createRoom(admin, '庭');
  const task = runtime.tasks.create(admin, leader.id, room.id, '共有資料を保存');
  let executionId = '';
  await runtime.tasks.externalOnce(runtime.agentSession(leader.id), runtime.tasks.claim(admin)!, 'write', { content: '人工資料' }, async id => {
    executionId = id; throw new Error('Artificial lost response');
  });
  assert.equal(runtime.tasks.get(admin, task.id).state, 'waiting_user');
  runtime.close(); runtime = new Runtime(root); admin = runtime.administrator();
  runtime.tasks.recover(admin); assert.equal(runtime.tasks.claim(admin), undefined);
  runtime.tasks.resume(admin, task.id);
  const output = await runtime.tasks.externalOnce(runtime.agentSession(leader.id), runtime.tasks.claim(admin)!, 'write', { content: '人工資料' }, async id => {
    assert.equal(id, executionId); return { confirmed: true };
  });
  assert.deepEqual(output, { confirmed: true });
});

test('individual controls invalidate leases, retain replies, and respect global pause', t => {
  const f = fixture(t);
  const task = f.tasks.create(f.admin, f.leader.id, f.room.id, '操作対象');
  const lease = f.tasks.claim(f.admin)!;
  f.tasks.pause(f.admin, task.id);
  assert.equal(f.tasks.active(f.parentActor, lease), false);
  assert.equal(f.tasks.claim(f.admin), undefined);
  f.tasks.recover(f.admin);
  assert.equal(f.tasks.get(f.admin, task.id).paused, 1);
  f.tasks.instruct(f.admin, task.id, '小さく進める');
  assert.equal(f.tasks.get(f.admin, task.id).paused, 1);
  assert.equal(f.tasks.replies(f.admin, task.id)[0]?.body, '小さく進める');
  f.runtime.updateSettings(f.admin, { paused: true });
  f.tasks.resume(f.admin, task.id);
  assert.equal(f.tasks.claim(f.admin), undefined);
  f.runtime.updateSettings(f.admin, { paused: false });
  const resumed = f.tasks.claim(f.admin)!;
  f.tasks.instruct(f.admin, task.id, '追加の変更');
  assert.equal(f.tasks.active(f.parentActor, resumed), false);
  f.tasks.cancel(f.admin, task.id);
  f.tasks.retry(f.admin, task.id);
  assert.equal(f.tasks.get(f.admin, task.id).state, 'queued');
  const finalLease = f.tasks.claim(f.admin)!;
  f.tasks.complete(f.admin, task.id);
  assert.equal(f.tasks.active(f.parentActor, finalLease), false);
  assert.equal(f.tasks.get(f.admin, task.id).result, '管理者が完了にしました');
  assert.throws(() => f.tasks.retry(f.admin, task.id), /cannot be retried/);
});

test('artifacts retain exact text and room access; recap acknowledgements survive restart', t => {
  const f = fixture(t);
  const room = f.runtime.createRoom(f.admin, '個別の成果物', [f.leader.id]);
  const id = f.runtime.createArtifact(f.parentActor, room.id, '確認メモ.md', 'メモ', '保存した資料', '# 資料\n\n<script>text</script>');
  assert.equal(f.runtime.artifact(f.admin, id).content, '# 資料\n\n<script>text</script>');
  assert.equal(f.runtime.artifacts(f.childActor).length, 0);
  assert.throws(() => f.runtime.artifact(f.childActor, id), /unavailable/);
  assert.throws(() => f.runtime.createArtifact(f.parentActor, room.id, '../bad', 'メモ', '説明', '本文'), /filename/);
  assert.equal(f.runtime.artifacts(f.admin).length, 1);
  const updates = f.runtime.updates(f.admin);
  assert.equal(updates[0]?.artifact_id, id);
  assert.throws(() => f.runtime.readUpdates(f.parentActor, [Number(updates[0]?.id)]), /Administrator/);
  f.runtime.readUpdates(f.admin, [Number(updates[0]?.id)]);
  const reopened = new Runtime(f.root);
  try {
    const admin = reopened.administrator();
    assert.equal(reopened.updates(admin)[0]?.seen, 1);
    assert.equal(reopened.artifact(admin, id).name, '確認メモ.md');
  } finally { reopened.close(); }
});

test('parent wait frees a single execution slot; child completion resumes parent exactly once', t => {
  const f = fixture(t);
  f.runtime.updateSettings(f.admin, { concurrencyLimit: 1 });
  const parent = f.tasks.create(f.admin, f.leader.id, f.room.id, '共同作業');
  const parentLease = f.tasks.claim(f.admin)!;
  assert.equal(f.tasks.claim(f.admin), undefined);
  const child = f.tasks.delegate(f.parentActor, parentLease, f.child.id, '子の担当');
  assert.equal(f.tasks.get(f.admin, parent.id).state, 'waiting_child');
  const childLease = f.tasks.claim(f.admin)!;
  assert.equal(childLease.task.id, child.id);
  f.tasks.finish(f.childActor, childLease, '子の結果');
  const before = f.tasks.events(f.admin).length;
  f.tasks.finish(f.childActor, childLease, '子の結果');
  assert.equal(f.tasks.events(f.admin).length, before);
  const resumed = f.tasks.claim(f.admin)!;
  assert.equal(resumed.task.id, parent.id);
  assert.equal(resumed.task.attempt, 2);
  assert.throws(() => f.tasks.finish(f.parentActor, parentLease, '古い処理'), /lease/);
  f.tasks.finish(f.parentActor, resumed, '全体の結果');
  assert.equal(f.tasks.get(f.admin, parent.id).state, 'completed');
});

test('task reads, delegation, and lease ownership respect private conversation access', t => {
  const f = fixture(t);
  const privateRoom = f.runtime.createRoom(f.admin, '親だけ', [f.leader.id]);
  const parent = f.tasks.create(f.admin, f.leader.id, privateRoom.id, '人工の私的依頼');
  const lease = f.tasks.claim(f.admin)!;
  assert.throws(() => f.tasks.get(f.childActor, parent.id), /unavailable/);
  assert.throws(() => f.tasks.delegate(f.parentActor, lease, f.child.id, '漏えい'), /cannot access/);
  assert.throws(() => f.tasks.finish(f.childActor, lease, '偽の完了'), /another agent/);
  assert.equal(f.tasks.events(f.childActor).length, 0);
  assert.equal(f.tasks.get(f.admin, parent.id).state, 'running');
});

test('failed or cancelled children notify their parent; parent cancellation cancels its descendants', t => {
  const f = fixture(t);
  const parent = f.tasks.create(f.admin, f.leader.id, f.room.id, '共同作業');
  const first = f.tasks.claim(f.admin)!;
  f.tasks.delegate(f.parentActor, first, f.child.id, '失敗予定');
  const childLease = f.tasks.claim(f.admin)!;
  f.tasks.finish(f.childActor, childLease, '人工の失敗', 'failed');
  const second = f.tasks.claim(f.admin)!;
  const child = f.tasks.delegate(f.parentActor, second, f.child.id, '取消予定');
  f.tasks.cancel(f.admin, child.id);
  assert.equal(f.tasks.get(f.admin, parent.id).state, 'queued');
  const third = f.tasks.claim(f.admin)!;
  const descendant = f.tasks.delegate(f.parentActor, third, f.child.id, '親と同時に取消');
  f.tasks.cancel(f.admin, parent.id);
  assert.equal(f.tasks.get(f.admin, descendant.id).state, 'cancelled');
  assert.equal(f.tasks.claim(f.admin), undefined);
});

test('pause and dormancy invalidate running leases and preserve queued work', t => {
  const f = fixture(t);
  const task = f.tasks.create(f.admin, f.child.id, f.room.id, '継続する仕事');
  const old = f.tasks.claim(f.admin)!;
  f.runtime.updateSettings(f.admin, { paused: true });
  assert.equal(f.tasks.claim(f.admin), undefined);
  assert.throws(() => f.tasks.finish(f.childActor, old, '停止後の結果'), /lease/);
  f.runtime.updateSettings(f.admin, { paused: false });
  const next = f.tasks.claim(f.admin)!;
  assert.equal(next.task.id, task.id);
  f.runtime.setDormant(f.parentActor, f.child.id, true);
  assert.equal(f.tasks.claim(f.admin), undefined);
  f.runtime.setDormant(f.parentActor, f.child.id, false);
  assert.equal(f.tasks.claim(f.admin)?.task.id, task.id);
});

test('restart recovers interrupted model work; user replies and wait states survive', t => {
  const f = fixture(t);
  const task = f.tasks.create(f.admin, f.leader.id, f.room.id, '確認が必要');
  const lease = f.tasks.claim(f.admin)!;
  f.tasks.wait(f.parentActor, lease, 'waiting_user', '色を教えてください');
  f.tasks.resume(f.admin, task.id, '青');
  f.tasks.claim(f.admin);
  f.runtime.close();
  const next = new Runtime(f.root);
  try {
    const admin = next.administrator(); next.tasks.recover(admin);
    const resumed = next.tasks.claim(admin)!;
    assert.equal(resumed.task.id, task.id);
    assert.equal(resumed.task.attempt, 3);
    assert.equal(next.tasks.replies(admin, task.id)[0]?.body, '青');
  } finally { next.close(); }
});

test('deadlines end waits rather than leaving parent tasks waiting forever', t => {
  const f = fixture(t);
  const parent = f.tasks.create(f.admin, f.leader.id, f.room.id, '期限付き');
  const lease = f.tasks.claim(f.admin)!;
  const child = f.tasks.delegate(f.parentActor, lease, f.child.id, '期限までに回答');
  f.tasks.expire(f.admin, parent.deadline_at + 1);
  assert.equal(f.tasks.get(f.admin, parent.id).state, 'failed');
  assert.equal(f.tasks.get(f.admin, child.id).state, 'failed');
});

test('migration retains v1 leader and settings', t => {
  const root = mkdtempSync(join(tmpdir(), 'niwa-migrate-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = openDatabase(join(root, 'control.db'), controlSchema);
  db.prepare('UPDATE settings SET paused=1 WHERE id=1').run();
  db.close();
  const runtime = new Runtime(root);
  try {
    const admin = runtime.administrator();
    assert.equal(runtime.settings(admin).paused, true);
    assert.deepEqual(runtime.tasks.list(admin), []);
  } finally { runtime.close(); }
});
