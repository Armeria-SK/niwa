import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Runtime } from '../src/runtime/runtime.ts';
import { DatabaseSync } from 'node:sqlite';

test('history search covers sources but never pulls other private conversations or another bots memories into context', t => {
  const root = mkdtempSync(join(tmpdir(), 'niwa-search-scope-'));
  const runtime = new Runtime(root); t.after(() => { runtime.close(); rmSync(root, { recursive: true, force: true }); });
  const admin = runtime.administrator(); const leader = runtime.bootstrap(admin); const actor = runtime.agentSession(leader.id);
  const child = runtime.createAgent(actor, '別Bot'); const childActor = runtime.agentSession(child.id);
  const shared = runtime.createRoom(admin, '共有'); const privateRoom = runtime.createRoom(admin, '個別', [leader.id]);
  const otherRoom = runtime.createRoom(admin, '別個別', [leader.id]);
  const childRoom = runtime.createRoom(admin, '子の個別', [child.id]);
  const source = runtime.post(admin, shared.id, '人工調査の共有発言');
  runtime.remember(actor, source.id, '人工調査の自分の記憶');
  runtime.remember(childActor, source.id, '人工調査の他Bot記憶');
  const secret = runtime.post(admin, privateRoom.id, '人工調査の私的発言');
  runtime.remember(actor, secret.id, '人工調査の私的記憶');
  runtime.post(admin, otherRoom.id, '人工調査の別個別発言');
  runtime.post(admin, childRoom.id, '人工調査の子個別発言');
  const task = runtime.tasks.create(admin, leader.id, shared.id, '人工調査の仕事');
  runtime.tasks.instruct(admin, task.id, '人工調査の追加指示');
  runtime.createArtifact(actor, shared.id, '人工調査.md', '資料', '説明', '人工調査の成果物');
  runtime.createArtifact(actor, privateRoom.id, '個別.md', '資料', '説明', '人工調査の私的成果物');
  const results = runtime.searchHistory(actor, shared.id, '人工調査');
  assert.deepEqual(new Set(results.map(item => item.kind)), new Set(['message', 'task', 'task_reply', 'artifact', 'memory']));
  assert.doesNotMatch(JSON.stringify(results), /私的|別個別|子個別|他Bot記憶/);
  const ownPrivate = runtime.searchHistory(actor, privateRoom.id, '人工調査');
  assert.match(JSON.stringify(ownPrivate), /私的発言/); assert.match(JSON.stringify(ownPrivate), /私的成果物/);
  assert.doesNotMatch(JSON.stringify(ownPrivate), /別個別|子個別|他Bot記憶/);
  assert.throws(() => runtime.searchHistory(actor, childRoom.id, '人工調査'), /conversation|room|access/i);
  assert.doesNotMatch(JSON.stringify(runtime.searchHistory(childActor, shared.id, '人工調査')), /自分の記憶|私的/);
});

test('history indexes survive restart, reflect memory corrections/deletions and match literal short Japanese queries', t => {
  const root = mkdtempSync(join(tmpdir(), 'niwa-search-restart-'));
  let runtime = new Runtime(root); t.after(() => { runtime.close(); rmSync(root, { recursive: true, force: true }); });
  let admin = runtime.administrator(); const leader = runtime.bootstrap(admin); let actor = runtime.agentSession(leader.id);
  const room = runtime.createRoom(admin, '共有');
  const source = runtime.post(admin, room.id, '出所だけ');
  const memory = runtime.remember(actor, source.id, '訂正前の固有語');
  assert.equal(runtime.searchHistory(actor, room.id, '訂正前').length, 1);
  runtime.correctMemory(admin, leader.id, memory.id, 1, '訂正後の固有語');
  assert.equal(runtime.searchHistory(actor, room.id, '訂正前').length, 0);
  assert.equal(runtime.searchHistory(actor, room.id, '訂正後').length, 1);
  runtime.deleteMemory(admin, leader.id, memory.id, 2);
  assert.equal(runtime.searchHistory(actor, room.id, '訂正後').length, 0);
  runtime.post(admin, room.id, '庭で100%_を調べる "literal"');
  runtime.close(); runtime = new Runtime(root); admin = runtime.administrator(); actor = runtime.agentSession(leader.id);
  assert.equal(runtime.searchHistory(actor, room.id, '庭').length, 1);
  assert.equal(runtime.searchHistory(actor, room.id, '100%_').length, 1);
  assert.equal(runtime.searchHistory(actor, room.id, '"literal"').length, 1);
  assert.equal(runtime.searchHistory(actor, room.id, '訂正後').length, 0);
});

test('upgrading an existing database indexes saved sources and subsequent task results', t => {
  const root = mkdtempSync(join(tmpdir(), 'niwa-search-upgrade-'));
  let runtime = new Runtime(root); t.after(() => { runtime.close(); rmSync(root, { recursive: true, force: true }); });
  let admin = runtime.administrator(); const leader = runtime.bootstrap(admin); const room = runtime.createRoom(admin, '共有');
  runtime.post(admin, room.id, '移行確認の保存済み発言');
  const task = runtime.tasks.create(admin, leader.id, room.id, '移行確認の仕事');
  runtime.tasks.instruct(admin, task.id, '移行確認の追加指示');
  runtime.createArtifact(runtime.agentSession(leader.id), room.id, '資料.md', '資料', '説明', '移行確認の成果物');
  runtime.close();
  const db = new DatabaseSync(join(root, 'control.db'));
  try {
    for (const table of ['messages', 'tasks', 'task_replies', 'artifacts']) {
      for (const action of ['insert', 'update', 'delete']) db.exec(`DROP TRIGGER search_${table}_${action}`);
    }
    db.exec('DROP TABLE deleted_agents; ALTER TABLE tasks DROP COLUMN conversation_reply; DROP TABLE generated_model; ALTER TABLE settings DROP COLUMN backup_time; ALTER TABLE settings DROP COLUMN autonomous; DROP TABLE common_rules; DROP INDEX tasks_provider_retry; ALTER TABLE tasks DROP COLUMN provider_retry_at; DROP TABLE model_routes; DROP TABLE provider_limits; DROP TABLE schedule_runs; DROP TABLE schedules; DROP TABLE history_search; PRAGMA user_version=12;');
  } finally { db.close(); }
  runtime = new Runtime(root); admin = runtime.administrator();
  const actor = runtime.agentSession(leader.id);
  assert.equal(runtime.searchHistory(actor, room.id, '移行確認').length, 4);
  const lease = runtime.tasks.claim(admin)!; runtime.tasks.finish(actor, lease, '新しい完了結果');
  assert.equal(runtime.searchHistory(actor, room.id, '新しい完了結果')[0]?.source_id, task.id);
});

test('source reading pages the authoritative body and rejects private scope and stale memory revisions', t => {
  const root = mkdtempSync(join(tmpdir(), 'niwa-source-read-'));
  const runtime = new Runtime(root); t.after(() => { runtime.close(); rmSync(root, { recursive: true, force: true }); });
  const admin = runtime.administrator(); const leader = runtime.bootstrap(admin); const actor = runtime.agentSession(leader.id);
  const room = runtime.createRoom(admin, '共有'); const privateRoom = runtime.createRoom(admin, '個別', [leader.id]);
  const source = runtime.post(admin, privateRoom.id, '人工の個別本文');
  assert.throws(() => runtime.readHistory(actor, room.id, 'message', source.id), /unavailable/);
  assert.equal(runtime.readHistory(actor, privateRoom.id, 'message', source.id).text, source.body);
  const memory = runtime.remember(actor, source.id, '訂正前の人工記憶');
  const original = runtime.readHistory(actor, privateRoom.id, 'memory', memory.id);
  runtime.correctMemory(admin, leader.id, memory.id, 1, '訂正後の人工記憶');
  assert.throws(() => runtime.readHistory(actor, privateRoom.id, 'memory', memory.id, 0, original.revision), /changed/);
  assert.equal(runtime.readHistory(actor, privateRoom.id, 'memory', memory.id).text, '訂正後の人工記憶');
  runtime.deleteMemory(admin, leader.id, memory.id, 2);
  assert.throws(() => runtime.readHistory(actor, privateRoom.id, 'memory', memory.id), /unavailable/);
  const content = '人工資料'.repeat(12_000);
  const id = runtime.createArtifact(actor, room.id, 'long.txt', '資料', '人工説明', content);
  let page = runtime.readHistory(actor, room.id, 'artifact', id); let collected = page.text;
  assert.equal(page.text.length, 20_000); assert.ok(page.next_offset);
  assert.throws(() => runtime.readHistory(actor, room.id, 'artifact', id, page.next_offset!), /revision/);
  while (page.next_offset !== null) {
    page = runtime.readHistory(actor, room.id, 'artifact', id, page.next_offset, page.revision); collected += page.text;
  }
  assert.equal(collected, `long.txt\n人工説明\n${content}`);
  assert.throws(() => runtime.readHistory(actor, room.id, 'constructor', id), /Unknown source/);
  assert.throws(() => runtime.readHistory(actor, room.id, 'artifact', id, collected.length + 1, page.revision), /Offset/);
});
