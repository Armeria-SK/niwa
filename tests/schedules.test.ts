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
