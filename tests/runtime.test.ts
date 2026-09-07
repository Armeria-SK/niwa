import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runtime } from '../src/runtime/runtime.ts';
import { DomainError } from '../src/domain/types.ts';

function fixture(t: { after: (fn: () => void) => void }) {
  const path = mkdtempSync(join(tmpdir(), 'niwa-test-'));
  const runtime = new Runtime(path);
  t.after(() => { runtime.close(); rmSync(path, { recursive: true, force: true }); });
  const admin = runtime.administrator();
  const leader = runtime.bootstrap(admin);
  const leaderActor = runtime.agentSession(leader.id);
  const child = runtime.createAgent(leaderActor, 'テストBot');
  const childActor = runtime.agentSession(child.id);
  return { path, runtime, admin, leader, leaderActor, child, childActor };
}
const denied = (fn: () => unknown) => assert.throws(fn,
  (e: unknown) => e instanceof DomainError && e.code === 'forbidden');

test('only issued identities work; members and administrators cannot generate bots', t => {
  const f = fixture(t);
  denied(() => f.runtime.createAgent(f.childActor, 'no'));
  denied(() => f.runtime.createAgent(f.admin, 'no'));
  denied(() => f.runtime.createAgent({} as never, 'no'));
  const other = new Runtime(join(f.path, 'other'));
  try { denied(() => other.settings(f.admin)); } finally { other.close(); }
  assert.equal(f.runtime.bootstrap(f.admin).id, f.leader.id);
  assert.equal(f.leader.model, 'gpt-6-astra');
  assert.equal(f.child.reasoning, 'max');
});

test('private rooms and message sources cannot cross bot boundaries', t => {
  const f = fixture(t);
  const room = f.runtime.createRoom(f.admin, '個別', [f.child.id]);
  const msg = f.runtime.post(f.admin, room.id, '人工の秘密です');
  denied(() => f.runtime.messages(f.leaderActor, room.id));
  denied(() => f.runtime.post(f.leaderActor, room.id, '侵入'));
  denied(() => f.runtime.remember(f.leaderActor, msg.id, '盗んだ記憶'));
  assert.equal(f.runtime.rooms(f.leaderActor).some(r => r.id === room.id), false);
  assert.equal(f.runtime.messages(f.childActor, room.id)[0]?.body, '人工の秘密です');
  assert.equal(f.runtime.messages(f.admin, room.id).length, 1);
  const pair = f.runtime.createRoom(f.childActor, 'Bot同士', [f.child.id, f.leader.id]);
  assert.equal(f.runtime.messages(f.admin, pair.id).length, 0);
  denied(() => f.runtime.createRoom(f.childActor, '本人不参加', [f.leader.id]));
});

test('individual memory DBs; private-derived memory never enters shared context', t => {
  const f = fixture(t);
  const shared = f.runtime.createRoom(f.admin, '庭');
  const privateRoom = f.runtime.createRoom(f.admin, '個別', [f.child.id]);
  const publicMsg = f.runtime.post(f.leaderActor, shared.id, '人工の公開観察');
  const privateMsg = f.runtime.post(f.admin, privateRoom.id, '人工の秘密観察');
  f.runtime.remember(f.childActor, publicMsg.id, '公開観察を記憶');
  f.runtime.remember(f.childActor, privateMsg.id, '秘密観察を記憶');
  f.runtime.remember(f.leaderActor, publicMsg.id, 'リーダーだけの解釈');
  denied(() => f.runtime.memories(f.leaderActor, f.child.id));
  denied(() => f.runtime.memories(f.admin, '../outside'));
  assert.equal(f.runtime.memories(f.childActor, f.child.id).length, 2);
  assert.equal(f.runtime.context(f.childActor, shared.id).memories.length, 1);
  assert.equal(f.runtime.context(f.childActor, privateRoom.id).memories.length, 2);
  assert.equal(f.runtime.memories(f.admin, f.child.id, '秘密').length, 1);
  assert.equal(f.runtime.memories(f.admin, f.child.id, 'リーダーだけ').length, 0);
  assert.equal(existsSync(join(f.path, 'agents', f.child.id, 'memory.db')), true);
  assert.equal(existsSync(join(f.path, 'agents', f.leader.id, 'memory.db')), true);
});

test('correction/deletion changes search, revisions and context without retaining body in audit', t => {
  const f = fixture(t);
  const room = f.runtime.createRoom(f.admin, '共有');
  const msg = f.runtime.post(f.admin, room.id, '人工の出所');
  const memory = f.runtime.remember(f.childActor, msg.id, '古い観察データ');
  const before = f.runtime.context(f.childActor, room.id);
  denied(() => f.runtime.correctMemory(f.childActor, f.child.id, memory.id, 1, '改変'));
  f.runtime.correctMemory(f.admin, f.child.id, memory.id, 1, '訂正された情報');
  assert.equal(f.runtime.isContextCurrent(f.childActor, before.revision), false);
  assert.equal(f.runtime.memories(f.admin, f.child.id, '古い観察').length, 0);
  assert.equal(f.runtime.memories(f.admin, f.child.id, '訂正された').length, 1);
  assert.throws(() => f.runtime.correctMemory(f.admin, f.child.id, memory.id, 1, '競合'), /revision/i);
  f.runtime.deleteMemory(f.admin, f.child.id, memory.id, 2);
  assert.deepEqual(f.runtime.memories(f.admin, f.child.id), []);
  assert.deepEqual(f.runtime.context(f.childActor, room.id).memories, []);
  const audit = JSON.stringify(f.runtime.memoryAudit(f.admin, f.child.id));
  assert.match(audit, /admin_corrected/);
  assert.match(audit, /deleted/);
  assert.doesNotMatch(audit, /古い観察|訂正された/);
});

test('dormant bots count towards limit; stale sessions cannot act until recalled', t => {
  const f = fixture(t);
  const room = f.runtime.createRoom(f.admin, '庭');
  const msg = f.runtime.post(f.childActor, room.id, '記憶の出所');
  f.runtime.remember(f.childActor, msg.id, '再招集まで保持');
  f.runtime.updateSettings(f.admin, { generatedLimit: 1 });
  f.runtime.setDormant(f.leaderActor, f.child.id, true);
  denied(() => f.runtime.post(f.childActor, room.id, '休眠中'));
  assert.throws(() => f.runtime.createAgent(f.leaderActor, '超過'), /limit/);
  f.runtime.setDormant(f.leaderActor, f.child.id, false);
  assert.equal(f.runtime.memories(f.childActor, f.child.id)[0]?.body, '再招集まで保持');
});

test('restart preserves messages, memory, settings and manual pause', t => {
  const f = fixture(t);
  const room = f.runtime.createRoom(f.admin, '庭');
  const msg = f.runtime.post(f.childActor, room.id, '保存');
  f.runtime.remember(f.childActor, msg.id, '再起動後も保持');
  f.runtime.updateSettings(f.admin, { paused: true });
  denied(() => f.runtime.createAgent(f.leaderActor, '停止中'));
  denied(() => f.runtime.post(f.childActor, room.id, '停止中'));
  f.runtime.close();
  const next = new Runtime(f.path);
  try {
    const admin = next.administrator();
    assert.equal(next.settings(admin).paused, true);
    assert.equal(next.settings(admin).concurrencyLimit, null);
    assert.equal(next.bootstrap(admin).id, f.leader.id);
    assert.equal(next.messages(admin, room.id).length, 1);
    assert.equal(next.memories(admin, f.child.id)[0]?.body, '再起動後も保持');
    denied(() => next.settings(f.admin));
  } finally { next.close(); }
});

test('untrusted settings and invalid participants leave state unchanged', t => {
  const f = fixture(t);
  denied(() => f.runtime.updateSettings(f.leaderActor, { generatedLimit: 100 }));
  assert.throws(() => f.runtime.updateSettings(f.admin, { paused: 'false' } as never));
  assert.throws(() => f.runtime.updateSettings(f.admin, { concurrencyLimit: 0 }));
  const count = f.runtime.rooms(f.admin).length;
  assert.throws(() => f.runtime.createRoom(f.admin, 'bad', ['../outside']));
  assert.equal(f.runtime.rooms(f.admin).length, count);
  assert.equal(f.runtime.settings(f.admin).generatedLimit, 10);
});

test('default population is ten generated bots plus one leader', t => {
  const f = fixture(t);
  for (let n = 1; n < 10; n++) f.runtime.createAgent(f.leaderActor, `人工Bot ${n}`);
  assert.equal(f.runtime.agents(f.admin).length, 11);
  assert.throws(() => f.runtime.createAgent(f.leaderActor, '上限超過'), /limit/);
  assert.equal(f.runtime.agents(f.admin).length, 11);
});

test('memory correction history exposes only scoped metadata and retains the latest 100 corrections', t => {
  const f = fixture(t); const room = f.runtime.createRoom(f.admin, '人工個別', [f.child.id]);
  const source = f.runtime.post(f.admin, room.id, '人工の出所');
  const memory = f.runtime.remember(f.childActor, source.id, '古い本文');
  assert.deepEqual(f.runtime.memoryCorrections(f.admin, f.child.id, memory.id), []);
  for (let revision = 1; revision <= 101; revision++) f.runtime.correctMemory(f.admin, f.child.id, memory.id, revision, '訂正本文' + revision);
  const result = f.runtime.memoryCorrections(f.admin, f.child.id, memory.id) as { revision: number; actor_id: string; created_at: string }[];
  assert.equal(result.length, 100); assert.equal(result[0]?.revision, 3); assert.equal(result.at(-1)?.revision, 102);
  assert.ok(result.every(item => item.actor_id === 'administrator' && Number.isFinite(Date.parse(item.created_at))));
  assert.doesNotMatch(JSON.stringify(result), /古い本文|訂正本文|人工の出所/);
  denied(() => f.runtime.memoryCorrections(f.childActor, f.child.id, memory.id));
  denied(() => f.runtime.memoryCorrections(f.leaderActor, f.child.id, memory.id));
  assert.throws(() => f.runtime.memoryCorrections(f.admin, f.leader.id, memory.id), /Memory not found/);
  const reopened = new Runtime(f.path);
  try { assert.deepEqual(reopened.memoryCorrections(reopened.administrator(), f.child.id, memory.id), result); } finally { reopened.close(); }
  f.runtime.deleteMemory(f.admin, f.child.id, memory.id, 102);
  assert.throws(() => f.runtime.memoryCorrections(f.admin, f.child.id, memory.id), /Memory not found/);
});

test('memory pages cover all records with stable cursors, literal search and private access', t => {
  const f = fixture(t); const room = f.runtime.createRoom(f.admin, '人工個別', [f.child.id]);
  const source = f.runtime.post(f.admin, room.id, '人工出所'); const ids: string[] = [];
  for (let i = 0; i < 123; i++) ids.push(f.runtime.remember(f.childActor, source.id, i === 5 ? 'Literal %_ Marker' : '人工の記憶' + i).id);
  const initialVersion = f.runtime.memoryVersion(f.admin, f.child.id);
  const first = f.runtime.memoryPage(f.admin, f.child.id);
  assert.equal(first.items.length, 50); assert.equal(first.total, 123); assert.ok(first.next);
  assert.deepEqual(first.items.map(item => item.id), ids.toReversed().slice(0, 50));
  const second = f.runtime.memoryPage(f.childActor, f.child.id, '', first.next!);
  const last = f.runtime.memoryPage(f.admin, f.child.id, '', second.next!);
  assert.equal(last.items.length, 23); assert.equal(last.next, null);
  assert.deepEqual([...first.items, ...second.items, ...last.items].map(item => item.id), ids.toReversed());
  assert.deepEqual(f.runtime.memoryPage(f.admin, f.child.id, '%_').items.map(item => item.id), [ids[5]]);
  assert.equal(f.runtime.memoryPage(f.admin, f.child.id, 'marker').total, 1);
  denied(() => f.runtime.memoryPage(f.leaderActor, f.child.id));
  denied(() => f.runtime.memoryVersion(f.leaderActor, f.child.id));
  assert.equal(f.runtime.memoryPage(f.admin, f.leader.id).total, 0);
  for (const cursor of [0, -1, NaN, Infinity, 1.5]) assert.throws(() => f.runtime.memoryPage(f.admin, f.child.id, '', cursor), /Invalid/);
  assert.throws(() => f.runtime.memoryPage(f.admin, f.child.id, 'x'.repeat(201)), /Invalid/);
  f.runtime.deleteMemory(f.admin, f.child.id, first.items.at(-1)!.id, 1);
  assert.ok(f.runtime.memoryVersion(f.admin, f.child.id) > initialVersion);
  f.runtime.remember(f.childActor, source.id, 'ページ取得後に追加');
  assert.deepEqual(f.runtime.memoryPage(f.admin, f.child.id, '', first.next!).items.map(item => item.id), second.items.map(item => item.id));
  const beforeCorrection = f.runtime.memoryVersion(f.admin, f.child.id);
  f.runtime.correctMemory(f.admin, f.child.id, ids[5]!, 1, '訂正済み');
  assert.ok(f.runtime.memoryVersion(f.admin, f.child.id) > beforeCorrection);
  assert.equal(f.runtime.memoryPage(f.admin, f.child.id, '%_').total, 0);
  const reopened = new Runtime(f.path);
  try { assert.deepEqual(reopened.memoryPage(reopened.administrator(), f.child.id), f.runtime.memoryPage(f.admin, f.child.id)); } finally { reopened.close(); }
});

test('conversation pages retain the first message and cover replies without leaking private rooms', t => {
  const f = fixture(t); const room = f.runtime.createRoom(f.admin, '個別ページ', [f.child.id]); const shared = f.runtime.createRoom(f.admin, '共有ページ');
  const root = f.runtime.post(f.admin, room.id, '最初の発言'); const replies: string[] = [];
  for (let i = 0; i < 123; i++) { replies.push(f.runtime.post(f.admin, room.id, i === 0 ? '古い Marker %_ 検索対象' : '返信' + i).id); if (i % 3 === 0) f.runtime.post(f.admin, shared.id, '別の会話'); }
  const summary = f.runtime.messageSummary(f.admin, room.id); assert.equal(summary.message_count, 124); assert.equal(summary.first_at, root.created_at);
  const first = f.runtime.messagePage(f.childActor, room.id); assert.equal(first.first?.id, root.id); assert.equal(first.items.length, 50); assert.ok(first.next);
  const second = f.runtime.messagePage(f.admin, room.id, first.next!); const last = f.runtime.messagePage(f.admin, room.id, second.next!);
  assert.equal(last.items.length, 23); assert.equal(last.next, null); assert.deepEqual([...last.items, ...second.items, ...first.items].map(item => item.id), replies);
  denied(() => f.runtime.messagePage(f.leaderActor, room.id)); denied(() => f.runtime.messageSummary(f.leaderActor, room.id));
  assert.deepEqual(f.runtime.searchRoomMessages(f.leaderActor, 'Marker'), []);
  assert.deepEqual(f.runtime.searchRoomMessages(f.childActor, 'marker'), [room.id]); assert.deepEqual(f.runtime.searchRoomMessages(f.admin, '%_'), [room.id]);
  assert.deepEqual(new Set(f.runtime.searchRoomMessages(f.admin, '')), new Set([room.id, shared.id]));
  f.runtime.post(f.admin, room.id, 'ページ取得後に追加'); assert.ok(f.runtime.messageSummary(f.admin, room.id).last_sequence > summary.last_sequence);
  assert.deepEqual(f.runtime.messagePage(f.admin, room.id, first.next!).items, second.items);
  const empty = f.runtime.createRoom(f.admin, '空の会話'); assert.deepEqual(f.runtime.messagePage(f.admin, empty.id), { first: null, items: [], next: null });
  assert.deepEqual({ ...f.runtime.messageSummary(f.admin, empty.id) }, { message_count: 0, last_sequence: 0, first_at: null, last_at: null });
  for (const cursor of [0, -1, NaN, Infinity, 1.5]) assert.throws(() => f.runtime.messagePage(f.admin, room.id, cursor), /Invalid/);
  assert.throws(() => f.runtime.searchRoomMessages(f.admin, 'x'.repeat(201)), /Invalid/);
  const reopened = new Runtime(f.path);
  try { assert.deepEqual(reopened.messagePage(reopened.administrator(), room.id), f.runtime.messagePage(f.admin, room.id)); } finally { reopened.close(); }
});
