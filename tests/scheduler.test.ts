import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { Runtime } from '../src/runtime/runtime.ts';
import { Scheduler } from '../src/runtime/scheduler.ts';

function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), 'niwa-scheduler-'));
  const runtime = new Runtime(root);
  t.after(() => { runtime.close(); rmSync(root, { recursive: true, force: true }); });
  const admin = runtime.administrator(); const leader = runtime.bootstrap(admin);
  const actor = runtime.agentSession(leader.id); const room = runtime.createRoom(admin, '庭');
  return { runtime, admin, leader, actor, room, tasks: runtime.tasks };
}

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
