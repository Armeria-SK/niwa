import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate, setTimeout as sleep } from 'node:timers/promises';
import { Runtime } from '../src/runtime/runtime.ts';
import { Scheduler } from '../src/runtime/scheduler.ts';
import { randomUUID } from 'node:crypto';

function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), 'niwa-scheduler-'));
  const runtime = new Runtime(root);
  t.after(() => { runtime.close(); rmSync(root, { recursive: true, force: true }); });
  const admin = runtime.administrator(); const leader = runtime.bootstrap(admin);
  const actor = runtime.agentSession(leader.id); const room = runtime.createRoom(admin, '庭');
  return { root, runtime, admin, leader, actor, room, tasks: runtime.tasks };
}

test('autonomy switch stops new occurrences and delegated work while allowing normal requests, then survives restart', async t => {
  const f = fixture(t); const child = f.runtime.createAgent(f.actor, '担当Bot');
  const input = { id: randomUUID(), agent_id: f.leader.id, room_id: f.room.id, prompt: '自発活動', autonomous: true,
    interval_ms: 60_000, next_at: Date.now() + 60_000, max_runs: 3, timeout_ms: 60_000 };
  f.runtime.schedules.create(f.admin, input);
  assert.throws(() => f.runtime.updateSettings(f.actor, { autonomous: false }), /Administrator/);
  f.runtime.updateSettings(f.admin, { autonomous: false });
  f.runtime.schedules.dispatch(f.admin, input.next_at);
  assert.equal(f.tasks.list(f.admin).length, 0); assert.equal(f.runtime.schedules.list(f.admin)[0]!.run_count, 0);
  f.runtime.updateSettings(f.admin, { autonomous: true }); f.runtime.schedules.dispatch(f.admin, input.next_at);
  const parent = f.tasks.claim(f.admin)!;
  const delegated = f.tasks.delegate(f.actor, parent, child.id, '自発活動の担当');
  let calls = 0; let release!: () => void; let signal!: AbortSignal;
  const scheduler = new Scheduler(f.runtime, { async run(lease, currentSignal) {
    calls++; signal = currentSignal!; await new Promise<void>(resolve => { release = resolve; });
    const actor = f.runtime.agentSession(lease.task.agent_id);
    if (f.tasks.active(actor, lease)) f.tasks.finish(actor, lease, '完了');
  } });
  try {
    scheduler.tick(); await setImmediate(); assert.equal(calls, 1);
    f.runtime.updateSettings(f.admin, { autonomous: false }); scheduler.tick();
    assert.equal(signal.aborted, true); assert.equal(f.tasks.get(f.admin, delegated.id).state, 'queued');
    release(); await setImmediate(); scheduler.tick(); await setImmediate(); assert.equal(calls, 1);
    const manual = f.tasks.create(f.admin, child.id, f.room.id, '通常の依頼');
    const manualLease = f.tasks.claim(f.admin)!; assert.equal(manualLease.task.id, manual.id);
    f.tasks.finish(f.runtime.agentSession(child.id), manualLease, '通常は完了');
    const reopened = new Runtime(f.root);
    try { assert.equal(reopened.settings(reopened.administrator()).autonomous, false); }
    finally { reopened.close(); }
    f.runtime.updateSettings(f.admin, { autonomous: true }); scheduler.tick(); await setImmediate();
    assert.equal(calls, 2); release(); await setImmediate();
    assert.equal(f.tasks.get(f.admin, delegated.id).state, 'completed');
    assert.equal(f.tasks.get(f.admin, parent.task.id).state, 'queued');
    assert.equal(f.runtime.schedules.list(f.admin)[0]!.run_count, 1);
  } finally { release?.(); await scheduler.stop(); }
});

test('pause aborts a request and resumption cannot overlap the old lease', async t => {
  const f = fixture(t); let calls = 0; let release!: () => void; let signal!: AbortSignal;
  const task = f.tasks.create(f.admin, f.leader.id, f.room.id, '人工の依頼');
  const scheduler = new Scheduler(f.runtime, { async run(lease, currentSignal) {
    calls++; signal = currentSignal!;
    await new Promise<void>(resolve => { release = resolve; });
    if (f.tasks.active(f.actor, lease)) f.tasks.finish(f.actor, lease, '完了');
  } });
  scheduler.tick(); await setImmediate();
  f.runtime.updateSettings(f.admin, { paused: true }); scheduler.tick();
  assert.equal(signal.aborted, true);
  f.runtime.updateSettings(f.admin, { paused: false }); scheduler.tick(); await setImmediate();
  assert.equal(calls, 1);
  release(); await setImmediate(); scheduler.tick(); await setImmediate();
  assert.equal(calls, 2);
  release(); await setImmediate();
  assert.equal(f.tasks.get(f.admin, task.id).state, 'completed');
  await scheduler.stop();
});

test('shutdown requeues current work, while runner failure becomes a visible wait', async t => {
  const f = fixture(t);
  const task = f.tasks.create(f.admin, f.leader.id, f.room.id, '人工の依頼');
  const scheduler = new Scheduler(f.runtime, { async run(_lease, signal) {
    await new Promise<void>(resolve => signal!.addEventListener('abort', () => resolve(), { once: true }));
  } });
  scheduler.tick(); await setImmediate(); await scheduler.stop();
  assert.equal(f.tasks.get(f.admin, task.id).state, 'queued');
  const next = new Scheduler(f.runtime, { async run() { throw new Error('artificial private detail'); } });
  next.tick(); await setImmediate();
  const result = f.tasks.get(f.admin, task.id);
  assert.equal(result.state, 'waiting_user');
  assert.doesNotMatch(result.wait_reason!, /private detail/);
  await next.stop();
});

test('a throwing phase is logged once and neither stops the other phases nor makes tick throw', async t => {
  const f = fixture(t); const errors = t.mock.method(console, 'error', () => {});
  let calls = 0; f.runtime.schedules.dispatch = () => { throw new Error('synthetic schedule failure'); };
  f.runtime.autonomousWakes.dispatch = () => { throw new Error('synthetic wake failure'); };
  const scheduler = new Scheduler(f.runtime, { async run(lease) { calls++; f.tasks.finish(f.runtime.agentSession(lease.task.agent_id), lease, '完了'); } });
  f.tasks.create(f.admin, f.leader.id, f.room.id, '通常の依頼');
  try {
    assert.doesNotThrow(() => scheduler.tick()); await setImmediate(); assert.equal(calls, 1);
    assert.equal(errors.mock.callCount(), 2); assert.match(String(errors.mock.calls[0]!.arguments[0]), /schedules.*synthetic schedule failure/);
    scheduler.tick(); assert.equal(errors.mock.callCount(), 2);
  } finally { await scheduler.stop(); }
});

function crowded(t: { after: (fn: () => void) => void }, limit: number) {
  const f = fixture(t); const b = f.runtime.createAgent(f.actor, 'Bot B'); const c = f.runtime.createAgent(f.actor, 'Bot C');
  f.runtime.updateSettings(f.admin, { concurrencyLimit: limit });
  const ids = [f.leader.id, b.id, c.id].map((agent, i) => f.tasks.create(f.admin, agent, f.room.id, `依頼${i}`).id);
  return { ...f, ids };
}

test('a cancelled job still unwinding keeps its concurrency slot until it settles', async t => {
  const f = crowded(t, 2); let inflight = 0, max = 0;
  const scheduler = new Scheduler(f.runtime, { async run(lease) {
    inflight++; max = Math.max(max, inflight);
    try { await sleep(lease.task.prompt === '依頼0' ? 200 : 400); } finally { inflight--; }
  } });
  scheduler.start(); await sleep(20);
  assert.equal(inflight, 2);
  f.tasks.cancel(f.admin, f.ids[0]!); scheduler.tick(); await setImmediate();
  assert.equal(inflight, 2); assert.equal(f.tasks.get(f.admin, f.ids[2]!).state, 'queued');
  await sleep(300); // 依頼0 has settled; the slot is released and 依頼2 runs
  assert.equal(f.tasks.get(f.admin, f.ids[2]!).state, 'running');
  assert.equal(max, 2);
  await scheduler.stop();
});

test('a job aborted more than two minutes ago no longer holds a concurrency slot', async t => {
  const f = crowded(t, 2); let clock = 1_000_000; const release: (() => void)[] = [];
  const scheduler = new Scheduler(f.runtime, { async run() { await new Promise<void>(resolve => release.push(resolve)); } }, () => clock);
  scheduler.tick(); await setImmediate();
  assert.equal(release.length, 2);
  f.tasks.cancel(f.admin, f.ids[0]!); scheduler.tick(); await setImmediate();
  clock += 119_000; scheduler.tick(); await setImmediate();
  assert.equal(f.tasks.get(f.admin, f.ids[2]!).state, 'queued');
  clock += 2_000; scheduler.tick(); await setImmediate();
  assert.equal(f.tasks.get(f.admin, f.ids[2]!).state, 'running');
  release.forEach(resolve => resolve()); await scheduler.stop();
});
