import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Runtime } from '../src/runtime/runtime.ts';
import { Scheduler } from '../src/runtime/scheduler.ts';
import { setImmediate } from 'node:timers/promises';

function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), 'niwa-schedules-'));
  let runtime = new Runtime(root);
  t.after(() => { runtime.close(); rmSync(root, { recursive: true, force: true }); });
  const admin = runtime.administrator(); const leader = runtime.bootstrap(admin);
  const room = runtime.createRoom(admin, '定期調査');
  const input = { id: randomUUID(), agent_id: leader.id, room_id: room.id, prompt: '前回の資料を更新する',
    interval_ms: 60_000, next_at: Date.now() + 60_000, max_runs: 5, timeout_ms: 60_000 };
  return { root, runtime, admin, leader, room, input, reopen() { runtime.close(); runtime = new Runtime(root); return runtime; } };
}

test('scheduled occurrences persist, coalesce missed intervals, respect pauses and never overlap', t => {
  const f = fixture(t); let r = f.runtime; let admin = f.admin;
  r.schedules.create(admin, f.input);
  r.schedules.dispatch(admin, f.input.next_at - 1); assert.equal(r.tasks.list(admin).length, 0);
  r.updateSettings(admin, { paused: true });
  r = f.reopen(); admin = r.administrator();
  const due = f.input.next_at + 10 * f.input.interval_ms;
  r.schedules.dispatch(admin, due); assert.equal(r.tasks.list(admin).length, 0);
  r.updateSettings(admin, { paused: false }); r.schedules.dispatch(admin, due);
  assert.equal(r.schedules.list(admin)[0]!.next_at, due + f.input.interval_ms);
  r = f.reopen(); admin = r.administrator();
  r.schedules.dispatch(admin, due); r.schedules.dispatch(admin, due + f.input.interval_ms);
  assert.equal(r.tasks.list(admin).length, 1);
  r.tasks.cancel(admin, r.tasks.list(admin)[0]!.id);
  r.schedules.setEnabled(admin, f.input.id, false); r.schedules.dispatch(admin, due + f.input.interval_ms);
  assert.equal(r.tasks.list(admin).length, 1);
  r.schedules.setEnabled(admin, f.input.id, true); r.schedules.dispatch(admin, due + f.input.interval_ms);
  assert.equal(r.tasks.list(admin).length, 2);
  assert.equal(r.schedules.create(admin, f.input).run_count, 2);
  assert.throws(() => r.schedules.create(admin, { ...f.input, prompt: 'changed' }), /different input/);
});

test('schedule authorization, failed-run wait, run limit and atomic rollback', t => {
  const f = fixture(t); const r = f.runtime; const actor = r.agentSession(f.leader.id);
  assert.throws(() => r.schedules.create(actor, f.input), /Administrator/);
  assert.throws(() => r.schedules.list(actor), /Administrator/);
  assert.throws(() => r.schedules.dispatch(actor), /Administrator/);
  assert.throws(() => r.schedules.setEnabled(actor, f.input.id, false), /Administrator/);
  r.schedules.create(f.admin, { ...f.input, max_runs: 4 });
  const db = new DatabaseSync(join(f.root, 'control.db'));
  try {
    db.exec("CREATE TRIGGER reject_run BEFORE INSERT ON schedule_runs BEGIN SELECT RAISE(ABORT,'artificial failure'); END;");
    assert.throws(() => r.schedules.dispatch(f.admin, f.input.next_at), /artificial failure/);
    assert.equal(r.tasks.list(f.admin).length, 0); assert.equal(r.schedules.list(f.admin)[0]!.run_count, 0);
    db.exec('DROP TRIGGER reject_run;');
  } finally { db.close(); }
  for (let i = 0; i < 3; i++) {
    r.schedules.dispatch(f.admin, f.input.next_at + i * 60_000);
    r.tasks.cancel(f.admin, r.tasks.list(f.admin).at(-1)!.id);
  }
  r.schedules.dispatch(f.admin, f.input.next_at + 3 * 60_000);
  assert.match(r.schedules.list(f.admin)[0]!.wait_reason!, /3回/);
  assert.equal(r.updates(f.admin)[0]!.kind, 'question');
  assert.equal(r.updates(f.admin)[0]!.task_id, r.tasks.list(f.admin).at(-1)!.id);
  r.schedules.setEnabled(f.admin, f.input.id, true);
  r.schedules.dispatch(f.admin, f.input.next_at + 3 * 60_000);
  r.tasks.cancel(f.admin, r.tasks.list(f.admin).at(-1)!.id);
  r.schedules.dispatch(f.admin, f.input.next_at + 4 * 60_000);
  assert.match(r.schedules.list(f.admin)[0]!.wait_reason!, /上限/);
  assert.throws(() => r.schedules.setEnabled(f.admin, f.input.id, true), /limit/);
});

test('host scheduler executes due work and dormancy postpones new occurrences', async t => {
  const f = fixture(t); const r = f.runtime;
  const member = r.createAgent(r.agentSession(f.leader.id), '調査係');
  r.schedules.create(f.admin, { ...f.input, agent_id: member.id });
  const db = new DatabaseSync(join(f.root, 'control.db'));
  db.prepare('UPDATE schedules SET next_at=?').run(Date.now() - 1); db.close();
  r.setDormant(f.admin, member.id, true);
  let calls = 0;
  const scheduler = new Scheduler(r, { async run(lease) {
    calls++; r.tasks.finish(r.agentSession(member.id), lease, '出典付き資料を更新しました');
  } });
  scheduler.tick(); await setImmediate(); assert.equal(calls, 0);
  r.setDormant(f.admin, member.id, false);
  scheduler.tick(); await setImmediate(); assert.equal(calls, 1);
  scheduler.tick(); await setImmediate(); assert.equal(calls, 1);
  assert.equal(r.tasks.list(f.admin)[0]!.state, 'completed');
  await scheduler.stop();
});

test('private recipients are checked and archiving defers existing schedules', t => {
  const f = fixture(t); const r = f.runtime;
  const member = r.createAgent(r.agentSession(f.leader.id), '別のBot');
  const room = r.createRoom(f.admin, '個別', [f.leader.id]);
  assert.throws(() => r.schedules.create(f.admin, { ...f.input, room_id: room.id, agent_id: member.id }), /Room unavailable/);
  r.schedules.create(f.admin, f.input);
  r.organizeRoom(f.admin, f.room.id, { archived: true });
  r.schedules.dispatch(f.admin, f.input.next_at);
  assert.equal(r.tasks.list(f.admin).length, 0);
  assert.throws(() => r.schedules.create(f.admin, { ...f.input, id: randomUUID() }), /archived/);
  r.organizeRoom(f.admin, f.room.id, { archived: false });
  r.schedules.dispatch(f.admin, f.input.next_at);
  assert.equal(r.tasks.list(f.admin).length, 1);
});

test('schedule stop is reported once with its source task before the next occurrence, including after restart', t => {
  const f = fixture(t); let r = f.runtime; let admin = f.admin;
  r.schedules.create(admin, { ...f.input, max_runs: 1 });
  r.schedules.dispatch(admin, f.input.next_at);
  const task = r.tasks.list(admin)[0]!;
  r.tasks.cancel(admin, task.id);
  const db = new DatabaseSync(join(f.root, 'control.db'));
  try {
    db.exec("CREATE TRIGGER reject_notice BEFORE INSERT ON updates BEGIN SELECT RAISE(ABORT,'notification failure'); END;");
    assert.throws(() => r.schedules.dispatch(admin, f.input.next_at + 1), /notification failure/);
    assert.equal(r.schedules.list(admin)[0]!.enabled, 1);
    db.exec('DROP TRIGGER reject_notice;');
  } finally { db.close(); }
  r.schedules.dispatch(admin, f.input.next_at + 1);
  const notices = r.updates(admin);
  assert.equal(notices.length, 1); assert.equal(notices[0]!.task_id, task.id);
  assert.equal(notices[0]!.kind, 'decision'); assert.match(String(notices[0]!.detail), /上限/);
  r = f.reopen(); admin = r.administrator();
  r.schedules.dispatch(admin, f.input.next_at + 2);
  assert.equal(r.updates(admin).length, 1);
  assert.equal(r.schedules.list(admin)[0]!.enabled, 0);
});

test('model reservations share one persistent schedule budget across delegation and retries', t => {
  const f = fixture(t); let r = f.runtime; let admin = f.admin;
  const bot = r.createAgent(r.agentSession(f.leader.id), '委任先');
  r.schedules.create(admin, { ...f.input, max_model_calls: 2 });
  r.schedules.dispatch(admin, f.input.next_at);
  const parent = r.tasks.claim(admin)!; const actor = r.agentSession(f.leader.id);
  assert.throws(() => r.tasks.reserveModelCall(r.agentSession(bot.id), parent), /another agent/);
  assert.equal(r.tasks.reserveModelCall(actor, parent), true);
  r.tasks.delegate(actor, parent, bot.id, '資料を確認');
  const child = r.tasks.claim(admin)!;
  assert.equal(r.tasks.reserveModelCall(r.agentSession(bot.id), child), true);
  r.tasks.interrupt(admin, child);
  r = f.reopen(); admin = r.administrator();
  const retried = r.tasks.claim(admin)!;
  assert.equal(r.tasks.reserveModelCall(r.agentSession(bot.id), retried), false);
  assert.equal(r.tasks.reserveModelCall(r.agentSession(bot.id), retried), false);
  assert.equal(r.schedules.list(admin)[0]!.model_calls, 2);
  assert.equal(r.updates(admin).length, 1);
  assert.throws(() => r.schedules.setEnabled(admin, f.input.id, true), /model call limit/);
  r.tasks.cancel(admin, retried.task.id);
  const resumedParent = r.tasks.claim(admin)!;
  assert.equal(r.tasks.reserveModelCall(r.agentSession(f.leader.id), resumedParent), false);
  assert.equal(r.updates(admin).length, 1);
});

test('existing schedules migrate with a finite budget and retain creation replay compatibility', t => {
  const f = fixture(t); f.runtime.schedules.create(f.admin, f.input);
  const db = new DatabaseSync(join(f.root, 'control.db'));
  db.exec('DROP TABLE agent_autonomy; DROP TABLE response_progress; DROP TABLE provider_failures; DROP TABLE task_observations; DROP TABLE task_waits; DROP TABLE task_message_links; DROP TABLE task_context; DROP TABLE task_child_dependencies; DROP TABLE task_memory_skips; DROP TABLE task_activity; DROP TABLE prompt_runs; DROP TABLE task_prompt_versions; DROP TABLE artifact_evidence; DROP TABLE artifact_manifest; DROP TABLE artifact_quality; DROP TABLE task_quality; DROP TABLE quality_settings; ALTER TABLE artifact_reviews DROP COLUMN review_model; ALTER TABLE artifact_reviews DROP COLUMN checks; ALTER TABLE artifact_reviews DROP COLUMN evidence_revision; DROP TABLE initiative_evidence; DROP TABLE initiative_tasks; DROP TABLE initiatives; DROP TABLE initiative_settings; DROP TABLE execution_bindings; DROP TRIGGER retire_workarea_file; DROP TABLE retired_workarea_files; DROP TABLE task_workareas; DROP TABLE artifact_files; DROP TABLE artifact_audiences; DROP TABLE workarea_members; DROP TABLE workareas; DROP TABLE workarea_settings; DROP TABLE autonomous_boundaries; DROP TABLE autonomous_wakes; ALTER TABLE tasks DROP COLUMN internal_autonomous; DROP TABLE work_notes; DROP TABLE task_handoffs; DROP TABLE external_operation_labels; DROP TABLE artifact_references; DROP TABLE artifact_reviews; DROP TABLE artifact_versions; DROP TABLE task_coordination; DROP TABLE message_acknowledgments; ALTER TABLE tasks DROP COLUMN source_message_id; DROP TABLE restored_tasks; DROP TABLE member_requests; ALTER TABLE messages DROP COLUMN reply_to; DROP TABLE approval_requests; DROP TABLE business_tasks; DROP TABLE deleted_content; DROP TABLE deleted_agents; ALTER TABLE tasks DROP COLUMN conversation_reply; DROP TABLE generated_model; ALTER TABLE settings DROP COLUMN backup_time; ALTER TABLE settings DROP COLUMN autonomous;');
  db.exec('DROP TABLE common_rules; DROP INDEX tasks_provider_retry; ALTER TABLE tasks DROP COLUMN provider_retry_at; DROP TABLE model_routes; DROP TABLE provider_limits; ALTER TABLE schedules DROP COLUMN max_model_calls; ALTER TABLE schedules DROP COLUMN model_calls; ALTER TABLE schedules DROP COLUMN trigger_kind; ALTER TABLE schedules DROP COLUMN source_revision; ALTER TABLE schedules DROP COLUMN deleted; ALTER TABLE schedules DROP COLUMN autonomous; PRAGMA user_version=14;');
  db.close();
  const r = f.reopen(); const admin = r.administrator();
  const schedule = r.schedules.create(admin, f.input);
  assert.equal(schedule.max_model_calls, f.input.max_runs * 24); assert.equal(schedule.model_calls, 0);
  assert.equal(schedule.autonomous, 0);
});

test('shared changes trigger once across restart, ignore private rooms and self replies, and detect source corrections', t => {
  const f = fixture(t); let r = f.runtime; let admin = f.admin;
  const actor = r.agentSession(f.leader.id);
  const privateRoom = r.createRoom(admin, '個別の相談', [f.leader.id]);
  assert.throws(() => r.schedules.create(admin, { ...f.input, room_id: privateRoom.id, trigger_kind: 'shared_changes' }), /shared room/);
  assert.throws(() => r.schedules.create(admin, { ...f.input, room_id: privateRoom.id, autonomous: true }), /shared room/);
  r.post(admin, f.room.id, '登録より前の発言');
  r.schedules.create(admin, { ...f.input, trigger_kind: 'shared_changes' });
  r.schedules.dispatch(admin, f.input.next_at);
  r.post(actor, f.room.id, '自分の返答'); r.post(admin, privateRoom.id, '私的な発言');
  r.schedules.dispatch(admin, f.input.next_at + 60_000);
  assert.equal(r.tasks.list(admin).length, 0); assert.equal(r.schedules.list(admin)[0]!.model_calls, 0);
  const source = r.post(admin, f.room.id, '共有会話の変更');
  r.updateSettings(admin, { paused: true }); r.schedules.dispatch(admin, f.input.next_at + 120_000);
  assert.equal(r.tasks.list(admin).length, 0);
  r = f.reopen(); admin = r.administrator(); r.updateSettings(admin, { paused: false });
  r.schedules.dispatch(admin, f.input.next_at + 120_000);
  r.schedules.dispatch(admin, f.input.next_at + 120_000);
  assert.equal(r.tasks.list(admin).length, 1);
  r.tasks.cancel(admin, r.tasks.list(admin)[0]!.id);
  const db = new DatabaseSync(join(f.root, 'control.db'));
  try {
    db.prepare('UPDATE messages SET body=? WHERE id=?').run('訂正された発言', source.id);
    r.schedules.dispatch(admin, f.input.next_at + 180_000);
    assert.equal(r.tasks.list(admin).length, 2);
    r.tasks.cancel(admin, r.tasks.list(admin)[1]!.id);
    db.prepare('DELETE FROM messages WHERE id=?').run(source.id);
    r.schedules.dispatch(admin, f.input.next_at + 240_000);
    assert.equal(r.tasks.list(admin).length, 3);
  } finally { db.close(); }
});

test('change checkpoint and task creation roll back together', t => {
  const f = fixture(t); const r = f.runtime;
  r.schedules.create(f.admin, { ...f.input, trigger_kind: 'shared_changes' });
  const before = r.schedules.list(f.admin)[0]!.source_revision;
  r.post(f.admin, f.room.id, '新しい話題');
  const db = new DatabaseSync(join(f.root, 'control.db'));
  try {
    db.exec("CREATE TRIGGER reject_changed_run BEFORE INSERT ON schedule_runs BEGIN SELECT RAISE(ABORT,'changed run failure'); END;");
    assert.throws(() => r.schedules.dispatch(f.admin, f.input.next_at), /changed run failure/);
    assert.equal(r.schedules.list(f.admin)[0]!.source_revision, before);
    assert.equal(r.tasks.list(f.admin).length, 0);
    db.exec('DROP TRIGGER reject_changed_run;');
    r.schedules.dispatch(f.admin, f.input.next_at);
    assert.notEqual(r.schedules.list(f.admin)[0]!.source_revision, before);
    assert.equal(r.tasks.list(f.admin).length, 1);
  } finally { db.close(); }
});

test('deleting a schedule persists, rejects resurrection and keeps existing jobs and their budget', t => {
  const f = fixture(t); let r = f.runtime; let admin = f.admin;
  const input = { ...f.input, max_model_calls: 1 };
  r.schedules.create(admin, input); r.schedules.dispatch(admin, input.next_at);
  const lease = r.tasks.claim(admin)!; const actor = r.agentSession(f.leader.id);
  const message = r.post(admin, f.room.id, '保存する会話');
  assert.throws(() => r.schedules.remove(actor, input.id), /Administrator/);
  r.schedules.remove(admin, input.id); r.schedules.remove(admin, input.id);
  assert.equal(r.tasks.active(actor, lease), true);
  assert.equal(r.tasks.reserveModelCall(actor, lease), true);
  assert.equal(r.tasks.reserveModelCall(actor, lease), false);
  r.tasks.finish(actor, lease, '仕事の履歴は残る');
  assert.equal(r.schedules.list(admin).length, 0);
  assert.throws(() => r.schedules.create(admin, input), /deleted/);
  assert.throws(() => r.schedules.setEnabled(admin, input.id, true), /not found/);
  r = f.reopen(); admin = r.administrator(); r.schedules.dispatch(admin, input.next_at + 60_000);
  assert.equal(r.schedules.list(admin).length, 0); assert.equal(r.tasks.list(admin).length, 1);
  assert.equal(r.tasks.get(admin, lease.task.id).result, '仕事の履歴は残る');
  assert.equal(r.messages(admin, f.room.id).some(item => item.id === message.id), true);
  assert.equal(r.updates(admin).some(item => item.task_id === lease.task.id), true);
});

test('editing schedules preserves usage, running jobs, identity and stopped state; stale edits conflict', t => {
  const f = fixture(t); const r = f.runtime;
  const original = r.schedules.create(f.admin, f.input);
  r.schedules.dispatch(f.admin, f.input.next_at);
  const task = r.tasks.list(f.admin)[0]!;
  const lease = r.tasks.claim(f.admin)!;
  const actor = r.agentSession(f.leader.id);
  r.tasks.reserveModelCall(actor, lease);
  r.schedules.setEnabled(f.admin, f.input.id, false);
  const current = r.schedules.list(f.admin)[0]!;
  const changed = { ...f.input, prompt: 'Edited request', next_at: current.next_at, max_model_calls: 50 };
  assert.throws(() => r.schedules.update(f.admin, changed, original.version), /changed/);
  const saved = r.schedules.update(f.admin, changed, current.version);
  assert.equal(saved.prompt, changed.prompt); assert.equal(saved.run_count, 1); assert.equal(saved.model_calls, 1); assert.equal(saved.enabled, 0);
  assert.equal(r.tasks.get(f.admin, task.id).prompt, f.input.prompt);
  assert.equal(r.schedules.create(f.admin, f.input).prompt, changed.prompt);
  assert.throws(() => r.schedules.update(actor, changed, saved.version), /Administrator/);
  assert.throws(() => r.schedules.update(f.admin, { ...changed, interval_ms: 1 }, saved.version), /bounds/);
  r.tasks.cancel(f.admin, task.id); r.schedules.setEnabled(f.admin, f.input.id, true);
  r.schedules.dispatch(f.admin, saved.next_at);
  assert.equal(r.tasks.list(f.admin).at(-1)!.prompt, changed.prompt);
  const reopened = f.reopen();
  assert.equal(reopened.schedules.list(reopened.administrator())[0]!.run_count, 2);
});

test('editing a dormant schedule keeps its recipient and does not erase concurrent model usage', t => {
  const f = fixture(t); const r = f.runtime;
  const child = r.createAgent(r.agentSession(f.leader.id), 'Scheduled member');
  const input = { ...f.input, agent_id: child.id, max_model_calls: 5 };
  r.schedules.create(f.admin, input); r.schedules.dispatch(f.admin, input.next_at);
  const lease = r.tasks.claim(f.admin)!; const actor = r.agentSession(child.id);
  const before = r.schedules.list(f.admin)[0]!;
  r.tasks.reserveModelCall(actor, lease); r.tasks.reserveModelCall(actor, lease);
  assert.throws(() => r.schedules.update(f.admin, { ...input, next_at: before.next_at, max_model_calls: 1 }, before.version), /lower than usage/);
  r.setDormant(f.admin, child.id, true); r.organizeRoom(f.admin, f.room.id, { archived: true });
  const edited = r.schedules.update(f.admin, { ...input, prompt: 'Changed while dormant', next_at: before.next_at }, before.version);
  assert.equal(edited.agent_id, child.id); assert.equal(edited.model_calls, 2); assert.equal(edited.run_count, 1);
});
