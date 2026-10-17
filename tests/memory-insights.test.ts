import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Runtime } from '../src/runtime/runtime.ts';
import { findMemoryConflicts, normalizeMemory } from '../src/runtime/memory-conflicts.ts';

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'niwa-memory-insights-'));
  const runtime = new Runtime(root);
  t.after(() => { runtime.close(); rmSync(root, { recursive: true, force: true }); });
  const admin = runtime.administrator(), leader = runtime.bootstrap(admin), lead = runtime.agentSession(leader.id);
  const kanade = runtime.createAgent(lead, 'カナデ'), kana = runtime.agentSession(kanade.id);
  const room = runtime.createRoom(admin, '読書会'), side = runtime.createRoom(admin, '個別の相談', [kanade.id]);
  const date = runtime.post(admin, room.id, '日時は第2土曜の14時で決まりです。'), moved = runtime.post(admin, side.id, '第3土曜にずらせないか考えている。');
  const fixed = runtime.remember(kana, date.id, '読書会は第2土曜の14時から');
  const idea = runtime.remember(kana, moved.id, '読書会を第三土曜にずらす案がある（まだ決定ではない）');
  const bring = runtime.remember(kana, date.id, '読書会の持ち物は好きな本を一冊');
  const aim = runtime.remember(lead, date.id, '読書会の案内は、初めて参加する人に向けて書く');
  return { runtime, admin, leader, kanade, lead, room, fixed, idea, bring, aim };
}

test('memory text unifies width and counting kanji so the same date reads the same', () => {
  assert.equal(normalizeMemory('第二土曜の十四時'), '第2土曜の14時');
  assert.equal(normalizeMemory('一緒に'), '一緒に');
});

test('conflicts need the same topic and a different value of the same kind, and never pair unrelated memories', () => {
  const m = (id: string, body: string, agent = 'a') => ({ agent_id: agent, id, revision: 1, body });
  const found = findMemoryConflicts([m('1', '読書会は第2土曜の14時から'), m('2', '読書会を第三土曜にずらす案がある（まだ決定ではない）', 'b'),
    m('3', '読書会の持ち物は好きな本を一冊'), m('4', '表示の確認はスマートフォンの幅で行う'), m('5', '読書会は第2土曜の14時から', 'b')]);
  assert.equal(found.length, 2);
  assert.deepEqual(found.map(item => [item.a.id, item.b.id].sort().join()).sort(), ['1,2', '2,5']);
  assert.ok(found[0]!.differences.includes('第2 ⇄ 第3') || found[0]!.differences.includes('第3 ⇄ 第2'));
  assert.ok(found[0]!.differences.some(text => text.includes('まだ')));
  // Different counters (土曜 ⇄ 一冊) and identical memories are not disagreements.
  assert.deepEqual(findMemoryConflicts([m('1', '会場は駅前ホールで定員は20人'), m('2', '会場は駅前ホールで定員は20人', 'b'), m('3', '会場は駅前ホールで資料は3冊')]), []);
});

test('who knows searches every Bot, needs all words and shows where each memory came from', t => {
  const f = fixture(t);
  const found = f.runtime.whoKnows(f.admin, '読書会 土曜');
  assert.deepEqual(found.map(group => [group.name, group.total]), [['カナデ', 2]]);
  assert.equal(found[0]!.items[0]!.source?.room_title, '個別の相談');
  assert.equal(found[0]!.items[0]!.source?.private, true);
  assert.deepEqual(f.runtime.whoKnows(f.admin, '読書会').map(group => group.total), [3, 1]);
  assert.deepEqual(f.runtime.whoKnows(f.admin, '100%'), []);
  assert.throws(() => f.runtime.whoKnows(f.admin, '  '));
  assert.throws(() => f.runtime.whoKnows(f.lead, '読書会'));
});

test('a dismissed conflict stays away until either memory is corrected', t => {
  const f = fixture(t);
  const first = f.runtime.memoryConflicts(f.admin);
  assert.equal(first.length, 1);
  assert.equal(first[0]!.same_bot, true);
  assert.deepEqual(first[0]!.memories.map(memory => memory.id).sort(), [f.fixed.id, f.idea.id].sort());
  assert.equal(first[0]!.memories[0]!.agent_name, 'カナデ');
  f.runtime.dismissMemoryConflict(f.admin, first[0]!.pair);
  assert.deepEqual(f.runtime.memoryConflicts(f.admin), []);
  f.runtime.correctMemory(f.admin, f.kanade.id, f.idea.id, f.idea.revision, '読書会を第3土曜にずらす案がある（まだ決定ではない、来月決める）');
  assert.equal(f.runtime.memoryConflicts(f.admin).length, 1);
  assert.throws(() => f.runtime.dismissMemoryConflict(f.admin, 'x'));
  assert.throws(() => f.runtime.memoryConflicts(f.lead));
});
