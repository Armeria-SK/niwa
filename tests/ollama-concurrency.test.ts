import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout } from 'node:timers/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OllamaAdapter, type OllamaSlot } from '../src/providers/ollama/adapter.ts';
import { OllamaLimiter } from '../src/providers/ollama/limiter.ts';
import { ModelGateway } from '../src/providers/gateway.ts';
import { Runtime } from '../src/runtime/runtime.ts';
import { collectModelEvents } from '../src/providers/shared/adapter.ts';
import { request } from './fixtures/model.ts';

async function slowOllama(handler: (index: number) => Promise<void>) {
  let started = 0; let inflight = 0; let peak = 0;
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    const index = ++started; peak = Math.max(peak, ++inflight);
    await handler(index); inflight--;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ done: true, message: { role: 'assistant', content: `reply ${index}` } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { url, stats: () => ({ started, peak }),
    close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }) };
}
const { reasoning_effort: _unused, ...localRequest } = request;
const local = { id: 'artificial', tools: false, thinking: false };
const slotsOf = (limiter: OllamaLimiter, limit: number): OllamaSlot => signal => limiter.acquire('endpoint', () => limit, signal);
const textOf = (events: readonly { type: string; text?: string }[]) => events.filter(e => e.type === 'text_delta').map(e => e.text).join('');

test('Ollama requests on one endpoint run one at a time and the HTTP timeout excludes the queue wait', async () => {
  const server = await slowOllama(async index => { await setTimeout(index === 1 ? 250 : 40); });
  try {
    const slot = slotsOf(new OllamaLimiter(), 1);
    const run = (timeout_ms: number) => collectModelEvents(new OllamaAdapter(server.url, local, fetch, slot).run(localRequest, { timeout_ms }));
    // The second request waits ~250ms for the first, longer than its own 150ms timeout, yet still completes.
    const first = run(1000); await setTimeout(20);
    const second = run(150); await setTimeout(20);
    const third = run(150);
    const events = await Promise.all([first, second, third]);
    assert.deepEqual(events.map(e => e.at(-1)?.type), ['completed', 'completed', 'completed']);
    assert.deepEqual(events.map(textOf), ['reply 1', 'reply 2', 'reply 3']);
    assert.equal(server.stats().peak, 1);
  } finally { await server.close(); }
});

test('Ollama limit of two allows two requests in flight', async () => {
  const server = await slowOllama(async () => { await setTimeout(60); });
  try {
    const slot = slotsOf(new OllamaLimiter(), 2);
    const events = await Promise.all([1, 2, 3].map(() => collectModelEvents(new OllamaAdapter(server.url, local, fetch, slot).run(localRequest, { timeout_ms: 2000 }))));
    assert.ok(events.every(e => e.at(-1)?.type === 'completed'));
    assert.equal(server.stats().peak, 2);
  } finally { await server.close(); }
});

test('an aborted Ollama waiter leaves the queue without consuming a slot', async () => {
  let open!: () => void; const gate = new Promise<void>(resolve => { open = resolve; });
  const server = await slowOllama(async index => { if (index === 1) await gate; });
  try {
    const slot = slotsOf(new OllamaLimiter(), 1);
    const adapter = () => new OllamaAdapter(server.url, local, fetch, slot);
    const first = collectModelEvents(adapter().run(localRequest, { timeout_ms: 2000 }));
    await setTimeout(30);
    const abort = new AbortController();
    const second = collectModelEvents(adapter().run(localRequest, { timeout_ms: 2000, signal: abort.signal }));
    await setTimeout(10);
    const third = collectModelEvents(adapter().run(localRequest, { timeout_ms: 2000 }));
    await setTimeout(30); abort.abort();
    assert.equal((await second).find(e => e.type === 'failed')?.error.code, 'ABORTED');
    open();
    assert.equal((await first).at(-1)?.type, 'completed');
    assert.equal(textOf(await third), 'reply 2');
    assert.deepEqual(server.stats(), { started: 2, peak: 1 });
    // Everything was released: the lane is free again.
    assert.equal((await collectModelEvents(adapter().run(localRequest, { timeout_ms: 2000 }))).at(-1)?.type, 'completed');
  } finally { open(); await server.close(); }
});

test('Ollama queue wait is bounded and a timed-out waiter sends nothing', async () => {
  let open!: () => void; const gate = new Promise<void>(resolve => { open = resolve; });
  const server = await slowOllama(async () => { await gate; });
  try {
    const slot = slotsOf(new OllamaLimiter(), 1);
    const first = collectModelEvents(new OllamaAdapter(server.url, local, fetch, slot).run(localRequest, { timeout_ms: 2000 }));
    await setTimeout(30);
    const waiting = await collectModelEvents(new OllamaAdapter(server.url, local, fetch, slot, 50).run(localRequest, { timeout_ms: 2000 }));
    const failure = waiting.find(e => e.type === 'failed');
    assert.equal(failure?.error.code, 'TIMED_OUT'); assert.equal(failure?.error.provider_request_sent, false);
    open(); assert.equal((await first).at(-1)?.type, 'completed');
    assert.equal(server.stats().started, 1);
  } finally { open(); await server.close(); }
});

test('the gateway reads the saved parallel limit and the setting persists', async () => {
  const root = mkdtempSync(join(tmpdir(), 'niwa-ollama-parallel-')); let runtime = new Runtime(root);
  let admin = runtime.administrator(); const leader = runtime.bootstrap(admin);
  try {
    assert.equal(runtime.modelSettings(admin).maxParallel, 1);
    for (const bad of [0, 9, 1.5, NaN]) assert.throws(() => runtime.configureOllamaParallel(admin, bad));
    runtime.configureOllama(admin, 'http://127.0.0.1:11434');
    runtime.setAgentModel(admin, leader.id, 'ollama', 'artificial', 'native');
    let inflight = 0; let peak = 0;
    const gateway = new ModelGateway(runtime, async url => {
      if (new URL(String(url)).pathname === '/api/show') return Response.json({ capabilities: ['completion'] });
      peak = Math.max(peak, ++inflight); await setTimeout(40); inflight--;
      return Response.json({ done: true, message: { role: 'assistant', content: 'ok' } });
    });
    const burst = async () => {
      peak = 0; const agent = runtime.agents(admin)[0]!;
      await Promise.all([1, 2, 3].map(async () => collectModelEvents((await gateway.resolve(agent, 'task')).run(localRequest, { timeout_ms: 2000 }))));
      return peak;
    };
    assert.equal(await burst(), 1);
    runtime.configureOllamaParallel(admin, 2);
    assert.equal(await burst(), 2);
    runtime.close(); runtime = new Runtime(root); admin = runtime.administrator();
    assert.equal(runtime.modelSettings(admin).maxParallel, 2);
  } finally { runtime.close(); rmSync(root, { recursive: true, force: true }); }
});
