import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { editSchema } from '../src/storage/database.ts';
import { OpenAICompatibleAdapter, listCompatibleModels } from '../src/providers/openai-compatible/adapter.ts';
import { normalizeCompatibleUrl } from '../src/providers/openai-compatible/url.ts';
import { collectModelEvents } from '../src/providers/shared/adapter.ts';
import { ModelSetupError } from '../src/providers/shared/setup-error.ts';
import { FileApiKeyStore, MemoryApiKeyStore } from '../src/auth/api-key.ts';
import { ModelGateway } from '../src/providers/gateway.ts';
import { Runtime } from '../src/runtime/runtime.ts';
import { TurnRunner } from '../src/runtime/turns.ts';
import { Subscription } from '../src/auth/subscription.ts';
import { MemoryCredentialStore } from '../src/auth/credential-store.ts';
import { credential, request } from './fixtures/model.ts';

const KEY = 'sk-artificial-compatible-0123456789abcdef';
type Handler = (req: IncomingMessage, body: Record<string, unknown> | undefined, res: ServerResponse) => void | Promise<void>;
async function server(handler: Handler) {
  const seen: { path: string; auth: string | undefined; body: Record<string, unknown> | undefined }[] = [];
  const http = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> : undefined;
    seen.push({ path: req.url!, auth: req.headers.authorization, body });
    res.setHeader('content-type', 'application/json');
    await handler(req, body, res);
  });
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}/v1`;
  return { url, seen, close: () => new Promise<void>(resolve => { http.close(() => resolve()); http.closeAllConnections(); }) };
}
const json = (res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}) => {
  for (const [name, item] of Object.entries(headers)) res.setHeader(name, item);
  res.statusCode = status; res.end(JSON.stringify(value));
};
const local = (() => { const { reasoning_effort: _effort, ...rest } = request; return rest; })();

test('OpenAI-compatible URLs require https except loopback and reject credentials, queries and fragments', () => {
  assert.equal(normalizeCompatibleUrl('https://api.openai.com/v1/'), 'https://api.openai.com/v1');
  assert.equal(normalizeCompatibleUrl('https://openrouter.ai/api/v1'), 'https://openrouter.ai/api/v1');
  for (const ok of ['http://127.0.0.1:1234/v1', 'http://localhost:1234/v1', 'http://[::1]:8000/v1']) assert.ok(normalizeCompatibleUrl(ok), ok);
  for (const bad of ['http://192.168.1.5:1234/v1', 'http://api.openai.com/v1', 'https://user:pass@api.openai.com/v1', 'https://api.openai.com/v1?key=x',
    'https://api.openai.com/v1#x', 'file:///etc/passwd', 'ftp://example.com', 'not a url', 'https://api.openai.com/v1\n', 'https://example.com/?']) {
    assert.equal(normalizeCompatibleUrl(bad), undefined, bad);
  }
  const root = mkdtempSync(join(tmpdir(), 'niwa-compatible-url-')); const runtime = new Runtime(root);
  try {
    const admin = runtime.administrator(); const leader = runtime.bootstrap(admin);
    assert.throws(() => runtime.configureCompatible(admin, 'http://203.0.113.1/v1'), /Invalid/);
    assert.throws(() => runtime.configureCompatible(runtime.agentSession(leader.id), 'https://api.openai.com/v1'), /Administrator/);
    runtime.configureCompatible(admin, 'https://api.openai.com/v1/');
    assert.equal(runtime.modelSettings(admin).compatibleUrl, 'https://api.openai.com/v1');
    assert.throws(() => runtime.configureCompatibleParallel(admin, 9), /Invalid/);
    runtime.configureCompatibleParallel(admin, 3); assert.equal(runtime.modelSettings(admin).compatibleParallel, 3);
    // The widened provider constraint still rejects unknown providers.
    runtime.setAgentModel(admin, leader.id, 'openai_compatible', 'artificial-model', 'native');
    assert.equal(runtime.agents(admin)[0]!.provider, 'openai_compatible');
    const db = new DatabaseSync(join(root, 'control.db'));
    assert.throws(() => db.prepare("UPDATE agents SET provider='bogus'").run(), /CHECK/);
    db.close();
  } finally { runtime.close(); rmSync(root, { recursive: true, force: true }); }
});

test('upgrading a schema49 database widens the provider constraint in place and keeps agents and settings', () => {
  const root = mkdtempSync(join(tmpdir(), 'niwa-compatible-upgrade-')); let runtime = new Runtime(root);
  try {
    let admin = runtime.administrator(); const leader = runtime.bootstrap(admin); const member = runtime.createAgent(runtime.agentSession(leader.id), '既存Bot');
    runtime.configureLocalLlm(admin, 'http://127.0.0.1:11434'); runtime.configureFallback(admin, 'http://127.0.0.1:11434', 'artificial-local');
    runtime.close();
    const db = new DatabaseSync(join(root, 'control.db'));
    const sql = String(db.prepare("SELECT sql FROM sqlite_schema WHERE name='agents'").get()!.sql);
    const version = Number(db.prepare('PRAGMA schema_version').get()!.schema_version);
    db.exec('BEGIN;');
    editSchema(db, () => {
      db.prepare("UPDATE sqlite_schema SET sql=? WHERE name='agents'").run(sql.replace(",'openai_compatible','anthropic'", '').replace("'local_llm'", "'ollama'"));
      db.exec(`PRAGMA schema_version=${version + 1}`);
    });
    db.exec('COMMIT;');
    db.exec('ALTER TABLE model_settings RENAME COLUMN local_llm_url TO ollama_url; ALTER TABLE model_settings DROP COLUMN compatible_url; ALTER TABLE model_settings DROP COLUMN compatible_parallel; ALTER TABLE model_settings DROP COLUMN fallback_provider; ALTER TABLE model_settings DROP COLUMN anthropic_parallel; DROP TRIGGER clear_schedule_sources; DROP TABLE schedule_sources; PRAGMA user_version=49;');
    const before = JSON.stringify(db.prepare('SELECT * FROM agents ORDER BY id').all());
    const autonomy = db.prepare('SELECT count(*) AS count FROM agent_autonomy').get()!.count;
    db.close();
    runtime = new Runtime(root); admin = runtime.administrator();
    const after = new DatabaseSync(join(root, 'control.db'));
    try {
      assert.equal(after.prepare('PRAGMA user_version').get()!.user_version, 60);
      assert.equal(JSON.stringify(after.prepare('SELECT * FROM agents ORDER BY id').all()), before);
      assert.equal(after.prepare('SELECT count(*) AS count FROM agent_autonomy').get()!.count, autonomy);
      assert.match(String(after.prepare("SELECT sql FROM sqlite_schema WHERE name='agents'").get()!.sql), /'openai_compatible'/);
    } finally { after.close(); }
    assert.deepEqual(runtime.modelSettings(admin), { localLlmUrl: 'http://127.0.0.1:11434', fallbackModel: 'artificial-local', maxParallel: 1, fallbackProvider: 'local_llm', compatibleUrl: null, compatibleParallel: 2, anthropicParallel: 2 });
    runtime.setAgentModel(admin, member.id, 'openai_compatible', 'artificial-model', 'native');
    assert.equal(runtime.agents(admin).find(agent => agent.id === member.id)!.provider, 'openai_compatible');
  } finally { runtime.close(); rmSync(root, { recursive: true, force: true }); }
});

test('model listing sends the key as a bearer header, bounds the list and maps rejected keys', async () => {
  const fake = await server((req, _body, res) => {
    if (req.headers.authorization !== `Bearer ${KEY}`) return json(res, 401, { error: { message: `invalid key ${req.headers.authorization}` } });
    json(res, 200, { object: 'list', data: [{ id: 'model-b' }, { id: 'model-a' }, { id: 'model-a' }, { id: '\u0000bad' }, { name: 'no-id' }] });
  });
  try {
    assert.deepEqual(await listCompatibleModels(fake.url, KEY), ['model-a', 'model-b']);
    assert.equal(fake.seen[0]!.path, '/v1/models');
    await assert.rejects(listCompatibleModels(fake.url, 'sk-wrong-key-value-000000'), (error: unknown) =>
      error instanceof ModelSetupError && error.failure.code === 'AUTHENTICATION_FAILED' && !error.failure.retryable && !JSON.stringify(error.failure).includes('sk-wrong'));
  } finally { await fake.close(); }
  const huge = await server((_req, _body, res) => json(res, 200, { data: Array.from({ length: 5001 }, (_, i) => ({ id: `m${i}` })) }));
  try { await assert.rejects(listCompatibleModels(huge.url, undefined), (error: unknown) => error instanceof ModelSetupError && error.failure.code === 'INVALID_RESPONSE'); }
  finally { await huge.close(); }
});

test('Chat Completions adapter round-trips tool calls and tool results', async () => {
  const fake = await server((_req, body, res) => {
    const messages = body!.messages as Record<string, unknown>[];
    if (!messages.some(message => message.role === 'tool')) {
      return json(res, 200, { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
        tool_calls: [{ id: 'call_abc', type: 'function', function: { name: 'remember', arguments: '{"query":"人工"}' } }] } }],
        usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } });
    }
    json(res, 200, { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '覚えました' } }] });
  });
  const tools = [{ name: 'remember', description: 'Remember', input_schema: { type: 'object', properties: { query: { type: 'string' } } } }];
  try {
    const adapter = new OpenAICompatibleAdapter({ baseUrl: fake.url, apiKey: KEY }, 'artificial-model');
    assert.equal(adapter.capabilities.auth_mode, 'api_key'); assert.equal(adapter.capabilities.supports_niwa_tool_loop, true);
    const first = await collectModelEvents(adapter.run({ ...local, tools }, { timeout_ms: 2000 }));
    const call = first.find(event => event.type === 'tool_call');
    assert.deepEqual(call, { type: 'tool_call', tool_call_id: 'call_abc', name: 'remember', arguments: { query: '人工' } });
    assert.deepEqual(first.find(event => event.type === 'usage'), { type: 'usage', input_tokens: 7, output_tokens: 3, total_tokens: 10 });
    assert.deepEqual(first.at(-1), { type: 'completed', finish_reason: 'tool_calls' });
    const sent = fake.seen[0]!;
    assert.equal(sent.path, '/v1/chat/completions'); assert.equal(sent.auth, `Bearer ${KEY}`);
    assert.equal(sent.body!.model, 'artificial-model'); assert.equal(sent.body!.stream, false);
    assert.equal(sent.body!.reasoning_effort, undefined); assert.equal(sent.body!.max_tokens, undefined);
    assert.deepEqual((sent.body!.messages as unknown[])[0], { role: 'system', content: local.system_instructions });
    assert.deepEqual(sent.body!.tools, [{ type: 'function', function: { name: 'remember', description: 'Remember', parameters: tools[0]!.input_schema } }]);
    assert.ok(!JSON.stringify(sent.body).includes(KEY));
    const second = await collectModelEvents(adapter.run({ ...local, tools, messages: [...local.messages,
      { role: 'assistant', tool_calls: [{ tool_call_id: 'call_abc', name: 'remember', arguments: { query: '人工' } }] },
      { role: 'tool', tool_call_id: 'call_abc', name: 'remember', content: '{"id":"memory1"}' }] }, { timeout_ms: 2000 }));
    assert.deepEqual(second.filter(event => event.type !== 'usage'), [{ type: 'text_delta', text: '覚えました' }, { type: 'completed', finish_reason: 'stop' }]);
    const messages = fake.seen[1]!.body!.messages as Record<string, unknown>[];
    assert.deepEqual(messages.at(-2), { role: 'assistant', content: null, tool_calls: [{ id: 'call_abc', type: 'function', function: { name: 'remember', arguments: '{"query":"人工"}' } }] });
    assert.deepEqual(messages.at(-1), { role: 'tool', tool_call_id: 'call_abc', content: '{"id":"memory1"}' });
    const noKey = new OpenAICompatibleAdapter({ baseUrl: fake.url }, 'artificial-model');
    assert.equal(noKey.capabilities.auth_mode, 'none');
    await collectModelEvents(noKey.run(local, { timeout_ms: 2000 }));
    assert.equal(fake.seen.at(-1)!.auth, undefined);
    const mismatch = await collectModelEvents(noKey.run(request, { timeout_ms: 2000 }));
    assert.equal(mismatch[0]?.type === 'failed' && mismatch[0].error.code, 'CAPABILITY_MISMATCH');
  } finally { await fake.close(); }
});

test('HTTP failures map to trusted retry classes and never echo the key or response body', async () => {
  let reply: (res: ServerResponse) => void = res => json(res, 200, {});
  const fake = await server((_req, _body, res) => reply(res));
  const adapter = new OpenAICompatibleAdapter({ baseUrl: fake.url, apiKey: KEY }, 'artificial-model');
  const failure = async () => {
    const events = await collectModelEvents(adapter.run(local, { timeout_ms: 2000 }));
    const event = events.find(item => item.type === 'failed');
    assert.ok(event && event.type === 'failed'); assert.ok(!JSON.stringify(events).includes(KEY)); assert.ok(!JSON.stringify(events).includes('upstream secret'));
    return event.error;
  };
  try {
    reply = res => json(res, 401, { error: { message: `Incorrect API key provided: ${KEY} upstream secret` } });
    let error = await failure();
    assert.equal(error.code, 'AUTHENTICATION_FAILED'); assert.equal(error.retryable, false); assert.match(error.message, /APIキー/);
    reply = res => json(res, 403, {}); assert.equal((await failure()).code, 'PERMISSION_DENIED');
    reply = res => json(res, 404, {}); assert.equal((await failure()).code, 'INVALID_REQUEST');
    reply = res => json(res, 400, { error: { message: 'tools unsupported upstream secret' } }); error = await failure();
    assert.equal(error.code, 'INVALID_REQUEST'); assert.equal(error.retryable, false);
    const before = Math.floor(Date.now() / 1000);
    reply = res => json(res, 429, { error: { type: 'rate_limit_exceeded' } }, { 'retry-after': '30' }); error = await failure();
    assert.equal(error.code, 'RATE_LIMITED'); assert.equal(error.retryable, true);
    assert.ok(error.reset_at! >= before + 29 && error.reset_at! <= before + 32);
    reply = res => json(res, 429, { error: { code: 'insufficient_quota', type: 'insufficient_quota' } }); error = await failure();
    assert.equal(error.code, 'QUOTA_EXCEEDED');
    reply = res => json(res, 402, {}); assert.equal((await failure()).code, 'QUOTA_EXCEEDED');
    reply = res => json(res, 503, {}); error = await failure(); assert.equal(error.code, 'PROVIDER_UNAVAILABLE'); assert.equal(error.retryable, true);
    reply = res => json(res, 200, { error: { code: 502, message: `upstream secret ${KEY}` } }); assert.equal((await failure()).code, 'PROVIDER_UNAVAILABLE');
    reply = res => { res.statusCode = 200; res.end('not json'); }; assert.equal((await failure()).code, 'INVALID_RESPONSE');
    reply = res => json(res, 200, { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'x', type: 'function', function: { name: 'remember', arguments: '{"api_key":"value"}' } }] } }] });
    assert.equal((await failure()).code, 'INVALID_RESPONSE');
    reply = res => json(res, 200, { choices: [{ message: { content: 'x'.repeat(9 * 1024 * 1024) } }] }); assert.equal((await failure()).code, 'INVALID_RESPONSE');
    reply = () => undefined;
    const hanging = await collectModelEvents(adapter.run(local, { timeout_ms: 50 }));
    const timeout = hanging.find(item => item.type === 'failed');
    assert.ok(timeout?.type === 'failed' && timeout.error.code === 'TIMED_OUT' && timeout.error.retryable);
    reply = res => json(res, 200, { choices: [{ finish_reason: 'stop', message: { content: 'ok' } }] });
    const leaking = await collectModelEvents(adapter.run({ ...local, messages: [{ role: 'user', content: `my key is ${KEY}` }] }, { timeout_ms: 2000 }));
    assert.ok(!JSON.stringify(leaking).includes(KEY));
    assert.ok(!JSON.stringify(fake.seen.map(item => item.body)).includes(KEY));
  } finally { await fake.close(); }
  const closed = new OpenAICompatibleAdapter({ baseUrl: fake.url, apiKey: KEY }, 'artificial-model');
  const network = (await collectModelEvents(closed.run(local, { timeout_ms: 2000 }))).find(item => item.type === 'failed');
  assert.ok(network?.type === 'failed' && network.error.code === 'NETWORK_ERROR' && network.error.retryable);
});

test('API key file is private, bound to its origin and never returned by status', async () => {
  const root = mkdtempSync(join(tmpdir(), 'niwa-compatible-key-'));
  const runtime = new Runtime(join(root, 'state'));
  const store = new FileApiKeyStore(join(root, 'secrets', 'openai-compatible-key.json'));
  const gateway = new ModelGateway(runtime, fetch, undefined, store);
  try {
    assert.deepEqual(await gateway.compatibleStatus(), { available: true, url: null, parallel: 2, keyConfigured: false });
    await assert.rejects(gateway.configureCompatible({ apiKey: KEY }), /URL/);
    await assert.rejects(gateway.configureCompatible({ url: 'https://api.openai.com/v1', apiKey: 'has space' }), /Invalid/);
    const status = await gateway.configureCompatible({ url: 'https://api.openai.com/v1', apiKey: KEY, parallel: 4 });
    assert.deepEqual(status, { available: true, url: 'https://api.openai.com/v1', parallel: 4, keyConfigured: true });
    assert.ok(!JSON.stringify(status).includes(KEY));
    const file = join(root, 'secrets', 'openai-compatible-key.json');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).origin, 'https://api.openai.com');
    assert.ok(!readFileSync(join(root, 'state', 'control.db')).includes(KEY));
    // A key is not reused for a different origin.
    assert.equal((await gateway.configureCompatible({ url: 'https://openrouter.ai/api/v1' })).keyConfigured, false);
    assert.equal((await gateway.configureCompatible({ url: 'https://api.openai.com/v1' })).keyConfigured, true);
    assert.equal((await gateway.clearCompatibleKey()).keyConfigured, false);
    assert.equal(await store.read(), undefined);
  } finally { runtime.close(); rmSync(root, { recursive: true, force: true }); }
});

test('bots run the Niwa tool loop through the OpenAI-compatible provider and rejected keys stay out of task state', async () => {
  let reject = false;
  const fake = await server((req, body, res) => {
    if (reject) return json(res, 401, { error: { message: `bad key ${req.headers.authorization}` } });
    if (req.url === '/v1/models') return json(res, 200, { data: [{ id: 'artificial-model' }] });
    const messages = body!.messages as Record<string, unknown>[];
    const tools = (body!.tools as { function: { name: string } }[] | undefined)?.map(tool => tool.function.name) ?? [];
    if (tools.length === 1 && tools[0] === 'memory_review') return json(res, 200, { choices: [{ message: { content: '{"memories":[]}' }, finish_reason: 'stop' }] });
    if (!messages.some(message => message.role === 'tool')) {
      return json(res, 200, { choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'memory_search', arguments: '{"query":"人工"}' } }] } }] });
    }
    json(res, 200, { choices: [{ finish_reason: 'stop', message: { content: '記憶を確認して回答しました' } }] });
  });
  const root = mkdtempSync(join(tmpdir(), 'niwa-compatible-turn-')); const runtime = new Runtime(root);
  const store = new MemoryApiKeyStore();
  try {
    const admin = runtime.administrator(); const leader = runtime.bootstrap(admin);
    const gateway = new ModelGateway(runtime, fetch, undefined, store);
    await gateway.configureCompatible({ url: fake.url, apiKey: KEY });
    assert.deepEqual(await gateway.checkCompatible(), { ok: true, models: 1 });
    await assert.rejects(gateway.selectCompatible(leader.id, 'missing-model'), /not available/);
    const selected = await gateway.selectCompatible(leader.id, 'artificial-model');
    assert.equal(selected.provider, 'openai_compatible'); assert.equal(selected.reasoning, 'native');
    const room = runtime.createRoom(admin, '互換API');
    runtime.tasks.create(admin, leader.id, room.id, '回答してください');
    await new TurnRunner(runtime, gateway.resolve).run(runtime.tasks.claim(admin)!);
    assert.equal(runtime.messages(admin, room.id).at(-1)?.body, '記憶を確認して回答しました');
    assert.equal(runtime.modelRoutes(admin)[0]!.provider, 'openai_compatible');
    assert.ok(fake.seen.filter(item => item.path === '/v1/chat/completions').every(item => item.auth === `Bearer ${KEY}`));
    reject = true;
    const check = await gateway.checkCompatible();
    assert.equal(check.ok, false); assert.ok(!JSON.stringify(check).includes(KEY));
    const task = runtime.tasks.create(admin, leader.id, room.id, '鍵が拒否される仕事');
    await new TurnRunner(runtime, gateway.resolve).run(runtime.tasks.claim(admin)!);
    const state = runtime.tasks.get(admin, task.id);
    assert.equal(state.state, 'waiting_provider');
    assert.ok(!JSON.stringify(runtime.tasks.list(admin)).includes(KEY));
    assert.ok(!readFileSync(join(root, 'control.db')).includes(KEY));
  } finally { runtime.close(); await fake.close(); rmSync(root, { recursive: true, force: true }); }
});

test('subscription quota can switch to an OpenAI-compatible fallback model', async () => {
  const fake = await server((req, body, res) => {
    if (req.url === '/v1/models') return json(res, 200, { data: [{ id: 'fallback-model' }] });
    const tools = (body!.tools as { function: { name: string } }[] | undefined)?.map(tool => tool.function.name) ?? [];
    json(res, 200, { choices: [{ finish_reason: 'stop', message: { content: tools.length === 1 && tools[0] === 'memory_review' ? '{"memories":[]}' : '互換APIで継続' } }] });
  });
  const root = mkdtempSync(join(tmpdir(), 'niwa-compatible-fallback-')); const runtime = new Runtime(root);
  const credentials = new MemoryCredentialStore(); await credentials.write(credential);
  let primary = 0;
  const transport: typeof fetch = async (url, init) => {
    if (String(url).startsWith(fake.url)) return fetch(url, init);
    if (String(url).includes('/models')) return Response.json({ models: [{ slug: 'artificial-model', supported_reasoning_levels: [{ effort: 'low' }], visibility: 'list' }] });
    primary++;
    return Response.json({ error: { type: 'usage_limit_reached', resets_at: Math.floor(Date.now() / 1000) + 3600 } }, { status: 429 });
  };
  const subscription = new Subscription(credentials, () => {}, { fetch: transport });
  try {
    const admin = runtime.administrator(); const leader = runtime.bootstrap(admin);
    const gateway = new ModelGateway(runtime, transport, subscription, new MemoryApiKeyStore());
    await gateway.configureCompatible({ url: fake.url, apiKey: KEY });
    await assert.rejects(gateway.selectFallback('missing', 'openai_compatible'), /not available/);
    const settings = await gateway.selectFallback('fallback-model', 'openai_compatible');
    assert.equal(settings.fallbackProvider, 'openai_compatible'); assert.equal(settings.fallbackModel, 'fallback-model');
    runtime.configureLocalLlm(admin, 'http://127.0.0.1:9');
    assert.equal(runtime.modelSettings(admin).fallbackModel, 'fallback-model');
    runtime.setAgentModel(admin, leader.id, 'openai_subscription', 'artificial-model', 'low');
    const room = runtime.createRoom(admin, '切替');
    runtime.tasks.create(admin, leader.id, room.id, '回答してください');
    await new TurnRunner(runtime, gateway.resolve).run(runtime.tasks.claim(admin)!);
    assert.equal(primary, 1);
    assert.equal(runtime.tasks.list(admin)[0]!.result, '互換APIで継続');
    assert.equal(runtime.modelRoutes(admin)[0]!.provider, 'openai_compatible');
    assert.equal(runtime.modelRoutes(admin)[0]!.reason, 'quota');
    await gateway.configureCompatible({ url: 'https://api.openai.com/v1' });
    assert.equal(runtime.modelSettings(admin).fallbackModel, null);
  } finally { await subscription.close(); runtime.close(); await fake.close(); rmSync(root, { recursive: true, force: true }); }
});

test('the per-endpoint limit serializes OpenAI-compatible requests', async () => {
  let active = 0, peak = 0;
  const fake = await server(async (_req, _body, res) => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 30));
    active--; json(res, 200, { choices: [{ finish_reason: 'stop', message: { content: 'ok' } }] });
  });
  const root = mkdtempSync(join(tmpdir(), 'niwa-compatible-limit-')); const runtime = new Runtime(root);
  try {
    const admin = runtime.administrator(); const leader = runtime.bootstrap(admin);
    const gateway = new ModelGateway(runtime, fetch, undefined, new MemoryApiKeyStore());
    await gateway.configureCompatible({ url: fake.url, parallel: 1 });
    runtime.setAgentModel(admin, leader.id, 'openai_compatible', 'artificial-model', 'native');
    const adapter = await gateway.resolve(runtime.agents(admin)[0]!, 'synthetic');
    const results = await Promise.all([1, 2, 3].map(() => collectModelEvents(adapter.run(local, { timeout_ms: 2000 }))));
    assert.ok(results.every(events => events.at(-1)?.type === 'completed'));
    assert.equal(peak, 1);
    runtime.configureCompatibleParallel(admin, 3); peak = 0;
    await Promise.all([1, 2, 3].map(() => collectModelEvents(adapter.run(local, { timeout_ms: 2000 }))));
    assert.equal(peak, 3);
  } finally { runtime.close(); await fake.close(); rmSync(root, { recursive: true, force: true }); }
});

test('ready providers list only saved connections, so autonomous wakes never wait on a missing login', async () => {
  const root = mkdtempSync(join(tmpdir(), 'niwa-ready-providers-')); const runtime = new Runtime(root);
  const credentials = new MemoryCredentialStore();
  const subscription = new Subscription(credentials, () => {}, { fetch: async () => { throw new Error('No network in this test'); } });
  const gateway = new ModelGateway(runtime, fetch, subscription, new MemoryApiKeyStore());
  try {
    const admin = runtime.administrator();
    assert.deepEqual([...await gateway.readyProviders()], []);
    await gateway.configureCompatible({ url: 'http://127.0.0.1:1234/v1' });
    runtime.configureLocalLlm(admin, 'http://127.0.0.1:11434');
    await credentials.write(credential);
    assert.deepEqual([...await gateway.readyProviders()].sort(), ['local_llm', 'openai_compatible', 'openai_subscription']);
  } finally { await subscription.close(); runtime.close(); rmSync(root, { recursive: true, force: true }); }
});
