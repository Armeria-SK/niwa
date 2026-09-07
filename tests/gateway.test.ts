import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout } from 'node:timers/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Runtime } from '../src/runtime/runtime.ts';
import { ModelGateway } from '../src/providers/gateway.ts';
import { initializeInstallation } from '../src/config/installation.ts';
import { startService } from '../src/runtime/service.ts';
import { Subscription } from '../src/auth/subscription.ts';
import { MemoryCredentialStore } from '../src/auth/credential-store.ts';
import { credential, response } from './fixtures/model.ts';
import { TurnRunner } from '../src/runtime/turns.ts';
import { DatabaseSync } from 'node:sqlite';

test('quota switches to the configured local model and a later successful probe restores the configured subscription', async () => {
  const root = mkdtempSync(join(tmpdir(), 'niwa-quota-route-')); let runtime = new Runtime(root);
  const store = new MemoryCredentialStore(); await store.write(credential);
  let primaryCalls = 0, localCalls = 0, limited = true;
  const transport: typeof fetch = async url => {
    const path = String(url);
    if (path.includes('/models')) return Response.json({ models: [{ slug: 'artificial-model', display_name: 'Artificial', supported_reasoning_levels: [{ effort: 'low' }], visibility: 'list' }] });
    if (path.endsWith('/api/show')) return Response.json({ capabilities: ['completion', 'tools'] });
    if (path.endsWith('/api/chat')) { localCalls++; return Response.json({ done: true, message: { role: 'assistant', content: '指定ローカルで継続' } }); }
    primaryCalls++;
    return limited ? Response.json({ error: { type: 'usage_limit_reached', resets_at: Math.floor(Date.now() / 1000) + 3600 } }, { status: 429 }) : response('サブスクへ復帰');
  };
  const subscription = new Subscription(store, () => {}, { fetch: transport });
  try {
    let admin = runtime.administrator(); const leader = runtime.bootstrap(admin); const room = runtime.createRoom(admin, '切替確認');
    assert.equal(runtime.modelRoutes(admin)[0]!.attempted_at, null);
    assert.throws(() => runtime.modelRoutes(runtime.agentSession(leader.id)), /Administrator/);
    assert.throws(() => runtime.recordModelRoute(runtime.agentSession(leader.id), leader.id, 'ollama', 'forged', 'quota'), /Administrator/);
    assert.equal(runtime.modelRoutes(admin)[0]!.attempted_at, null);
    assert.throws(() => runtime.modelRoutes(runtime.agentSession(leader.id)), /Administrator/);
    assert.throws(() => runtime.recordModelRoute(runtime.agentSession(leader.id), leader.id, 'ollama', 'forged', 'quota'), /Administrator/);
    runtime.configureOllama(admin, 'http://127.0.0.1:11434'); runtime.configureFallback(admin, 'http://127.0.0.1:11434', 'artificial-local');
    runtime.setAgentModel(admin, leader.id, 'openai_subscription', 'artificial-model', 'low');
    let gateway = new ModelGateway(runtime, transport, subscription);
    runtime.tasks.create(admin, leader.id, room.id, '回答してください');
    await new TurnRunner(runtime, gateway.resolve).run(runtime.tasks.claim(admin)!);
    assert.equal(runtime.tasks.list(admin)[0]!.result, '指定ローカルで継続');
    assert.equal(primaryCalls, 1); assert.equal(localCalls, 1);
    assert.equal(runtime.modelRoutes(admin)[0]!.reason, 'quota');
    assert.equal(runtime.modelRoutes(admin)[0]!.model, 'artificial-local');
    assert.equal(runtime.modelRoutes(admin)[0]!.configured_model, 'artificial-model');
    runtime.close(); runtime = new Runtime(root); admin = runtime.administrator(); gateway = new ModelGateway(runtime, transport, subscription);
    assert.equal(runtime.modelRoutes(admin)[0]!.model, 'artificial-local');
    runtime.tasks.create(admin, leader.id, room.id, '再起動後の続き');
    await new TurnRunner(runtime, gateway.resolve).run(runtime.tasks.claim(admin)!);
    assert.equal(primaryCalls, 1); assert.equal(localCalls, 2);
    const db = new DatabaseSync(join(root, 'control.db')); db.exec('UPDATE provider_limits SET next_probe_at=0;'); db.close();
    limited = false;
    runtime.tasks.create(admin, leader.id, room.id, '回復後の仕事');
    await new TurnRunner(runtime, gateway.resolve).run(runtime.tasks.claim(admin)!);
    assert.equal(primaryCalls, 2); assert.equal(localCalls, 2);
    assert.equal(runtime.tasks.list(admin).at(-1)!.result, 'サブスクへ復帰');
    assert.equal(runtime.agents(admin)[0]!.model, 'artificial-model');
    assert.equal(runtime.modelRoutes(admin)[0]!.provider, 'openai_subscription');
    assert.equal(runtime.modelRoutes(admin)[0]!.reason, 'configured');
    assert.equal(runtime.modelRoutes(admin)[0]!.model, 'artificial-model');
  } finally { await subscription.close(); runtime.close(); rmSync(root, { recursive: true, force: true }); }
});

test('ordinary 429 does not select fallback and quota without a selected fallback waits', async () => {
  const root = mkdtempSync(join(tmpdir(), 'niwa-quota-wait-')); const runtime = new Runtime(root);
  const store = new MemoryCredentialStore(); await store.write(credential);
  let quota = false, localCalls = 0;
  const transport: typeof fetch = async url => {
    if (String(url).includes('/models')) return Response.json({ models: [{ slug: 'artificial-model', display_name: 'Artificial', supported_reasoning_levels: [{ effort: 'low' }], visibility: 'list' }] });
    if (String(url).includes('127.0.0.1')) { localCalls++; throw new Error('Local transport must not be called'); }
    return Response.json({ error: { type: quota ? 'usage_limit_reached' : 'rate_limit_exceeded' } }, { status: 429 });
  };
  const subscription = new Subscription(store, () => {}, { fetch: transport });
  try {
    const admin = runtime.administrator(); const leader = runtime.bootstrap(admin); const room = runtime.createRoom(admin, '待機確認');
    runtime.setAgentModel(admin, leader.id, 'openai_subscription', 'artificial-model', 'low');
    runtime.configureOllama(admin, 'http://127.0.0.1:11434'); runtime.configureFallback(admin, 'http://127.0.0.1:11434', 'artificial-local');
    const gateway = new ModelGateway(runtime, transport, subscription);
    runtime.tasks.create(admin, leader.id, room.id, '通信制限');
    await new TurnRunner(runtime, gateway.resolve).run(runtime.tasks.claim(admin)!);
    assert.match(runtime.tasks.list(admin)[0]!.wait_reason!, /RATE_LIMITED/); assert.equal(localCalls, 0);
    quota = true; runtime.configureFallback(admin, 'http://127.0.0.1:11434', null);
    runtime.tasks.create(admin, leader.id, room.id, '上限到達');
    await new TurnRunner(runtime, gateway.resolve).run(runtime.tasks.claim(admin)!);
    assert.match(runtime.tasks.list(admin).at(-1)!.wait_reason!, /QUOTA_EXCEEDED/); assert.equal(localCalls, 0);
  } finally { await subscription.close(); runtime.close(); rmSync(root, { recursive: true, force: true }); }
});

test('fallback selection persists independently and rejects remote, incapable and stale models', async () => {
  const root = mkdtempSync(join(tmpdir(), 'niwa-fallback-')); let runtime = new Runtime(root);
  try {
    let admin = runtime.administrator(); const leader = runtime.bootstrap(admin);
    runtime.configureOllama(admin, 'http://127.0.0.1:11434');
    let tools = false; let remote = false; let change = false;
    const gateway = new ModelGateway(runtime, async url => {
      if (String(url).endsWith('/tags')) return Response.json({ models: [{ name: 'artificial-local' }] });
      if (change) runtime.configureOllama(admin, 'http://127.0.0.1:11435');
      return Response.json({ capabilities: ['completion', ...(tools ? ['tools'] : [])], ...(remote ? { remote_host: 'cloud' } : {}) });
    });
    await assert.rejects(gateway.selectFallback('missing'), /not installed/);
    await assert.rejects(gateway.selectFallback('artificial-local'), /support tools/);
    tools = true; remote = true;
    await assert.rejects(gateway.selectFallback('artificial-local'), /local/);
    remote = false; change = true;
    await assert.rejects(gateway.selectFallback('artificial-local'), /changed/);
    change = false;
    await gateway.selectFallback('artificial-local');
    assert.equal(runtime.agents(admin)[0]?.model, leader.model);
    assert.throws(() => runtime.configureFallback(runtime.agentSession(leader.id), 'http://127.0.0.1:11435', null));
    runtime.close(); runtime = new Runtime(root); admin = runtime.administrator();
    assert.equal(runtime.modelSettings(admin).fallbackModel, 'artificial-local');
    runtime.configureOllama(admin, 'http://127.0.0.1:11435');
    assert.equal(runtime.modelSettings(admin).fallbackModel, 'artificial-local');
    await new ModelGateway(runtime).selectFallback(null);
    assert.equal(runtime.modelSettings(admin).fallbackModel, null);
    runtime.configureFallback(admin, 'http://127.0.0.1:11435', 'artificial-local');
    runtime.configureOllama(admin, 'http://127.0.0.1:11436');
    assert.equal(runtime.modelSettings(admin).fallbackModel, null);
  } finally { runtime.close(); rmSync(root, { recursive: true, force: true }); }
});

test('gateway rejects absent and remote models and configuration changes during selection', async () => {
  const root = mkdtempSync(join(tmpdir(), 'niwa-gateway-')); const runtime = new Runtime(root);
  try {
    const admin = runtime.administrator(); const leader = runtime.bootstrap(admin);
    runtime.configureOllama(admin, 'http://127.0.0.1:11434');
    let remote = true; let change = false;
    const gateway = new ModelGateway(runtime, async url => {
      if (String(url).endsWith('/tags')) return Response.json({ models: [{ name: 'artificial' }] });
      if (change) runtime.configureOllama(admin, 'http://127.0.0.1:11435');
      return Response.json({ capabilities: ['completion', 'tools'], ...(remote ? { remote_host: 'artificial-cloud' } : {}) });
    });
    await assert.rejects(gateway.select(leader.id, 'not-installed'), /not installed/);
    await assert.rejects(gateway.select(leader.id, 'artificial'), /local/);
    assert.equal(runtime.agents(admin)[0]?.provider, 'openai_subscription');
    remote = false; change = true;
    await assert.rejects(gateway.select(leader.id, 'artificial'), /changed/);
    assert.equal(runtime.agents(admin)[0]?.provider, 'openai_subscription');
    change = false;
    const selected = await gateway.select(leader.id, 'artificial');
    assert.equal(selected.provider, 'ollama'); assert.equal(selected.reasoning, 'native');
    assert.throws(() => runtime.configureOllama(admin, 'file:///private'), /Invalid/);
  } finally { runtime.close(); rmSync(root, { recursive: true, force: true }); }
});

test('subscription gateway validates catalog selection, runs a response and invalidates work on logout', async () => {
  const root = mkdtempSync(join(tmpdir(), 'niwa-subscription-')); const runtime = new Runtime(root);
  const admin = runtime.administrator(); const leader = runtime.bootstrap(admin); const store = new MemoryCredentialStore();
  await store.write(credential);
  const transport: typeof fetch = async url => String(url).includes('/models') ? Response.json({ models: [{ slug: 'artificial-model', visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }] }] }) : response('サブスク経路の人工応答');
  const subscription = new Subscription(store, () => runtime.invalidateProvider(admin, 'openai_subscription'), { fetch: transport });
  const gateway = new ModelGateway(runtime, transport, subscription);
  try {
    await assert.rejects(gateway.selectSubscription(leader.id, 'missing', 'low'), /unavailable/);
    await assert.rejects(gateway.selectSubscription(leader.id, 'artificial-model', 'max'), /unavailable/);
    await gateway.selectSubscription(leader.id, 'artificial-model', 'low');
    const room = runtime.createRoom(admin, '接続試験'); runtime.tasks.create(admin, leader.id, room.id, '回答');
    await new TurnRunner(runtime, gateway.resolve).run(runtime.tasks.claim(admin)!);
    assert.equal(runtime.messages(admin, room.id)[0]?.body, 'サブスク経路の人工応答');
    runtime.tasks.create(admin, leader.id, room.id, '中断する仕事'); const lease = runtime.tasks.claim(admin)!;
    await subscription.logout(); assert.equal(runtime.tasks.active(runtime.agentSession(leader.id), lease), false);
    await assert.rejects(gateway.resolve(runtime.agents(admin)[0]!, lease.task.id), /login is required/);
  } finally { await subscription.close(); runtime.close(); rmSync(root, { recursive: true, force: true }); }
});

test('default service resolver uses the saved Ollama endpoint and runs its model tool loop', async () => {
  const root = mkdtempSync(join(tmpdir(), 'niwa-ollama-service-'));
  const requests: string[] = [];
  const provider = createServer(async (req, res) => {
    requests.push(req.url!); res.setHeader('content-type', 'application/json');
    if (req.url === '/api/tags') { res.end(JSON.stringify({ models: [{ name: 'artificial' }] })); return; }
    if (req.url === '/api/show') { res.end(JSON.stringify({ capabilities: ['completion', 'tools'] })); return; }
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assert.equal(body.model, 'artificial'); assert.equal(body.stream, false);
    const hasResult = body.messages.some((message: { role: string }) => message.role === 'tool');
    res.end(JSON.stringify({ done: true, done_reason: 'stop', message: { role: 'assistant',
      content: hasResult ? '記憶を確認して回答しました' : '',
      ...(!hasResult ? { tool_calls: [{ function: { name: 'memory_search', arguments: { query: '人工' } } }] } : {}),
    } }));
  });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  const url = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;
  initializeInstallation(root, { version: 1, origin: 'https://niwa.test', port: 3210 });
  let service = await startService(root, undefined, 0);
  try {
    const admin = service.runtime.administrator(); const leader = service.runtime.agents(admin)[0]!;
    service.runtime.configureOllama(admin, url);
    await new ModelGateway(service.runtime).select(leader.id, 'artificial');
    const room = service.runtime.createRoom(admin, '庭');
    const task = service.runtime.tasks.create(admin, leader.id, room.id, '回答してください');
    for (let i = 0; i < 100 && service.runtime.tasks.get(admin, task.id).state !== 'completed'; i++) await setTimeout(20);
    assert.equal(service.runtime.tasks.get(admin, task.id).state, 'completed');
    assert.equal(service.runtime.messages(admin, room.id)[0]?.body, '記憶を確認して回答しました');
    assert.equal(requests.filter(path => path === '/api/chat').length, 2);
    await service.close(); service = await startService(root, undefined, 0);
    const nextAdmin = service.runtime.administrator();
    assert.equal(service.runtime.modelSettings(nextAdmin).ollamaUrl, url);
    assert.equal(service.runtime.agents(nextAdmin)[0]?.model, 'artificial');
  } finally {
    await service.close(); await new Promise<void>(resolve => { provider.close(() => resolve()); provider.closeAllConnections(); });
    rmSync(root, { recursive: true, force: true });
  }
});
