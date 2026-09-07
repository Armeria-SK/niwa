import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeForm, submitPublicForm, type FormResponse } from '../src/tools/browser/form.ts';
import { FormLog } from '../src/tools/browser/form-log.ts';
import { Runtime } from '../src/runtime/runtime.ts';
import { executeAsyncTurnTool } from '../src/runtime/turn-tools.ts';
import { TurnRunner } from '../src/runtime/turns.ts';
import type { ModelAdapter } from '../src/providers/shared/adapter.ts';
import { openAISubscriptionAdapterCapabilities } from '../src/providers/codex/adapter.ts';

const form = { url: 'https://forms.example.com/send', method: 'POST' as const, fields: [{ name: 'message', value: 'hello & 日本語' }] };
const response: FormResponse = { url: form.url, status: 201, text: 'artificial response', truncated: false, untrusted: true };

test('form transport pins the public destination and preserves the exact approved fields without following redirects', async () => {
  let calls = 0;
  const result = await submitPublicForm(form, undefined, async (url, method, body, address) => {
    calls++; assert.equal(url.href, form.url); assert.equal(method, 'POST'); assert.equal(address, '8.8.8.8');
    assert.equal(body, 'message=hello+%26+%E6%97%A5%E6%9C%AC%E8%AA%9E'); return { ...response, status: 302 };
  }, async host => { assert.equal(host, 'forms.example.com'); return '8.8.8.8'; });
  assert.equal(result.status, 302); assert.equal(calls, 1);
  for (const url of ['http://forms.example.com/', 'https://localhost/', 'https://user:secret@forms.example.com/', 'https://forms.example.com:8443/']) assert.throws(() => normalizeForm({ ...form, url }));
  await assert.rejects(submitPublicForm(form, undefined, async () => { calls++; return response; }, async () => { throw Error('private DNS'); })); assert.equal(calls, 1);
  await submitPublicForm({ ...form, url: form.url + '?old=removed', method: 'GET' }, undefined, async (url, method) => {
    assert.equal(method, 'GET'); assert.equal(url.searchParams.get('old'), null); assert.equal(url.searchParams.get('message'), form.fields[0]!.value); return response;
  }, async () => '8.8.8.8');
});

test('form journal reconciles restart, rejects changed scope and never retries unknown or lost intents', async () => {
  const root = mkdtempSync(join(tmpdir(), 'niwa-form-log-')); let sends = 0;
  const input = { operation_id: 'one', agent_id: 'bot', room_id: 'room', task_id: 'task', allow_start: true, form };
  let log = new FormLog(join(root, 'forms.db'), async () => { sends++; return response; });
  try {
    assert.deepEqual(await log.execute(input), response); await log.close();
    log = new FormLog(join(root, 'forms.db'), async () => { sends++; throw Error('interrupted'); });
    assert.deepEqual(await log.execute({ ...input, allow_start: false }), response); assert.equal(sends, 1);
    assert.throws(() => log.execute({ ...input, agent_id: 'different' }), /changed/);
    assert.deepEqual(await log.execute({ ...input, operation_id: 'unknown' }), { error: 'outcome_unknown' });
    assert.deepEqual(await log.execute({ ...input, operation_id: 'unknown' }), { error: 'outcome_unknown' }); assert.equal(sends, 2);
    assert.deepEqual(await log.execute({ ...input, operation_id: 'missing', allow_start: false }), { error: 'outcome_unknown' }); assert.equal(sends, 2);
  } finally { await log.close(); rmSync(root, { recursive: true, force: true }); }
});

test('form tool waits for exact approval before any send and reuses the confirmed result', async () => {
  const root = mkdtempSync(join(tmpdir(), 'niwa-form-tool-')); const runtime = new Runtime(join(root, 'state')); let sends = 0;
  const forms = new FormLog(join(root, 'forms.db'), async () => { sends++; return response; });
  const external = { forms, browser: async () => { throw Error('Preparation is a separate read'); } };
  try {
    const admin = runtime.administrator(); const leader = runtime.bootstrap(admin); const actor = runtime.agentSession(leader.id);
    const room = runtime.createRoom(admin, 'フォーム'); runtime.tasks.create(admin, leader.id, room.id, '人工送信'); let lease = runtime.tasks.claim(admin)!;
    const call = { name: 'browser_form_submit', arguments: form, tool_call_id: 'form' };
    assert.deepEqual(await executeAsyncTurnTool(runtime, actor, lease, call, '0:0', undefined, external), { waiting_for_approval: true }); assert.equal(sends, 0);
    const pending = runtime.approvals(admin)[0]!; assert.deepEqual(JSON.parse(String(pending.detail)), form);
    runtime.decideApproval(admin, lease.task.id, true, String(pending.version)); lease = runtime.tasks.claim(admin)!;
    assert.deepEqual(await executeAsyncTurnTool(runtime, actor, lease, call, '0:0', undefined, external), response);
    assert.deepEqual(await executeAsyncTurnTool(runtime, actor, lease, call, '0:0', undefined, external), response); assert.equal(sends, 1);
    assert.deepEqual(await executeAsyncTurnTool(runtime, actor, lease, call, '1:0', undefined, external), { waiting_for_approval: true }); assert.equal(sends, 1);
  } finally { await forms.close(); runtime.close(); rmSync(root, { recursive: true, force: true }); }
});

test('saved model form request resumes after approval and runtime restart without generating or sending another request', async () => {
  const root = mkdtempSync(join(tmpdir(), 'niwa-form-turn-')); let runtime = new Runtime(join(root, 'state')); let sends = 0, calls = 0;
  const forms = new FormLog(join(root, 'forms.db'), async () => { sends++; return response; });
  const external = { forms, browser: async () => { throw Error('Unexpected read'); } };
  const adapter: ModelAdapter = { adapter_id: 'artificial', capabilities: openAISubscriptionAdapterCapabilities, async *run(request) {
    if (++calls === 1) { yield { type: 'tool_call', name: 'browser_form_submit', arguments: form, tool_call_id: 'form' }; yield { type: 'completed', finish_reason: 'tool_calls' }; }
    else { assert.match(JSON.stringify(request.messages), /artificial response/); yield { type: 'text_delta', text: '応答を確認しました。' }; yield { type: 'completed', finish_reason: 'stop' }; }
  } };
  try {
    let admin = runtime.administrator(); const leader = runtime.bootstrap(admin), room = runtime.createRoom(admin, 'フォーム');
    const task = runtime.tasks.create(admin, leader.id, room.id, '人工送信');
    await new TurnRunner(runtime, async () => adapter, external).run(runtime.tasks.claim(admin)!);
    assert.equal(runtime.tasks.get(admin, task.id).state, 'waiting_user'); assert.equal(calls, 1); assert.equal(sends, 0);
    runtime.close(); runtime = new Runtime(join(root, 'state')); admin = runtime.administrator();
    runtime.decideApproval(admin, task.id, true, String(runtime.approvals(admin)[0]!.version));
    await new TurnRunner(runtime, async () => adapter, external).run(runtime.tasks.claim(admin)!);
    assert.equal(runtime.tasks.get(admin, task.id).state, 'completed'); assert.equal(calls, 2); assert.equal(sends, 1);
  } finally { await forms.close(); runtime.close(); rmSync(root, { recursive: true, force: true }); }
});
