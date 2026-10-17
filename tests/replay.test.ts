import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as wait } from 'node:timers/promises';
import { Runtime } from '../src/runtime/runtime.ts';

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'niwa-replay-'));
  const runtime = new Runtime(root);
  t.after(() => { runtime.close(); rmSync(root, { recursive: true, force: true }); });
  const admin = runtime.administrator(), leader = runtime.bootstrap(admin), bot = runtime.agentSession(leader.id);
  return { runtime, admin, leader, bot, room: runtime.createRoom(admin, '調べもの') };
}
/** A task that reads a page, sends a form, leaves a note, gets an instruction and answers, with a little time between each record. */
async function history(f: ReturnType<typeof fixture>) {
  const { runtime, admin, leader, bot, room } = f;
  const task = runtime.tasks.create(admin, leader.id, room.id, '会場を調べて問い合わせる\n細かい条件');
  const lease = runtime.tasks.claim(admin)!; await wait(5);
  const run = runtime.tasks.recordPrompt(bot, lease, { version: 'legacy-v4', phase: 'work', rules_revision: 1, memory_revision: 0, input_bytes: 900, estimated_input_tokens: 1300, removed_messages: 0 });
  runtime.tasks.finishPrompt(bot, lease, run, [{ type: 'usage', input_tokens: 1200, output_tokens: 60, total_tokens: 1260 }, { type: 'completed', finish_reason: 'tool_calls' }]);
  const step = runtime.tasks.saveStep(bot, lease, runtime.context(bot, room.id).revision, [{ type: 'tool_call', tool_call_id: 'c1', name: 'web_read', arguments: { url: 'https://example.test/hall', token: 'sk-ant-api03-secretsecretsecretsecret' } }, { type: 'completed', finish_reason: 'tool_calls' }]);
  await wait(5);
  runtime.tasks.observe(bot, lease, `${step}:0`, 'web_read', { url: 'https://example.test/hall' }, { url: 'https://example.test/hall', text: '会場は10時から使えます' });
  const toolAt = Date.now(), early = runtime.replays.timeline(admin, task.id); await wait(5);
  await runtime.tasks.externalOnce(bot, lease, 'send-1', { name: 'browser_form_submit', arguments: { form: 'contact' } }, async () => ({ ok: true }));
  await wait(5);
  runtime.addWorkNote(bot, lease, '会場の空きを確認しました');
  await wait(5);
  runtime.tasks.instruct(admin, task.id, '午前中に限って');
  await wait(5);
  runtime.respond(bot, runtime.tasks.claim(admin) ?? lease, '会場は10時から使えます。問い合わせを送りました。');
  return { task, toolAt, early };
}

test('the replay puts states, model calls, tools, outside actions, notes, instructions and messages in time order, with secrets hidden', async t => {
  const f = fixture(t), { task, early } = await history(f);
  const replay = f.runtime.replays.timeline(f.admin, task.id);
  assert.equal(replay.task.name, f.leader.name); assert.equal(replay.task.room_title, '調べもの');
  const types = replay.items.map(item => item.type);
  for (const type of ['event', 'model', 'tool', 'outside', 'note', 'instruction', 'message']) assert.ok(types.includes(type as never), type);
  assert.deepEqual(types.indexOf('model') < types.indexOf('tool') && types.indexOf('tool') < types.indexOf('outside') && types.indexOf('outside') < types.indexOf('note') && types.indexOf('note') < types.indexOf('instruction'), true);
  assert.deepEqual(replay.items.map(item => item.at), [...replay.items.map(item => item.at)].sort((a, b) => a - b));
  // The arguments come from the saved step; a later instruction clears saved steps, and then only the name and result remain.
  const first = early.items.find(item => item.type === 'tool')!, tool = replay.items.find(item => item.type === 'tool')!;
  assert.ok(first.type === 'tool' && first.args.includes('example.test/hall') && !first.args.includes('secretsecret') && first.args.includes('[REDACTED]'));
  assert.ok(tool.type === 'tool' && tool.name === 'web_read' && !tool.args.includes('secretsecret') && tool.result.includes('10時から'));
  const outside = replay.items.find(item => item.type === 'outside')!;
  assert.ok(outside.type === 'outside' && outside.outcome === 'recorded');
  assert.throws(() => f.runtime.replays.timeline(f.bot, task.id), /Administrator required/);
});

test('a branch starts a new task from an edited instruction and the record up to the chosen point, leaving the original as it was', async t => {
  const f = fixture(t), { task, toolAt } = await history(f);
  const before = f.runtime.tasks.get(f.admin, task.id);
  const next = f.runtime.replays.branch(f.admin, task.id, toolAt, '会場を調べて、午後の空きも問い合わせる');
  assert.notEqual(next.id, task.id);
  assert.equal(next.agent_id, f.leader.id); assert.equal(next.room_id, f.room.id); assert.equal(next.state, 'queued');
  assert.match(next.prompt, /^会場を調べて、午後の空きも問い合わせる\n\n\[分岐元の仕事の経過・資料\]\n分岐元：会場を調べて問い合わせる（/);
  assert.match(next.prompt, /道具 web_read/);
  assert.doesNotMatch(next.prompt, /browser_form_submit|作業メモ|問い合わせを送りました/, 'records after the chosen point are left out');
  assert.match(next.prompt, /元の仕事は続けず/);
  const after = f.runtime.tasks.get(f.admin, task.id);
  assert.deepEqual({ state: after.state, prompt: after.prompt, result: after.result }, { state: before.state, prompt: before.prompt, result: before.result });
  assert.equal(f.runtime.replays.timeline(f.admin, task.id).items.length, f.runtime.replays.timeline(f.admin, task.id).items.length);
  assert.throws(() => f.runtime.replays.branch(f.admin, task.id, task.created_at - 1, 'x'), /Choose a point/);
  assert.throws(() => f.runtime.replays.branch(f.bot, task.id, toolAt, 'x'), /Administrator required/);
});
