import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalLlmAdapter, inspectLocalLlmModel, listLocalLlmModels } from '../src/providers/local-llm/adapter.ts';
import { collectModelEvents } from '../src/providers/shared/adapter.ts';
import { request } from './fixtures/model.ts';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gunzipSync, gzipSync } from 'node:zlib';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { editSchema } from '../src/storage/database.ts';
import { Runtime } from '../src/runtime/runtime.ts';
import { Backups } from '../src/backup/backups.ts';
import { prepareRestore } from '../src/backup/restore.ts';
import { initializeInstallation } from '../src/config/installation.ts';

test('local catalog reads installed models and per-model tool capability', async () => {
  const fake: typeof fetch = async url => new URL(String(url)).pathname === '/api/tags'
    ? Response.json({ models: [{ name: 'artificial:small' }] })
    : Response.json({ capabilities: ['completion', 'tools', 'thinking'] });
  assert.deepEqual(await listLocalLlmModels('http://192.0.2.1:11434', fake), ['artificial:small']);
  assert.deepEqual(await inspectLocalLlmModel('http://192.0.2.1:11434', 'artificial:small', fake), { id: 'artificial:small', tools: true, thinking: true });
  await assert.rejects(inspectLocalLlmModel('http://localhost:11434', 'remote', async () => Response.json({ capabilities: ['completion'], remote_host: 'cloud.example' })), /local/);
});

test('Local LLM translates history and tool results without forwarding Codex reasoning settings', async () => {
  const { reasoning_effort: _effort, ...local } = request;
  const adapter = new LocalLlmAdapter('http://192.0.2.1:11434', { id: 'artificial', tools: true, thinking: false }, async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(init?.redirect, 'error');
    assert.equal(body.reasoning, undefined);
    assert.equal(body.think, undefined);
    assert.equal(body.messages[0].role, 'system');
    assert.equal(body.messages.at(-1).tool_name, 'remember');
    return Response.json({ done: true, message: { role: 'assistant', content: '覚えました' }, prompt_eval_count: 4, eval_count: 2 });
  });
  const events = await collectModelEvents(adapter.run({ ...local, messages: [...local.messages,
    { role: 'tool', name: 'remember', tool_call_id: 'call1', content: '{"id":"memory1"}' }] }, { timeout_ms: 1000 }));
  assert.equal(events.at(-1)?.type, 'completed');
  const unsupported = await collectModelEvents(adapter.run(request, { timeout_ms: 1000 }));
  assert.equal(unsupported.find(e => e.type === 'failed')?.error.code, 'CAPABILITY_MISMATCH');
});

test('Local LLM malformed responses and hanging transport yield bounded failures', async () => {
  const { reasoning_effort: _effort, ...local } = request;
  const invalid = new LocalLlmAdapter('http://localhost:11434', { id: 'artificial', tools: false, thinking: false }, async () => Response.json({ done: false, message: {} }));
  const bad = await collectModelEvents(invalid.run(local, { timeout_ms: 1000 }));
  assert.equal(bad.find(e => e.type === 'failed')?.error.code, 'INVALID_RESPONSE');
  const hanging = new LocalLlmAdapter('http://localhost:11434', { id: 'artificial', tools: false, thinking: false }, async () => new Promise(() => undefined));
  const timeout = await collectModelEvents(hanging.run(local, { timeout_ms: 20 }));
  assert.equal(timeout.find(e => e.type === 'failed')?.error.code, 'TIMED_OUT');
});

/** Turns a current control.db back into the schema-52 form that still names the provider 'ollama'. */
function rewindLocalLlm(file: string, member: string): void {
  const db = new DatabaseSync(file);
  try {
    const sql = (name: string) => String(db.prepare('SELECT sql FROM sqlite_schema WHERE name=?').get(name)!.sql);
    const version = Number(db.prepare('PRAGMA schema_version').get()!.schema_version);
    db.exec('BEGIN;');
    editSchema(db, () => {
      for (const name of ['agents', 'model_settings']) db.prepare('UPDATE sqlite_schema SET sql=? WHERE name=?').run(sql(name).replaceAll("'local_llm'", "'ollama'"), name);
      db.exec(`PRAGMA schema_version=${version + 1}`);
    });
    db.exec('COMMIT;');
    db.exec(`ALTER TABLE model_settings RENAME COLUMN local_llm_url TO ollama_url;
      UPDATE agents SET provider='ollama' WHERE provider='local_llm'; UPDATE model_settings SET fallback_provider='ollama' WHERE fallback_provider='local_llm';
      UPDATE generated_model SET provider='ollama' WHERE provider='local_llm'; UPDATE model_routes SET provider='ollama' WHERE provider='local_llm'; PRAGMA user_version=52;`);
    const room = String(db.prepare('SELECT id FROM rooms LIMIT 1').get()!.id); const artifact = randomUUID();
    db.prepare("INSERT INTO artifacts VALUES (?,?,?,'成果物','text','','本文',1)").run(artifact, room, member);
    db.prepare("INSERT INTO artifact_reviews(artifact_id,reviewer_id,sha256,verdict,note,created_at,review_model) VALUES (?,?,?,'approved','',1,'ollama/artificial-local/native')").run(artifact, member, '0'.repeat(64));
    db.prepare('INSERT INTO agent_autonomy VALUES (?,0)').run(member);
    assert.doesNotMatch(sql('agents') + sql('model_settings'), /local_llm/);
  } finally { db.close(); }
}
function assertLocalLlm(file: string, member: string, autonomy: number): void {
  const db = new DatabaseSync(file);
  try {
    const sql = (name: string) => String(db.prepare('SELECT sql FROM sqlite_schema WHERE name=?').get(name)!.sql);
    assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 64);
    assert.equal(db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
    assert.doesNotMatch(sql('agents') + sql('model_settings'), /ollama/);
    assert.equal(db.prepare('SELECT provider FROM agents WHERE id=?').get(member)!.provider, 'local_llm');
    assert.equal(db.prepare('SELECT provider FROM model_routes WHERE agent_id=?').get(member)!.provider, 'local_llm');
    assert.equal(db.prepare('SELECT provider FROM generated_model').get()!.provider, 'local_llm');
    assert.equal(db.prepare('SELECT review_model FROM artifact_reviews').get()!.review_model, 'local_llm/artificial-local/native');
    assert.equal(db.prepare('SELECT count(*) AS count FROM agent_autonomy').get()!.count, autonomy);
    assert.throws(() => db.prepare("UPDATE agents SET provider='ollama' WHERE id=?").run(member), /CHECK/);
    assert.throws(() => db.prepare("UPDATE model_settings SET fallback_provider='ollama'").run(), /CHECK/);
    db.exec('BEGIN'); db.prepare("UPDATE agents SET provider='local_llm' WHERE id=?").run(member); db.prepare("UPDATE model_settings SET fallback_provider='local_llm'").run(); db.exec('ROLLBACK');
  } finally { db.close(); }
}

test('upgrading a schema52 database renames the stored Local LLM provider id and endpoint column in place, also when restoring an older backup', async () => {
  const root = mkdtempSync(join(tmpdir(), 'niwa-local-llm-upgrade-')); const installation = { version: 1 as const, origin: 'https://niwa.test', port: 3210 };
  const paths = initializeInstallation(root, installation); let runtime = new Runtime(paths.state); const url = 'http://127.0.0.1:11434';
  const backups = new Backups(runtime, paths, installation);
  try {
    let admin = runtime.administrator(); const leader = runtime.bootstrap(admin); const member = runtime.createAgent(runtime.agentSession(leader.id), '既存Bot').id;
    runtime.configureLocalLlm(admin, url); runtime.configureFallback(admin, url, 'artificial-local');
    runtime.setAgentModel(admin, member, 'local_llm', 'artificial-local', 'native'); runtime.recordModelRoute(admin, member, 'local_llm', 'artificial-local', 'configured');
    runtime.configureGeneratedModel(admin, 'local_llm', 'artificial-local', 'native'); runtime.createRoom(admin, '成果物の会話');
    const manifest = await backups.create(); await backups.stop(); runtime.close();
    const control = join(paths.state, 'control.db'); rewindLocalLlm(control, member);
    const agents = (db: string) => { const handle = new DatabaseSync(db); try { return handle.prepare('SELECT id,name,role,status,model,reasoning FROM agents ORDER BY id').all(); } finally { handle.close(); } };
    const before = agents(control);
    // The snapshot taken before the rewind is rewound the same way, as if it had been saved by the previous version.
    const directory = join(paths.backups, manifest.id); const scratch = join(root, 'old-control.db');
    writeFileSync(scratch, gunzipSync(readFileSync(join(directory, 'control.db.gz')))); rewindLocalLlm(scratch, member);
    const packed = gzipSync(readFileSync(scratch)); const entry = manifest.files.find(file => file.path === 'control.db.gz')!;
    writeFileSync(join(directory, 'control.db.gz'), packed); entry.bytes = packed.length; entry.sha256 = createHash('sha256').update(packed).digest('hex');
    writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest));
    runtime = new Runtime(paths.state); admin = runtime.administrator();
    assertLocalLlm(control, member, 1);
    assert.deepEqual(agents(control), before);
    assert.deepEqual(runtime.modelSettings(admin), { localLlmUrl: url, fallbackModel: 'artificial-local', maxParallel: 1, fallbackProvider: 'local_llm', compatibleUrl: null, compatibleParallel: 2, anthropicParallel: 2 });
    assert.equal(runtime.agents(admin).find(agent => agent.id === member)!.provider, 'local_llm');
    assert.equal((runtime.modelRoutes(admin) as { id: string; provider: string; configured_provider: string }[]).find(route => route.id === member)!.provider, 'local_llm');
    runtime.close();
    // Replaying the step on an already renamed database changes nothing.
    const schema = (db: string) => { const handle = new DatabaseSync(db); try { return handle.prepare('SELECT name,sql FROM sqlite_schema ORDER BY name').all(); } finally { handle.close(); } };
    const migrated = schema(control); const replay = new DatabaseSync(control); replay.exec('PRAGMA user_version=52'); replay.close();
    runtime = new Runtime(paths.state); runtime.close(); assert.deepEqual(schema(control), migrated); assertLocalLlm(control, member, 1);
    const target = join(root, 'restored'); await prepareRestore(directory, target, []);
    assertLocalLlm(join(target, 'control.db'), member, 1);
    const restored = new Runtime(target);
    try { assert.equal(restored.modelSettings(restored.administrator()).localLlmUrl, url); assert.equal(restored.generatedModel(restored.administrator()).provider, 'local_llm'); }
    finally { restored.close(); }
    runtime = new Runtime(paths.state);
  } finally { await backups.stop(); runtime.close(); rmSync(root, { recursive: true, force: true }); }
});
