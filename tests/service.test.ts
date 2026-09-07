import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { fork } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { initializeInstallation } from '../src/config/installation.ts';
import { startService } from '../src/runtime/service.ts';
import { acquireProcessLock } from '../src/runtime/process-lock.ts';
import { openAISubscriptionAdapterCapabilities } from '../src/providers/codex/adapter.ts';

test('process lock refuses a second owner and is released after an actual process crash', async () => {
  const root = mkdtempSync(join(tmpdir(), 'niwa-lock-')); const file = join(root, 'lock.db');
  const child = fork(new URL('./fixtures/lock-child.js', import.meta.url), [file], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  try {
    assert.deepEqual(await once(child, 'message'), ['locked', undefined]);
    assert.throws(() => acquireProcessLock(file), /already/);
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    const release = acquireProcessLock(file); release(); release();
  } finally { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; } rmSync(root, { recursive: true, force: true }); }
});

test('service uses installed paths, runs queued work, prevents duplicate startup and preserves manual pause', async () => {
  const root = mkdtempSync(join(tmpdir(), 'niwa-service-'));
  initializeInstallation(root, { version: 1, origin: 'https://niwa.test', port: 3210 });
  const resolve = async () => ({ adapter_id: 'artificial', capabilities: openAISubscriptionAdapterCapabilities,
    async *run() { yield { type: 'text_delta' as const, text: '常駐処理からの回答' }; yield { type: 'completed' as const, finish_reason: 'stop' as const }; } });
  let service = await startService(root, resolve, 0);
  try {
    const admin = service.runtime.administrator(); const leader = service.runtime.agents(admin)[0]!;
    const room = service.runtime.createRoom(admin, '庭');
    const task = service.runtime.tasks.create(admin, leader.id, room.id, '回答してください');
    await assert.rejects(startService(root, resolve, 0), /already/);
    for (let i = 0; i < 100 && service.runtime.tasks.get(admin, task.id).state !== 'completed'; i++) await setTimeout(20);
    assert.equal(service.runtime.tasks.get(admin, task.id).state, 'completed');
    assert.equal(service.runtime.messages(admin, room.id)[0]?.body, '常駐処理からの回答');
    service.runtime.updateSettings(admin, { paused: true });
    const pending = service.runtime.tasks.create(admin, leader.id, room.id, '再起動後の仕事');
    const key = readFileSync(join(root, 'secrets', 'admin-key'), 'utf8');
    await service.close(); await service.close();
    service = await startService(root, resolve, 0);
    const nextAdmin = service.runtime.administrator();
    assert.equal(service.runtime.settings(nextAdmin).paused, true);
    assert.equal(service.runtime.tasks.get(nextAdmin, pending.id).state, 'queued');
    assert.equal(readFileSync(join(root, 'secrets', 'admin-key'), 'utf8'), key);
  } finally { await service.close(); rmSync(root, { recursive: true, force: true }); }
});
