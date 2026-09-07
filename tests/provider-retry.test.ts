import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runtime } from '../src/runtime/runtime.ts';

test('provider retries survive restart and respect time, authority, pause, dormancy, archives and cancellation', () => {
  const root = mkdtempSync(join(tmpdir(), 'niwa-provider-retry-')); let runtime = new Runtime(root);
  try {
    let admin = runtime.administrator(); const leader = runtime.createAgent(runtime.agentSession(runtime.bootstrap(admin).id), '再確認Bot'); const room = runtime.createRoom(admin, '再確認');
    let actor = runtime.agentSession(leader.id);
    const task = runtime.tasks.create(admin, leader.id, room.id, '続ける');
    const lease = runtime.tasks.claim(admin)!;
    runtime.tasks.wait(actor, lease, 'waiting_provider', '接続設定を再確認', true);
    const due = runtime.tasks.get(admin, task.id).provider_retry_at!;
    assert.ok(due >= Date.now() + 59_000);
    runtime.tasks.retryProviders(admin, due - 1); assert.equal(runtime.tasks.get(admin, task.id).state, 'waiting_provider');
    assert.throws(() => runtime.tasks.retryProviders(actor, due), /Administrator/);
    runtime.close(); runtime = new Runtime(root); admin = runtime.administrator(); actor = runtime.agentSession(leader.id);
    assert.equal(runtime.tasks.get(admin, task.id).provider_retry_at, due);
    runtime.updateSettings(admin, { paused: true }); runtime.tasks.retryProviders(admin, due);
    assert.equal(runtime.tasks.get(admin, task.id).state, 'waiting_provider');
    runtime.updateSettings(admin, { paused: false }); runtime.tasks.pause(admin, task.id); runtime.tasks.retryProviders(admin, due);
    assert.equal(runtime.tasks.get(admin, task.id).state, 'waiting_provider');
    runtime.tasks.resume(admin, task.id); runtime.setDormant(admin, leader.id, true); runtime.tasks.retryProviders(admin, due);
    assert.equal(runtime.tasks.get(admin, task.id).state, 'waiting_provider');
    runtime.setDormant(admin, leader.id, false); runtime.organizeRoom(admin, room.id, { archived: true }); runtime.tasks.retryProviders(admin, due);
    assert.equal(runtime.tasks.get(admin, task.id).state, 'waiting_provider');
    runtime.organizeRoom(admin, room.id, { archived: false }); runtime.tasks.retryProviders(admin, due);
    assert.equal(runtime.tasks.get(admin, task.id).state, 'queued');
    assert.equal(runtime.tasks.get(admin, task.id).provider_retry_at, null);
    const count = runtime.tasks.events(admin).length; runtime.tasks.retryProviders(admin, due);
    assert.equal(runtime.tasks.events(admin).length, count);
    const second = runtime.tasks.claim(admin)!; runtime.tasks.wait(actor, second, 'waiting_provider', '上限', true);
    runtime.tasks.cancel(admin, task.id); runtime.tasks.retryProviders(admin, due + 60_000);
    assert.equal(runtime.tasks.get(admin, task.id).state, 'cancelled');
    assert.equal(runtime.tasks.get(admin, task.id).provider_retry_at, null);
  } finally { runtime.close(); rmSync(root, { recursive: true, force: true }); }
});

test('manual waits and expired work are not automatically resumed', () => {
  const root = mkdtempSync(join(tmpdir(), 'niwa-provider-manual-')); const runtime = new Runtime(root);
  try {
    const admin = runtime.administrator(); const leader = runtime.bootstrap(admin); const actor = runtime.agentSession(leader.id);
    const room = runtime.createRoom(admin, '手動確認');
    for (const state of ['waiting_provider', 'waiting_user'] as const) {
      const task = runtime.tasks.create(admin, leader.id, room.id, '手動で続ける');
      runtime.tasks.wait(actor, runtime.tasks.claim(admin)!, state, '確認が必要');
      runtime.tasks.retryProviders(admin, Date.now() + 60_000);
      assert.equal(runtime.tasks.get(admin, task.id).state, state);
    }
    const task = runtime.tasks.create(admin, leader.id, room.id, '期限まで続ける', Date.now() + 1000);
    runtime.tasks.wait(actor, runtime.tasks.claim(admin)!, 'waiting_provider', '上限', true);
    runtime.tasks.retryProviders(admin, Date.now() + 60_000);
    assert.equal(runtime.tasks.get(admin, task.id).state, 'waiting_provider');
    runtime.tasks.expire(admin, Date.now() + 60_000);
    assert.equal(runtime.tasks.get(admin, task.id).state, 'failed');
    assert.equal(runtime.tasks.get(admin, task.id).provider_retry_at, null);
  } finally { runtime.close(); rmSync(root, { recursive: true, force: true }); }
});
