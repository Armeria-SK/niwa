import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runtime } from '../src/runtime/runtime.ts';

test('approval binds the exact displayed operation and survives restart without authorizing a changed action', () => {
  const root = mkdtempSync(join(tmpdir(), 'niwa-action-approval-')); let runtime = new Runtime(root);
  try {
    let admin = runtime.administrator(); const leader = runtime.bootstrap(admin); let actor = runtime.agentSession(leader.id);
    const room = runtime.createRoom(admin, '承認'); const task = runtime.tasks.create(admin, leader.id, room.id, '人工フォーム');
    let lease = runtime.tasks.claim(admin)!;
    const action = { url: 'https://service.example/submit', method: 'POST', body: 'message=hello' };
    assert.equal(runtime.authorizeAction(actor, lease, '0:0', 'フォーム送信', action), false);
    const request = runtime.approvals(admin)[0]!; assert.deepEqual(JSON.parse(String(request.detail)), action);
    assert.throws(() => runtime.decideApproval(actor, task.id, true, String(request.version)), /Administrator/);
    runtime.decideApproval(admin, task.id, true, String(request.version));
    runtime.close(); runtime = new Runtime(root); admin = runtime.administrator(); actor = runtime.agentSession(leader.id);
    lease = runtime.tasks.claim(admin)!;
    assert.equal(runtime.authorizeAction(actor, lease, '0:0', 'フォーム送信', action), true);
    assert.equal(runtime.authorizeAction(actor, lease, '0:0', 'フォーム送信', { ...action, body: 'message=changed' }), false);
    const changed = runtime.approvals(admin)[0]!; assert.notEqual(changed.version, request.version);
    assert.throws(() => runtime.decideApproval(admin, task.id, true, String(request.version)), /no longer pending/);
    runtime.decideApproval(admin, task.id, true, String(changed.version)); lease = runtime.tasks.claim(admin)!;
    assert.equal(runtime.authorizeAction(actor, lease, '1:0', 'フォーム送信', { ...action, body: 'message=changed' }), false);
    runtime.decideApproval(admin, task.id, false, String(runtime.approvals(admin)[0]!.version));
    assert.equal(runtime.tasks.get(admin, task.id).state, 'cancelled');
    assert.throws(() => runtime.authorizeAction(actor, lease, '1:0', 'フォーム送信', action), /no longer active/);
  } finally { runtime.close(); rmSync(root, { recursive: true, force: true }); }
});

test('generic descriptive approval never authorizes an external action', () => {
  const root = mkdtempSync(join(tmpdir(), 'niwa-generic-approval-')); const runtime = new Runtime(root);
  try {
    const admin = runtime.administrator(); const leader = runtime.bootstrap(admin); const actor = runtime.agentSession(leader.id);
    const room = runtime.createRoom(admin, '承認'); runtime.tasks.create(admin, leader.id, room.id, '人工フォーム');
    let lease = runtime.tasks.claim(admin)!;
    runtime.requestApproval(actor, lease, '許可', '任意の送信を許可するという人工説明');
    runtime.decideApproval(admin, lease.task.id, true, String(runtime.approvals(admin)[0]!.version)); lease = runtime.tasks.claim(admin)!;
    assert.equal(runtime.authorizeAction(actor, lease, '0:0', '具体的な送信', { method: 'POST', url: 'https://service.example/' }), false);
  } finally { runtime.close(); rmSync(root, { recursive: true, force: true }); }
});
