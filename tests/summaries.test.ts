import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Runtime, type Actor } from '../src/runtime/runtime.ts';
import type { WorkSummary } from '../src/domain/summary.ts';

function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), 'niwa-summary-'));
  const runtime = new Runtime(root);
  t.after(() => { runtime.close(); rmSync(root, { recursive: true, force: true }); });
  const admin = runtime.administrator(), leader = runtime.bootstrap(admin), actor = runtime.agentSession(leader.id);
  const child = runtime.createAgent(actor, '別Bot'), shared = runtime.createRoom(admin, '共有');
  return { root, runtime, admin, leader, actor, child, shared };
}
function citation(runtime: Runtime, actor: Actor, room: string, kind: string, id: string) {
  const { source_id, revision } = runtime.readHistory(actor, room, kind, id);
  return { kind, source_id, revision };
}
const summary = (sources: WorkSummary['sources'], conclusion = '調査の結論'): WorkSummary => ({
  conclusion, reason: '資料の数値を照合した', unresolved: ['未確認の範囲'], next_steps: ['次回に再確認'], sources,
});

test('sourced summaries remain private to their bot and originating private conversation', t => {
  const f = fixture(t), r = f.runtime;
  const privateRoom = r.createRoom(f.admin, '個別', [f.leader.id]);
  const otherRoom = r.createRoom(f.admin, '別個別', [f.leader.id]);
  const sharedSource = r.post(f.admin, f.shared.id, '共有の原文');
  const privateSource = r.post(f.admin, privateRoom.id, '私的な原文');
  const task = r.tasks.create(f.admin, f.leader.id, f.shared.id, '人工調査の目的');
  const lease = r.tasks.claim(f.admin)!;
  const body = summary([citation(r, f.actor, f.shared.id, 'message', sharedSource.id)]);
  assert.deepEqual(r.saveSummary(f.actor, lease, 'summary-1', body), { id: task.id, revision: 1 });
  assert.deepEqual(r.saveSummary(f.actor, lease, 'summary-1', body), { id: task.id, revision: 1 });
  assert.throws(() => r.saveSummary(f.actor, lease, 'summary-1', { ...body, conclusion: '変更' }), /input changed/);
  assert.throws(() => r.saveSummary(r.agentSession(f.child.id), lease, 'other', body), /active/);
  assert.throws(() => r.saveSummary(f.actor, lease, 'private', summary([citation(r, f.actor, privateRoom.id, 'message', privateSource.id)])), /unavailable/);
  assert.equal(r.searchHistory(f.actor, f.shared.id, '調査の結論').filter(item => item.kind === 'summary').length, 1);
  assert.equal(r.searchHistory(r.agentSession(f.child.id), f.shared.id, '調査の結論').length, 0);
  const saved = JSON.parse(r.readHistory(f.actor, f.shared.id, 'summary', task.id).text);
  assert.equal(saved.purpose, task.prompt); assert.equal(saved.task_state, 'running');
  assert.deepEqual(saved.sources, body.sources); assert.equal(saved.generated, true);
  r.tasks.finish(f.actor, lease, '調査済み');
  const privateTask = r.tasks.create(f.admin, f.leader.id, privateRoom.id, '個別調査');
  const privateLease = r.tasks.claim(f.admin)!;
  r.saveSummary(f.actor, privateLease, 'private', summary([citation(r, f.actor, privateRoom.id, 'message', privateSource.id)], '私的な結論'));
  assert.equal(r.searchHistory(f.actor, f.shared.id, '私的な結論').length, 0);
  assert.equal(r.searchHistory(f.actor, otherRoom.id, '私的な結論').length, 0);
  assert.equal(r.searchHistory(f.actor, privateRoom.id, '私的な結論').length, 1);
  assert.throws(() => r.readHistory(f.actor, f.shared.id, 'summary', privateTask.id), /unavailable/);
});

test('summary dependencies are revalidated and invalidated text is removed from the bot index', t => {
  const f = fixture(t), r = f.runtime;
  const source = r.post(f.admin, f.shared.id, '元の情報');
  const memory = r.remember(f.actor, source.id, '訂正前の記憶');
  const task = r.tasks.create(f.admin, f.leader.id, f.shared.id, '依存関係を確認');
  const lease = r.tasks.claim(f.admin)!;
  const old = summary([citation(r, f.actor, f.shared.id, 'memory', memory.id)], '訂正前の要約');
  r.saveSummary(f.actor, lease, 'memory', old);
  r.correctMemory(f.admin, f.leader.id, memory.id, 1, '訂正後の記憶');
  assert.throws(() => r.saveSummary(f.actor, lease, 'stale', old), /changed/);
  const db = new DatabaseSync(join(f.root, 'agents', f.leader.id, 'memory.db'));
  const control = new DatabaseSync(join(f.root, 'control.db'));
  try {
    assert.equal(db.prepare('SELECT count(*) AS count FROM task_summaries').get()!.count, 0);
    assert.equal(db.prepare('SELECT count(*) AS count FROM summary_search').get()!.count, 0);
    r.saveSummary(f.actor, lease, 'message', summary([citation(r, f.actor, f.shared.id, 'message', source.id)], '旧原文の要約'));
    control.prepare('UPDATE messages SET body=? WHERE id=?').run('変更後の情報', source.id);
    assert.equal(r.searchHistory(f.actor, f.shared.id, '旧原文の要約').length, 0);
    assert.equal(db.prepare('SELECT count(*) AS count FROM summary_search').get()!.count, 0);
    r.saveSummary(f.actor, lease, 'updated', summary([citation(r, f.actor, f.shared.id, 'message', source.id)]));
    control.prepare('DELETE FROM messages WHERE id=?').run(source.id);
    assert.throws(() => r.readHistory(f.actor, f.shared.id, 'summary', task.id), /unavailable/);
    assert.equal(db.prepare('SELECT count(*) AS count FROM task_summaries').get()!.count, 0);
  } finally { db.close(); control.close(); }
});

test('summaries can be searched after restart and new instructions invalidate the old task summary', t => {
  const f = fixture(t), r = f.runtime;
  const source = r.post(f.admin, f.shared.id, '再起動用の資料');
  const task = r.tasks.create(f.admin, f.leader.id, f.shared.id, '翌日の更新');
  const lease = r.tasks.claim(f.admin)!;
  r.saveSummary(f.actor, lease, 'saved', summary([citation(r, f.actor, f.shared.id, 'message', source.id)]));
  r.close();
  const resumed = new Runtime(f.root);
  try {
    const actor = resumed.agentSession(f.leader.id), admin = resumed.administrator();
    assert.equal(resumed.searchHistory(actor, f.shared.id, '翌日の更新').filter(item => item.kind === 'summary').length, 1);
    resumed.tasks.recover(admin);
    resumed.tasks.instruct(admin, task.id, '新しい方針');
    assert.equal(resumed.searchHistory(actor, f.shared.id, '調査の結論').length, 0);
  } finally { resumed.close(); }
});
