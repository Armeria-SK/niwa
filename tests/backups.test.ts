import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { gunzipSync } from 'node:zlib';
import { createHash, randomUUID } from 'node:crypto';
import { Runtime } from '../src/runtime/runtime.ts';
import { initializeInstallation, adminKey, readInstallation } from '../src/config/installation.ts';
import { Backups } from '../src/backup/backups.ts';
import { prepareRestore, restoreInstallation } from '../src/backup/restore.ts';
import { acquireProcessLock } from '../src/runtime/process-lock.ts';

test('incomplete backups remain untouched without blocking listing and later daily snapshots',async t=>{
 const root=mkdtempSync(join(tmpdir(),'niwa-backup-damage-'));
 const installation={version:1 as const,origin:'https://niwa.test',port:3210},paths=initializeInstallation(root,installation);
 const runtime=new Runtime(paths.state);runtime.bootstrap(runtime.administrator());
 let now=Date.parse('2026-09-10T04:00:00+09:00');const backups=new Backups(runtime,paths,installation,()=>now);
 t.after(async()=>{await backups.stop();runtime.close();rmSync(root,{recursive:true,force:true});});
 const good=await backups.create(),empty=randomUUID(),malformed=randomUUID(),missing=randomUUID();
 for(const id of [empty,malformed,missing])mkdirSync(join(paths.backups,id));
 const broken=JSON.stringify({...good,id:malformed,files:null});writeFileSync(join(paths.backups,malformed,'manifest.json'),broken);
 writeFileSync(join(paths.backups,missing,'manifest.json'),JSON.stringify({...good,id:missing}));
 assert.deepEqual((await backups.list()).map(x=>x.id),[good.id]);assert.match(backups.error!,/確認できない/);
 now+=86400_000;await backups.tick();assert.equal((await backups.list()).length,2);
 assert.match(backups.error!,/確認できない/);
 assert.equal(readFileSync(join(paths.backups,malformed,'manifest.json'),'utf8'),broken);
 for(const id of [empty,malformed,missing]){
  assert.ok(existsSync(join(paths.backups,id)));
  await assert.rejects(prepareRestore(join(paths.backups,id),join(root,'invalid-'+id),[]));
  assert.equal(existsSync(join(root,'invalid-'+id)),false);
 }
 const valid=await backups.list();for(const item of valid)rmSync(join(paths.backups,item.id),{recursive:true});
 now+=16*86400_000;await backups.tick();assert.equal((await backups.list()).length,1);
 for(const id of [empty,malformed,missing])assert.ok(existsSync(join(paths.backups,id)));
});

test('deleted Bots lose execution and private files and cannot return from older backups', async () => {
  const root = mkdtempSync(join(tmpdir(), 'niwa-agent-deletion-'));
  const installation = { version: 1 as const, origin: 'https://niwa.test', port: 3210 };
  const paths = initializeInstallation(root, installation); const runtime = new Runtime(paths.state); const admin = runtime.administrator();
  const leader = runtime.bootstrap(admin); const actor = runtime.agentSession(leader.id);
  runtime.updateSettings(admin, { generatedLimit: 1 });
  const child = runtime.createAgent(actor, '削除対象'); const childActor = runtime.agentSession(child.id);
  const room = runtime.createRoom(admin, '残す会話'); const source = runtime.post(admin, room.id, '人工の出所');
  runtime.remember(childActor, source.id, '消す私的記憶');
  runtime.updateProfile(admin, child.id, { persona: '消す人格' });
  const task = runtime.tasks.create(admin, child.id, room.id, '止める仕事'); const lease = runtime.tasks.claim(admin)!;
  runtime.schedules.create(admin, { id: randomUUID(), agent_id: child.id, room_id: room.id, prompt: '消す定期活動', interval_ms: 60_000, next_at: Date.now() + 60_000, max_runs: 2, timeout_ms: 60_000 });
  const backups = new Backups(runtime, paths, installation);
  try {
    const before = await backups.create();
    assert.throws(() => runtime.deleteAgent(actor, child.id), /Administrator/);
    assert.throws(() => runtime.deleteAgent(admin, leader.id), /Leader/);
    runtime.deleteAgent(admin, child.id);
    assert.equal(runtime.tasks.active(childActor, lease), false);
    assert.equal(runtime.tasks.get(admin, task.id).state, 'cancelled');
    assert.equal(runtime.schedules.list(admin).length, 0);
    assert.throws(() => runtime.tasks.retry(admin, task.id), /Agent not found/);
    assert.throws(() => runtime.agentSession(child.id), /Agent not found/);
    assert.throws(() => runtime.setDormant(admin, child.id, false), /Agent not found/);
    assert.throws(() => runtime.profile(admin, child.id), /Agent not found/);
    assert.equal(existsSync(join(paths.state, 'agents', child.id)), false);
    assert.equal(runtime.messages(admin, room.id).length, 1);
    runtime.deleteAgent(admin, child.id); // Idempotent retry never recreates the private store.
    const target = join(paths.runtime, 'restored-before-delete');
    await prepareRestore(join(paths.backups, before.id), target, runtime.deletionRecords(admin), runtime.deletedAgents(admin));
    const restored = new Runtime(target);
    try {
      assert.equal(restored.agents(restored.administrator()).length, 1);
      assert.throws(() => restored.agentSession(child.id), /Agent not found/);
      assert.equal(existsSync(join(target, 'agents', child.id)), false);
    } finally { restored.close(); }
    const after = await backups.create();
    assert.equal(after.files.some(file => file.path.includes(child.id)), false);
    runtime.createAgent(actor, '空いた枠の仲間');
    const orphan = join(paths.state, 'agents', child.id); mkdirSync(orphan); writeFileSync(join(orphan, 'synthetic-leftover'), '消去途中の人工データ');
    const reopened = new Runtime(paths.state);
    try { assert.equal(existsSync(orphan), false); } finally { reopened.close(); }
  } finally { await backups.stop(); runtime.close(); rmSync(root, { recursive: true, force: true }); }
});

test('daily backups use the saved Japan time and avoid duplicates after restarts or schedule changes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'niwa-backup-time-'));
  const installation = { version: 1 as const, origin: 'https://niwa.test', port: 3210 };
  const paths = initializeInstallation(root, installation); const runtime = new Runtime(paths.state); const admin = runtime.administrator();
  runtime.bootstrap(admin);
  let now = Date.parse('2026-09-07T02:59:00+09:00');
  let backups = new Backups(runtime, paths, installation, () => now);
  try {
    assert.equal(runtime.settings(admin).backupTime, '03:00');
    assert.throws(() => runtime.updateSettings(admin, { backupTime: '24:00' }), /Invalid backup time/);
    await backups.tick(); assert.equal((await backups.list()).length, 0);
    now += 60_000;
    const first = backups.tick(); assert.equal(backups.tick(), first); await first;
    assert.equal((await backups.list()).length, 1);
    await backups.stop(); backups = new Backups(runtime, paths, installation, () => now);
    await backups.tick(); assert.equal((await backups.list()).length, 1);
    runtime.updateSettings(admin, { backupTime: '04:00' }); now += 3600_000;
    await backups.tick(); assert.equal((await backups.list()).length, 1);
    now = Date.parse('2026-09-08T03:59:00+09:00'); await backups.tick(); assert.equal((await backups.list()).length, 1);
    now += 60_000; await backups.tick(); assert.equal((await backups.list()).length, 2);
    // A missed day is not replayed in a burst; starting after today's time creates one snapshot.
    now = Date.parse('2026-09-11T11:00:00+09:00'); await backups.tick(); assert.equal((await backups.list()).length, 3);
    now = Date.parse('2026-09-12T01:00:00+09:00'); await backups.create();
    now = Date.parse('2026-09-12T04:00:00+09:00'); await backups.tick(); assert.equal((await backups.list()).length, 4);
    now += 86400_000;
    const list = backups.list.bind(backups); let release!: () => void; let started!: () => void; let delayed = false;
    const pendingRead = new Promise<void>(resolve => { started = resolve; });
    backups.list = async () => {
      const items = await list();
      if (!delayed) { delayed = true; started(); await new Promise<void>(resolve => { release = resolve; }); }
      return items;
    };
    const pendingTick = backups.tick(); await pendingRead;
    try { await backups.create(); } finally { release(); }
    await pendingTick; assert.equal((await list()).length, 5);
    await backups.stop(); now += 86400_000; await backups.tick(); assert.equal((await backups.list()).length, 5);
    const reopened = new Runtime(paths.state);
    try { assert.equal(reopened.settings(reopened.administrator()).backupTime, '04:00'); }
    finally { reopened.close(); }
  } finally { await backups.stop(); runtime.close(); rmSync(root, { recursive: true, force: true }); }
});

test('daily backup opt-out persists, preserves snapshots and manual saves, and rechecks a pending tick', async () => {
  const root = mkdtempSync(join(tmpdir(), 'niwa-backup-enabled-'));
  const installation = { version: 1 as const, origin: 'https://niwa.test', port: 3210 };
  const paths = initializeInstallation(root, installation);
  let runtime = new Runtime(paths.state);
  let admin = runtime.administrator();
  const leader = runtime.bootstrap(admin);
  let now = Date.parse('2026-09-10T04:00:00+09:00');
  let backups = new Backups(runtime, paths, installation, () => now);
  try {
    assert.equal(runtime.settings(admin).backupEnabled, true);
    assert.throws(() => runtime.updateSettings(runtime.agentSession(leader.id), { backupEnabled: false }), /Administrator/);
    assert.throws(() => runtime.updateSettings(admin, { backupEnabled: 'false' } as never), /Expected backup boolean/);
    await backups.tick();
    const initial = (await backups.list())[0]!;
    runtime.updateSettings(admin, { backupEnabled: false });
    now += 86400_000;
    await backups.tick();
    assert.deepEqual((await backups.list()).map(item => item.id), [initial.id]);
    await backups.stop(); runtime.close();
    runtime = new Runtime(paths.state); admin = runtime.administrator();
    backups = new Backups(runtime, paths, installation, () => now);
    assert.equal(runtime.settings(admin).backupEnabled, false);
    await backups.tick(); assert.equal((await backups.list()).length, 1);
    await backups.create(); assert.equal((await backups.list()).length, 2);
    runtime.updateSettings(admin, { backupEnabled: true });
    await backups.tick(); assert.equal((await backups.list()).length, 2);
    now += 86400_000;
    const list = backups.list.bind(backups);
    let release!: () => void; let started!: () => void;
    const reading = new Promise<void>(resolve => { started = resolve; });
    backups.list = async () => { const items = await list(); started(); await new Promise<void>(resolve => { release = resolve; }); return items; };
    const pending = backups.tick(); await reading;
    runtime.updateSettings(admin, { backupEnabled: false }); release(); await pending;
    backups.list = list;
    assert.equal((await backups.list()).length, 2);
    runtime.updateSettings(admin, { backupEnabled: true });
    await backups.tick(); assert.equal((await backups.list()).length, 3);
    await backups.tick(); assert.equal((await backups.list()).length, 3);
  } finally { await backups.stop(); runtime.close(); rmSync(root, { recursive: true, force: true }); }
});

test('backup captures a consistent set of databases, excludes secrets, and compresses after writes resume', async () => {
  const root = mkdtempSync(join(tmpdir(), 'niwa-backup-'));
  const installation = { version: 1 as const, origin: 'https://niwa.test', port: 3210 };
  const paths = initializeInstallation(root, installation);
  const runtime = new Runtime(paths.state); const admin = runtime.administrator();
  const leader = runtime.bootstrap(admin); const actor = runtime.agentSession(leader.id);
  const room = runtime.createRoom(admin, '保存前の会話'); const source = runtime.post(admin, room.id, '記憶の出所');
  const memory = runtime.remember(actor, source.id, '保存前の記憶');
  runtime.updateProfile(admin, leader.id, { persona: '保存する人格' });
  runtime.updateSettings(admin, { paused: true });
  writeFileSync(join(paths.secrets, 'artificial-secret'), 'DO_NOT_BACK_UP');
  const backups = new Backups(runtime, paths, installation);
  const original = runtime.snapshot.bind(runtime);
  runtime.snapshot = (actor, directory) => {
    const names = original(actor, directory);
    runtime.post(admin, room.id, '保存後に活動を続ける');
    runtime.correctMemory(admin, leader.id, memory.id, 1, '保存後の記憶');
    return names;
  };
  try {
    assert.throws(() => runtime.snapshot(actor, join(paths.runtime, 'forbidden')), /Administrator/);
    const pending = backups.create(); assert.equal(backups.create(), pending);
    const manifest = await pending;
    assert.equal(manifest.files.length, 2);
    const restored = join(root, 'verification');
    for (const file of manifest.files) {
      assert.match(file.path, /^(control\.db|agents\/[0-9a-f-]{36}\/memory\.db)\.gz$/);
      const bytes = readFileSync(join(paths.backups, manifest.id, file.path));
      assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
      const target = join(restored, file.path.slice(0, -3)); mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, gunzipSync(bytes));
    }
    const saved = new Runtime(restored);
    try {
      const administrator = saved.administrator();
      assert.equal(saved.messages(administrator, room.id).length, 1);
      assert.equal(saved.memories(administrator, leader.id)[0]?.body, '保存前の記憶');
      assert.equal(saved.profile(administrator, leader.id).persona, '保存する人格');
      assert.equal(saved.settings(administrator).paused, true);
    } finally { saved.close(); }
    assert.equal(runtime.messages(admin, room.id).length, 2);
    assert.equal(runtime.memories(admin, leader.id)[0]?.body, '保存後の記憶');
    assert.equal((await backups.list())[0]?.id, manifest.id);
    assert.deepEqual(readdirSync(join(paths.backups, '.staging')), []);
  } finally { await backups.stop(); runtime.close(); rmSync(root, { recursive: true, force: true }); }
});

test('retention removes expired complete backups and a failed snapshot leaves no partial backup', async () => {
  const root = mkdtempSync(join(tmpdir(), 'niwa-retention-'));
  const installation = { version: 1 as const, origin: 'https://niwa.test', port: 3210 };
  const paths = initializeInstallation(root, installation); const runtime = new Runtime(paths.state);
  runtime.bootstrap(runtime.administrator()); const backups = new Backups(runtime, paths, installation);
  try {
    const old = await backups.create(); old.created_at -= 15 * 86_400_000;
    writeFileSync(join(paths.backups, old.id, 'manifest.json'), JSON.stringify(old));
    const current = await backups.create();
    assert.deepEqual((await backups.list()).map(item => item.id), [current.id]);
    const snapshot = runtime.snapshot.bind(runtime);
    runtime.snapshot = (actor, directory) => { snapshot(actor, directory); throw new Error('Artificial storage failure'); };
    await assert.rejects(backups.create(), /Artificial storage failure/);
    assert.deepEqual((await backups.list()).map(item => item.id), [current.id]);
    assert.deepEqual(readdirSync(join(paths.backups, '.staging')), []);
    assert.match(backups.error!, /保存できません/);
  } finally { await backups.stop(); runtime.close(); rmSync(root, { recursive: true, force: true }); }
});

test('restore validates the snapshot, reapplies later deletions and starts paused without changing current state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'niwa-restore-'));
  const installation = { version: 1 as const, origin: 'https://niwa.test', port: 3210 };
  const paths = initializeInstallation(root, installation); const runtime = new Runtime(paths.state);
  const admin = runtime.administrator(); const leader = runtime.bootstrap(admin); const actor = runtime.agentSession(leader.id);
  const room = runtime.createRoom(admin, '復元する会話'); const source = runtime.post(admin, room.id, '出所');
  const memory = runtime.remember(actor, source.id, 'あとで削除する記憶');
  const task = runtime.tasks.create(admin, leader.id, room.id, '派生情報の復元を確認');
  const lease = runtime.tasks.claim(admin)!;
  runtime.tasks.updatePlan(actor, lease, 'plan', 0, ['削除前の派生手順']);
  runtime.saveSummary(actor, lease, 'summary', { conclusion: '削除前の派生要約', reason: '記憶を参照した', unresolved: [], next_steps: [],
    sources: [{ kind: 'memory', source_id: memory.id, revision: runtime.readHistory(actor, room.id, 'memory', memory.id).revision }] });
  const backups = new Backups(runtime, paths, installation);
  try {
    const manifest = await backups.create();
    runtime.deleteMemory(admin, leader.id, memory.id, memory.revision);
    const later = runtime.remember(actor, source.id, 'バックアップ後に作って削除した記憶', 'future-memory');
    runtime.deleteMemory(admin, leader.id, later.id, later.revision);
    runtime.post(admin, room.id, 'バックアップ以後の会話');
    const directory = join(paths.backups, manifest.id); const target = join(root, 'restored');
    await prepareRestore(directory, target, runtime.deletionRecords(admin));
    const restored = new Runtime(target);
    try {
      const administrator = restored.administrator();
      assert.equal(restored.memories(administrator, leader.id).length, 0);
      assert.equal(restored.settings(administrator).paused, true);
      assert.equal(restored.messages(administrator, room.id).length, 1);
      assert.equal(restored.deletionRecords(administrator).some(record => record.memory_id === memory.id), true);
      restored.updateSettings(administrator, { paused: false });
      const restoredActor = restored.agentSession(leader.id);
      assert.equal(restored.searchHistory(restoredActor, room.id, '削除前の派生要約').length, 0);
      assert.throws(() => restored.readHistory(restoredActor, room.id, 'summary', task.id), /unavailable/);
      restored.tasks.recover(administrator);
      assert.deepEqual(restored.tasks.workState(restoredActor, restored.tasks.claim(administrator)!).remaining_plan, { revision: 0, remaining: [] });
      assert.throws(() => restored.remember(restored.agentSession(leader.id), source.id, '再送による復活', 'future-memory'), /deleted/);
    } finally { restored.close(); }
    assert.equal(runtime.messages(admin, room.id).length, 2);
    await assert.rejects(prepareRestore(directory, target, []), /EEXIST/);
    assert.equal(existsSync(join(target, 'control.db')), true);
    manifest.files[0]!.sha256 = '0'.repeat(64);
    writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest));
    const invalid = join(root, 'invalid');
    await assert.rejects(prepareRestore(directory, invalid, []), /checksum/);
    assert.equal(existsSync(invalid), false);
    manifest.files[0]!.path = '../../escape.db.gz';
    writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest));
    await assert.rejects(prepareRestore(directory, invalid, []), /Invalid backup file/);
    assert.equal(existsSync(invalid), false);
  } finally { await backups.stop(); runtime.close(); rmSync(root, { recursive: true, force: true }); }
});

test('installation restore refuses a running source, preserves it, and creates a separate paused installation with fresh authentication', async () => {
  const base = mkdtempSync(join(tmpdir(), 'niwa-restore-installation-'));
  const root = join(base, 'source'); const destination = join(base, 'restored');
  const installation = { version: 1 as const, origin: 'https://niwa.test', port: 3210 };
  const paths = initializeInstallation(root, installation); const key = adminKey(paths);
  const runtime = new Runtime(paths.state); const admin = runtime.administrator(); runtime.bootstrap(admin);
  const backups = new Backups(runtime, paths, installation);
  try {
    const manifest = await backups.create(); await backups.stop(); runtime.close();
    const unlock = acquireProcessLock(join(paths.runtime, 'sockets', 'service-lock.db'));
    try { await assert.rejects(restoreInstallation(root, manifest.id, destination), /already/); }
    finally { unlock(); }
    assert.equal(existsSync(destination), false);
    const restoredPaths = await restoreInstallation(root, manifest.id, destination);
    assert.deepEqual(readInstallation(destination), installation);
    assert.deepEqual(readdirSync(restoredPaths.secrets), []);
    assert.notEqual(adminKey(restoredPaths), key);
    assert.equal(adminKey(paths), key);
    const restored = new Runtime(restoredPaths.state);
    try { assert.equal(restored.settings(restored.administrator()).paused, true); }
    finally { restored.close(); }
    await assert.rejects(restoreInstallation(root, manifest.id, destination), /EEXIST/);
    assert.equal(existsSync(join(restoredPaths.state, 'control.db')), true);
  } finally { await backups.stop(); runtime.close(); rmSync(base, { recursive: true, force: true }); }
});
