import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Runtime } from '../src/runtime/runtime.ts';
import { currentNight, lastNight, inNight, previewOpen } from '../src/runtime/night.ts';

// Japan time: 23:00 on 2026-10-17 is 14:00 UTC.
const at = (day: number, hourJst: number) => Date.UTC(2026, 9, day, hourJst - 9);

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'niwa-night-'));
  const runtime = new Runtime(root);
  const db = new DatabaseSync(join(root, 'control.db'));
  t.after(() => { db.close(); runtime.close(); rmSync(root, { recursive: true, force: true }); });
  const admin = runtime.administrator(), leader = runtime.bootstrap(admin);
  runtime.createRoom(admin, '共有');
  return { runtime, db, admin, leader };
}

test('night hours follow Japan time, and the night is named after the evening it begins', () => {
  assert.deepEqual(currentNight(at(17, 23)), { key: '2026-10-17', start: at(17, 22), end: at(18, 7) });
  assert.equal(currentNight(at(18, 3)).key, '2026-10-17');
  assert.equal(currentNight(at(18, 12)).key, '2026-10-18');
  assert.equal(lastNight(at(18, 12)).key, '2026-10-17');
  assert.equal(lastNight(at(18, 3)).key, '2026-10-16');
  assert.deepEqual([inNight(at(17, 23)), inNight(at(18, 6)), inNight(at(18, 7)), inNight(at(17, 21))], [true, true, false, false]);
  assert.deepEqual([previewOpen(at(17, 18)), previewOpen(at(17, 17)), previewOpen(at(18, 6))], [true, false, true]);
});

test('existing installations keep working at night; with the preview on, Bots wait for the plan and stop at its limit', t => {
  const { runtime, db, admin } = fixture(t), night = at(17, 23);
  assert.equal(runtime.nights.gate(night), null);
  runtime.nights.setPreview(admin, true);
  assert.equal(runtime.nights.gate(night), '夜の計画の下見待ち');
  assert.equal(runtime.nights.gate(at(18, 12)), null);
  runtime.autonomousWakes.dispatch(admin, night); runtime.autonomousWakes.dispatch(admin, night + 60_000);
  assert.equal(runtime.tasks.list(admin).length, 0);
  assert.ok(runtime.autonomousWakes.list(admin, undefined, night).every(row => row.reason === '夜の計画の下見待ち' && row.next_at === null));
  assert.throws(() => runtime.nights.decide(admin, at(17, 12), '2026-10-17', true));
  assert.throws(() => runtime.nights.decide(admin, night, '2026-10-16', true));
  runtime.nights.decide(admin, night, '2026-10-17', true, 1);
  runtime.autonomousWakes.dispatch(admin, night); runtime.autonomousWakes.dispatch(admin, night + 60_000);
  assert.equal(runtime.tasks.list(admin).length, 1);
  const task = runtime.tasks.list(admin)[0]!;
  db.prepare("INSERT INTO prompt_runs(task_id,version,phase,rules_revision,memory_revision,input_bytes,estimated_input_tokens,removed_messages,created_at,status,input_tokens,output_tokens) VALUES (?,'v','work',1,1,10,100,0,?,'completed',120,30)").run(task.id, night + 120_000);
  assert.equal(runtime.nights.gate(night + 180_000), '今夜の利用枠に達しました');
  runtime.nights.decide(admin, night, '2026-10-17', false);
  assert.equal(runtime.nights.gate(night), '今夜は休む日');
});

test('the morning basket lists last night\'s finished, waiting and stopped work with its usage, and three approvals in a row are counted', t => {
  const { runtime, db, admin, leader } = fixture(t);
  runtime.nights.setPreview(admin, true);
  for (const day of [14, 15, 16]) runtime.nights.decide(admin, at(day, 22), `2026-10-${day}`, true);
  const room = runtime.createRoom(admin, '夜の仕事'), actor = runtime.agentSession(leader.id);
  const done = runtime.tasks.create(admin, leader.id, room.id, '資料をまとめる'); runtime.tasks.finish(actor, runtime.tasks.claim(admin)!, 'まとめを保存した');
  const asked = runtime.tasks.create(admin, leader.id, room.id, '確認が要る'); runtime.tasks.wait(actor, runtime.tasks.claim(admin)!, 'waiting_user', '公開してよいか確認したい');
  runtime.tasks.create(admin, leader.id, room.id, '昼の依頼');
  db.prepare('UPDATE tasks SET internal_autonomous=1,created_at=? WHERE id IN (?,?)').run(at(17, 23), done.id, asked.id);
  db.prepare("INSERT INTO prompt_runs(task_id,version,phase,rules_revision,memory_revision,input_bytes,estimated_input_tokens,removed_messages,created_at,status,input_tokens,output_tokens) VALUES (?,'v','work',1,1,10,100,0,?,'completed',NULL,30)").run(done.id, at(17, 23));
  const morning = runtime.nights.state(admin, at(18, 8));
  assert.equal(morning.harvest.night.key, '2026-10-17');
  assert.deepEqual(morning.harvest.done.map(item => item.summary), ['まとめを保存した']);
  assert.deepEqual(morning.harvest.waiting.map(item => item.summary), ['公開してよいか確認したい']);
  assert.deepEqual(morning.harvest.usage, { calls: 1, input: 100, output: 30, estimated: 1 });
  assert.equal(runtime.nights.state(admin, at(17, 19)).streak, 3);
  assert.equal(morning.plan.items[0]!.name, leader.name);
  assert.ok(morning.plan.never.length >= 3);
});
