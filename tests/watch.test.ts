import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Runtime } from '../src/runtime/runtime.ts';
import { todayStart } from '../src/runtime/watch.ts';

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'niwa-watch-'));
  const runtime = new Runtime(root);
  const db = new DatabaseSync(join(root, 'control.db'));
  t.after(() => { db.close(); runtime.close(); rmSync(root, { recursive: true, force: true }); });
  const admin = runtime.administrator(), leader = runtime.bootstrap(admin), bot = runtime.agentSession(leader.id);
  const room = runtime.createRoom(admin, '見張りの確認');
  return { runtime, db, admin, leader, bot, room };
}
const snapshot = (db: DatabaseSync) => createHash('sha256').update(JSON.stringify(['tasks', 'external_operations', 'tool_receipts', 'approval_requests', 'prompt_runs', 'autonomous_wakes', 'settings']
  .map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()))).digest('hex');

test('the watch lists running work, outside actions as recorded or unknown, approvals and usage, and changes nothing', async t => {
  const { runtime, db, admin, leader, bot, room } = fixture(t);
  runtime.tasks.create(admin, leader.id, room.id, '公開ページを読んでフォームを送る\n詳しい手順');
  const lease = runtime.tasks.claim(admin)!;
  await runtime.tasks.readOnce(bot, lease, 'read-1', { name: 'web_read', arguments: { url: 'https://example.test/page' } },
    async () => ({ url: 'https://example.test/page?token=abc#top', text: '本文', fetched_at: new Date().toISOString() }));
  await runtime.tasks.externalOnce(bot, lease, 'send-1', { name: 'browser_form_submit', arguments: { form: 'a' } }, async () => ({ ok: true }));
  await runtime.tasks.externalOnce(bot, lease, 'send-2', { name: 'browser_request_submit', arguments: { form: 'b' } }, async () => { throw new Error('connection lost'); });
  runtime.tasks.create(admin, leader.id, room.id, '承認が要る送信');
  const waiting = runtime.tasks.claim(admin)!;
  runtime.authorizeAction(bot, waiting, 'approval-1', '問い合わせフォームに送信', { url: 'https://example.test/form', method: 'POST' });
  const run = runtime.tasks.recordAdminPrompt(admin, { version: 'second_opinion-v1', phase: 'second_opinion', rules_revision: 1, memory_revision: 0, input_bytes: 300, estimated_input_tokens: 1100, removed_messages: 0 });
  runtime.tasks.finishAdminPrompt(admin, run, [{ type: 'usage', input_tokens: 900, output_tokens: 40, total_tokens: 940 }, { type: 'completed', finish_reason: 'stop' }]);
  const now = Date.now();
  db.prepare('INSERT INTO autonomous_wakes(agent_id,next_at,model_calls,budget_reset_at,reason) VALUES (?,?,?,?,?)').run(leader.id, now + 60_000, 5, now + 1_800_000, '準備中');

  const before = snapshot(db);
  const watch = runtime.watch.state(admin, now);
  assert.equal(snapshot(db), before, 'reading the watch changes nothing');

  assert.ok(watch.running.length >= 1);
  const first = watch.running.find(item => item.id === lease.task.id)!;
  assert.equal(first.title, '公開ページを読んでフォームを送る'); assert.equal(first.name, leader.name); assert.equal(first.room_title, '見張りの確認');
  assert.equal(typeof first.progress.label, 'string');
  const outside = watch.outside.map(item => [item.kind, item.tool, item.outcome, item.address]);
  assert.deepEqual(outside.filter(item => item[0] === 'operation').sort(), [['operation', 'browser_form_submit', 'recorded', ''], ['operation', 'browser_request_submit', 'unknown', '']]);
  assert.deepEqual(outside.filter(item => item[0] === 'fetch'), [['fetch', 'page_read', 'recorded', 'https://example.test/page']], 'a fetched page shows its address without query or fragment');
  assert.deepEqual(watch.approvals.map(item => item.title), ['問い合わせフォームに送信']);
  assert.deepEqual(watch.usage.today, { since: todayStart(now), calls: 1, input: 900, output: 40, estimated: 0 });
  assert.deepEqual(watch.usage.wakes.map(item => [item.name, item.used, item.limit]), [[leader.name, 5, 24]]);
  assert.equal(watch.usage.night.limit, null);
  // After the hourly allowance resets, the count starts again.
  assert.equal(runtime.watch.state(admin, now + 3_600_000).usage.wakes[0]!.used, 0);
});

test('today starts at midnight Japan time', () => {
  const at = (day: number, hourJst: number) => Date.UTC(2026, 9, day, hourJst - 9);
  assert.equal(todayStart(at(17, 23)), at(17, 0));
  assert.equal(todayStart(at(18, 0) + 1), at(18, 0));
  assert.equal(todayStart(at(18, 8)), at(18, 0));
});

test('only the administrator can read the watch', t => {
  const { runtime, bot } = fixture(t);
  assert.throws(() => runtime.watch.state(bot), /Administrator required/);
});
