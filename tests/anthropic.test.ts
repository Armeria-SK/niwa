import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { editSchema } from '../src/storage/database.ts';
import { AnthropicAdapter, ANTHROPIC_ORIGIN, anthropicModelProfile, listAnthropicModels, unlistedAnthropicModel } from '../src/providers/anthropic/adapter.ts';
import { collectModelEvents } from '../src/providers/shared/adapter.ts';
import type { ModelEvent, ModelOutputDelta, ModelRequest } from '../src/contracts/model.ts';
import { ModelSetupError } from '../src/providers/shared/setup-error.ts';
import { FileApiKeyStore, MemoryApiKeyStore } from '../src/auth/api-key.ts';
import { ModelGateway } from '../src/providers/gateway.ts';
import { Runtime } from '../src/runtime/runtime.ts';
import { TurnRunner } from '../src/runtime/turns.ts';
import { Subscription } from '../src/auth/subscription.ts';
import { MemoryCredentialStore } from '../src/auth/credential-store.ts';
import { WebAuth } from '../src/web/auth.ts';
import { createApiServer } from '../src/web/api.ts';
import { credential, request } from './fixtures/model.ts';

const KEY = 'sk-ant-api03-artificial-0123456789abcdef';
type Body = Record<string, unknown>;
interface Seen { method: string; path: string; key: string | undefined; auth: string | undefined; beta: string | undefined; body: Body | undefined }
type Handler = (req: IncomingMessage, body: Body | undefined, res: ServerResponse) => void | Promise<void>;
async function server(handler: Handler) {
  const seen: Seen[] = [];
  const http = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) as Body : undefined;
    seen.push({ method: req.method!, path: req.url!, key: req.headers['x-api-key'] as string | undefined, auth: req.headers.authorization, beta: req.headers['anthropic-beta'] as string | undefined, body });
    await handler(req, body, res);
  });
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  // The adapter always addresses the official API; only the transport is redirected to this local server.
  const transport: typeof fetch = (input, init) => fetch(String(input instanceof Request ? input.url : input).replace(ANTHROPIC_ORIGIN, url), init);
  return { url, seen, transport, messages: () => seen.filter(item => item.path.startsWith('/v1/messages')),
    close: () => new Promise<void>(resolve => { http.close(() => resolve()); http.closeAllConnections(); }) };
}
const json = (res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}) => {
  res.setHeader('content-type', 'application/json');
  for (const [name, item] of Object.entries(headers)) res.setHeader(name, item);
  res.statusCode = status; res.end(JSON.stringify(value));
};
type Block = { type: 'text'; text: string } | { type: 'thinking'; thinking: string; signature: string } | { type: 'redacted_thinking'; data: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } | { type: 'fallback'; from: { model: string }; to: { model: string } };
/** Streams a message as Messages API server-sent events, split into small deltas. */
function sse(res: ServerResponse, blocks: Block[], stop: string, model = 'claude-opus-5-5', usage = { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 5, cache_creation_input_tokens: 3 }) {
  res.setHeader('content-type', 'text/event-stream'); res.statusCode = 200;
  const send = (value: Record<string, unknown>) => res.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
  const pieces = (text: string) => text.match(/.{1,4}/gsu) ?? [];
  send({ type: 'message_start', message: { id: 'msg_artificial', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null,
    usage: { input_tokens: usage.input_tokens, output_tokens: 0, cache_read_input_tokens: usage.cache_read_input_tokens, cache_creation_input_tokens: usage.cache_creation_input_tokens } } });
  blocks.forEach((block, index) => {
    if (block.type === 'text') { send({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } }); for (const text of pieces(block.text)) send({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } }); }
    else if (block.type === 'thinking') { send({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } });
      for (const thinking of pieces(block.thinking)) send({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking } });
      send({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: block.signature } }); }
    else if (block.type === 'tool_use') { send({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
      for (const partial_json of pieces(JSON.stringify(block.input))) send({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json } }); }
    else send({ type: 'content_block_start', index, content_block: block });
    send({ type: 'content_block_stop', index });
  });
  send({ type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } });
  send({ type: 'message_stop' }); res.end();
}
const caps = (efforts: string[], adaptive = true) => ({ thinking: { supported: true, types: { adaptive: { supported: adaptive }, enabled: { supported: !adaptive }, disabled: { supported: false } } },
  effort: { supported: efforts.length > 0, low: { supported: efforts.includes('low') }, medium: { supported: efforts.includes('medium') }, high: { supported: efforts.includes('high') }, xhigh: { supported: efforts.includes('xhigh') }, max: { supported: efforts.includes('max') } } });
const ALL = ['low', 'medium', 'high', 'xhigh', 'max'];
const MODELS = [
  { type: 'model', id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5', created_at: '2025-10-01T00:00:00Z', lifecycle: 'active', max_tokens: 64000, max_input_tokens: 200000, capabilities: caps([], false) },
  { type: 'model', id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', created_at: '2026-09-01T00:00:00Z', lifecycle: 'active', max_tokens: 128000, max_input_tokens: 1000000, capabilities: caps(ALL) },
  { type: 'model', id: 'claude-opus-4-1', display_name: 'Claude Opus 4.1', created_at: '2025-08-05T00:00:00Z', lifecycle: 'retired', max_tokens: 32000, max_input_tokens: 200000, capabilities: caps([], false) },
  { type: 'model', id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5', created_at: '2026-10-01T00:00:00Z', lifecycle: 'active', max_tokens: 128000, max_input_tokens: 1000000, capabilities: caps(['low', 'medium', 'high']) },
];
/** Models API with cursor pagination (two per page). */
function models(req: IncomingMessage, res: ServerResponse, list = MODELS) {
  const after = new URL(req.url!, 'http://x').searchParams.get('after_id');
  const start = after ? list.findIndex(item => item.id === after) + 1 : 0; const page = list.slice(start, start + 2);
  json(res, 200, { data: page, has_more: start + 2 < list.length, first_id: page[0]?.id ?? null, last_id: page.at(-1)?.id ?? null });
}
const opus = anthropicModelProfile(MODELS[1]!);
const local: ModelRequest = (() => { const { reasoning_effort: _effort, ...rest } = request; return rest; })();
const tools = [{ name: 'remember', description: 'Remember', input_schema: { type: 'object', properties: { query: { type: 'string' } } } }];
const failureOf = (events: readonly ModelEvent[]) => { const event = events.find(item => item.type === 'failed'); assert.ok(event?.type === 'failed', JSON.stringify(events)); return event.error; };

test('model listing pages through the Models API newest first, skips retired models and maps a rejected key', async () => {
  const fake = await server((req, _body, res) => req.headers['x-api-key'] === KEY ? models(req, res) : json(res, 401, { type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key ${req.headers['x-api-key']}` } }));
  try {
    const listed = await listAnthropicModels(KEY, fake.transport);
    assert.deepEqual(listed.map(model => [model.id, model.display_name]), [['claude-sonnet-5-5', 'Claude Sonnet 5.5'], ['claude-opus-5-5', 'Claude Opus 5.5'], ['claude-haiku-4-5', 'Claude Haiku 4.5']]);
    assert.deepEqual(listed[0]!.efforts, ['low', 'medium', 'high']); assert.equal(listed[1]!.max_tokens, 64000); assert.equal(listed[1]!.context_window, 1000000);
    assert.equal(listed[2]!.adaptive, false); assert.deepEqual(listed[2]!.efforts, []);
    assert.equal(fake.seen.length, 2); assert.ok(fake.seen.every(item => item.method === 'GET' && item.path.startsWith('/v1/models') && item.key === KEY && item.auth === undefined));
    await assert.rejects(listAnthropicModels('sk-ant-wrong-key-000000', fake.transport), (error: unknown) =>
      error instanceof ModelSetupError && error.failure.code === 'AUTHENTICATION_FAILED' && !error.failure.retryable && !JSON.stringify(error.failure).includes('sk-ant-wrong'));
  } finally { await fake.close(); }
});

test('Claude API key file is private, bound to the official origin and never returned', async () => {
  const root = mkdtempSync(join(tmpdir(), 'niwa-anthropic-key-'));
  const runtime = new Runtime(join(root, 'state'));
  const store = new FileApiKeyStore(join(root, 'secrets', 'anthropic-key.json'));
  const gateway = new ModelGateway(runtime, fetch, undefined, undefined, { key: store });
  try {
    assert.deepEqual(await gateway.anthropicStatus(), { available: true, parallel: 2, keyConfigured: false, defaultModel: 'claude-opus-5-5' });
    assert.deepEqual(await gateway.checkAnthropic(), { ok: false, code: 'NOT_CONFIGURED', message: 'Claude（Anthropic API）のAPIキーを「設定」→「モデルと接続」で保存してください。' });
    await assert.rejects(gateway.configureAnthropic({ apiKey: 'has space' }), /Invalid/);
    await assert.rejects(gateway.configureAnthropic({ apiKey: KEY, parallel: 9 }), /Invalid/);
    assert.equal(await store.read(), undefined);
    const status = await gateway.configureAnthropic({ apiKey: KEY, parallel: 3 });
    assert.deepEqual(status, { available: true, parallel: 3, keyConfigured: true, defaultModel: 'claude-opus-5-5' });
    assert.ok(!JSON.stringify(status).includes(KEY));
    const file = join(root, 'secrets', 'anthropic-key.json');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { origin: 'https://api.anthropic.com', key: KEY });
    assert.ok(!readFileSync(join(root, 'state', 'control.db')).includes(KEY));
    // A key stored for another origin is never used for the Claude API.
    await store.write({ origin: 'https://example.com', key: KEY });
    assert.equal((await gateway.anthropicStatus()).keyConfigured, false);
    await gateway.configureAnthropic({ apiKey: KEY });
    assert.equal((await gateway.clearAnthropicKey()).keyConfigured, false);
    assert.equal(await store.read(), undefined);
    assert.equal((await new ModelGateway(runtime).anthropicStatus()).available, false);
  } finally { runtime.close(); rmSync(root, { recursive: true, force: true }); }
});

test('the catalog endpoint returns the listed models newest first with display names and supported efforts', async t => {
  const fake = await server((req, _body, res) => models(req, res));
  const root = mkdtempSync(join(tmpdir(), 'niwa-anthropic-web-'));
  const runtime = new Runtime(root); const admin = runtime.administrator(); runtime.bootstrap(admin);
  const key = randomBytes(32).toString('base64url'); const origin = 'https://niwa.test';
  const api = createApiServer(runtime, new WebAuth(origin, key), new ModelGateway(runtime, fake.transport, undefined, undefined, { key: new MemoryApiKeyStore() }));
  api.listen(0, '127.0.0.1'); await once(api, 'listening');
  t.after(async () => { await new Promise<void>(resolve => { api.close(() => resolve()); api.closeAllConnections(); }); runtime.close(); await fake.close(); rmSync(root, { recursive: true, force: true }); });
  let cookie = '';
  const call = (path: string, method = 'GET', body?: unknown) => new Promise<{ status: number; body: unknown; cookie?: string }>((resolve, reject) => {
    const text = body === undefined ? undefined : JSON.stringify(body);
    const outgoing = httpRequest(`http://127.0.0.1:${(api.address() as { port: number }).port}${path}`, { method, headers: { host: 'niwa.test', origin, cookie, 'content-type': 'application/json', ...(text ? { 'content-length': Buffer.byteLength(text) } : {}) } }, incoming => {
      const chunks: Buffer[] = []; incoming.on('data', chunk => chunks.push(Buffer.from(chunk)));
      incoming.on('end', () => resolve({ status: incoming.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'), ...(incoming.headers['set-cookie'] ? { cookie: incoming.headers['set-cookie'][0]!.split(';')[0]! } : {}) }));
    });
    outgoing.on('error', reject); outgoing.end(text);
  });
  cookie = (await call('/api/login', 'POST', { key })).cookie!;
  assert.equal(((await call('/api/anthropic/check', 'POST', {})).body as { code: string }).code, 'NOT_CONFIGURED');
  const saved = await call('/api/anthropic', 'PUT', { apiKey: KEY });
  assert.equal(saved.status, 200); assert.ok(!JSON.stringify(saved.body).includes(KEY)); assert.equal((saved.body as { keyConfigured: boolean }).keyConfigured, true);
  const catalog = await call('/api/anthropic/models');
  assert.equal(catalog.status, 200);
  assert.deepEqual((catalog.body as Record<string, unknown>[]).map(item => [item.model, item.display_name, item.provider, item.supported_efforts, item.default_effort]), [
    ['claude-sonnet-5-5', 'Claude Sonnet 5.5', 'anthropic', ['low', 'medium', 'high'], 'medium'],
    ['claude-opus-5-5', 'Claude Opus 5.5', 'anthropic', ALL, 'medium'],
    ['claude-haiku-4-5', 'Claude Haiku 4.5', 'anthropic', ['native'], 'native']]);
  assert.deepEqual((await call('/api/anthropic/check', 'POST', {})).body, { ok: true, models: 3 });
  assert.ok(fake.seen.every(item => item.method === 'GET' && item.path.startsWith('/v1/models')), 'checking the connection never requests a billed message');
  assert.equal((await call(`/api/agents/${runtime.agents(admin)[0]!.id}/model`, 'PUT', { provider: 'anthropic', model: 'claude-sonnet-5-5', reasoning: 'max' })).status, 400);
  assert.equal((await call(`/api/agents/${runtime.agents(admin)[0]!.id}/model`, 'PUT', { provider: 'anthropic', model: 'claude-sonnet-5-5', reasoning: 'high' })).status, 200);
  assert.deepEqual(runtime.agents(admin).map(agent => [agent.provider, agent.model, agent.reasoning]), [['anthropic', 'claude-sonnet-5-5', 'high']]);
  assert.equal((await call('/api/anthropic/key', 'DELETE', {})).status, 200);
  assert.equal(((await call('/api/anthropic')).body as { keyConfigured: boolean }).keyConfigured, false);
});

test('tool calls round-trip with thinking blocks replayed verbatim and the request carries the documented options', async () => {
  const signature = 'EqQBCkYIARgCKkD+artificial/signature==';
  const fake = await server((_req, body, res) => {
    const messages = body!.messages as { role: string; content: unknown }[];
    if (!JSON.stringify(messages).includes('tool_result')) {
      return sse(res, [{ type: 'thinking', thinking: '', signature }, { type: 'redacted_thinking', data: 'opaque-redacted' }, { type: 'text', text: '確認します。' },
        { type: 'tool_use', id: 'toolu_01Artificial', name: 'remember', input: { query: '人工の記憶' } }], 'tool_use');
    }
    sse(res, [{ type: 'thinking', thinking: '', signature: 'second' }, { type: 'text', text: '覚えました' }], 'end_turn');
  });
  try {
    const adapter = new AnthropicAdapter({ apiKey: KEY, fetch: fake.transport }, opus);
    assert.equal(adapter.capabilities.auth_mode, 'api_key'); assert.equal(adapter.capabilities.billing_mode, 'api_usage'); assert.equal(adapter.context_window, 1000000);
    const deltas: ModelOutputDelta[] = [];
    const first = await collectModelEvents(adapter.run({ ...local, tools, reasoning_effort: 'xhigh' }, { timeout_ms: 5000, on_delta: delta => deltas.push(delta) }));
    assert.deepEqual(first, [{ type: 'text_delta', text: '確認します。' }, { type: 'tool_call', tool_call_id: 'toolu_01Artificial', name: 'remember', arguments: { query: '人工の記憶' } },
      { type: 'usage', input_tokens: 19, output_tokens: 7, total_tokens: 26 }, { type: 'completed', finish_reason: 'tool_calls' }]);
    assert.equal(deltas.filter(delta => delta.channel === 'text').map(delta => delta.delta).join(''), '確認します。');
    const args = deltas.filter(delta => delta.channel === 'tool_arguments');
    assert.ok(args.length > 1 && args.every(delta => delta.channel === 'tool_arguments' && delta.call_id === 'toolu_01Artificial' && delta.name === 'remember'));
    assert.deepEqual(JSON.parse(args.map(delta => delta.delta).join('')), { query: '人工の記憶' });
    const sent = fake.messages()[0]!;
    assert.equal(sent.method, 'POST'); assert.equal(sent.path, '/v1/messages?beta=true'); assert.equal(sent.key, KEY); assert.equal(sent.auth, undefined);
    assert.deepEqual(sent.beta?.split(',').sort(), ['server-side-fallback-2026-07-01', 'thinking-binding-controls-2026-08-01']);
    const body = sent.body!;
    assert.equal(body.model, 'claude-opus-5-5'); assert.equal(body.stream, true); assert.equal(body.max_tokens, 64000);
    assert.equal(body.system, local.system_instructions);
    assert.deepEqual(body.cache_control, { type: 'ephemeral' });
    assert.deepEqual(body.thinking, { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } });
    assert.deepEqual(body.output_config, { effort: 'xhigh' });
    assert.equal(body.fallbacks, 'default');
    assert.deepEqual(body.tool_choice, { type: 'auto' });
    assert.deepEqual(body.tools, [{ name: 'remember', description: 'Remember', input_schema: tools[0]!.input_schema }]);
    for (const absent of ['temperature', 'top_p', 'top_k', 'betas']) assert.equal(body[absent], undefined, absent);
    assert.ok(!JSON.stringify(body).includes('eager_input_streaming'));
    assert.ok(!JSON.stringify(body).includes(KEY));

    const history: ModelRequest['messages'] = [...local.messages,
      { role: 'assistant', content: '確認します。', tool_calls: [{ tool_call_id: 'toolu_01Artificial', name: 'remember', arguments: { query: '人工の記憶' } }] },
      { role: 'tool', tool_call_id: 'toolu_01Artificial', name: 'remember', content: '{"id":"memory1"}' }, { role: 'user', content: '{"work_state":{}}' }];
    const second = await collectModelEvents(adapter.run({ ...local, tools, messages: history }, { timeout_ms: 5000 }));
    assert.deepEqual(second.filter(event => event.type !== 'usage'), [{ type: 'text_delta', text: '覚えました' }, { type: 'completed', finish_reason: 'stop' }]);
    const replay = fake.messages()[1]!.body!;
    assert.deepEqual(replay.output_config, { effort: 'medium' }, 'the level is sent explicitly even when the bot leaves it to Niwa');
    assert.deepEqual(replay.messages, [
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature }, { type: 'redacted_thinking', data: 'opaque-redacted' }, { type: 'text', text: '確認します。' },
        { type: 'tool_use', id: 'toolu_01Artificial', name: 'remember', input: { query: '人工の記憶' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01Artificial', content: '{"id":"memory1"}' }, { type: 'text', text: '{"work_state":{}}' }] }]);
    // A fresh adapter (after Niwa rebuilt its context) has no thinking to replay and sends the turn as plain blocks.
    await collectModelEvents(new AnthropicAdapter({ apiKey: KEY, fetch: fake.transport }, opus).run({ ...local, tools, messages: history }, { timeout_ms: 5000 }));
    assert.deepEqual((fake.messages()[2]!.body!.messages as { content: unknown }[])[1]!.content, [{ type: 'text', text: '確認します。' }, { type: 'tool_use', id: 'toolu_01Artificial', name: 'remember', input: { query: '人工の記憶' } }]);
  } finally { await fake.close(); }
});

test('models without adaptive thinking or server-side fallback get neither option and unanswered calls are closed', async () => {
  const fake = await server((_req, _body, res) => sse(res, [{ type: 'text', text: 'ok' }], 'end_turn', 'claude-haiku-4-5'));
  try {
    const haiku = anthropicModelProfile(MODELS[0]!);
    await collectModelEvents(new AnthropicAdapter({ apiKey: KEY, fetch: fake.transport }, haiku).run({ ...request, reasoning_effort: 'high' }, { timeout_ms: 5000 }));
    const body = fake.messages()[0]!.body!;
    for (const absent of ['thinking', 'output_config', 'fallbacks', 'tools', 'tool_choice']) assert.equal(body[absent], undefined, absent);
    assert.equal(fake.messages()[0]!.beta, undefined);
    const sonnet = anthropicModelProfile(MODELS[3]!);
    await collectModelEvents(new AnthropicAdapter({ apiKey: KEY, fetch: fake.transport, summary: true }, sonnet).run({ ...request, reasoning_effort: 'max', messages: [
      { role: 'user', content: 'Hello' }, { role: 'assistant', tool_calls: [{ tool_call_id: 'call.with:dots', name: 'remember', arguments: {} }, { tool_call_id: 'call_two', name: 'remember', arguments: {} }] },
      { role: 'tool', tool_call_id: 'call.with:dots', name: 'remember', content: 'done' }, { role: 'user', content: 'next' }] }, { timeout_ms: 5000 }));
    const next = fake.messages()[1]!.body!;
    assert.deepEqual(next.output_config, { effort: 'high' }, 'an unsupported level steps down');
    assert.equal(next.fallbacks, 'default');
    assert.deepEqual(next.thinking, { type: 'adaptive', display: 'summarized', block_binding: { prefix_mismatch_behavior: 'drop_block' } });
    const [, assistant, results] = next.messages as { content: Record<string, unknown>[] }[];
    const mapped = assistant!.content[0]!.id as string;
    assert.match(mapped, /^toolu_niwa_[0-9a-f]{32}$/);
    assert.deepEqual(results!.content, [{ type: 'tool_result', tool_use_id: mapped, content: 'done' },
      { type: 'tool_result', tool_use_id: 'call_two', is_error: true, content: 'このツール呼び出しは実行されませんでした。' }, { type: 'text', text: 'next' }]);
  } finally { await fake.close(); }
});

test('refusals, truncated tool calls and fallback switch points are handled before content is used', async () => {
  let reply: (res: ServerResponse) => void = res => sse(res, [], 'end_turn');
  const fake = await server((_req, _body, res) => reply(res));
  const adapter = new AnthropicAdapter({ apiKey: KEY, fetch: fake.transport }, opus);
  const run = () => collectModelEvents(adapter.run({ ...local, tools }, { timeout_ms: 5000 }));
  try {
    reply = res => sse(res, [{ type: 'text', text: '途中まで' }, { type: 'tool_use', id: 'toolu_refused', name: 'remember', input: { query: 'x' } }], 'refusal');
    let events = await run(); let error = failureOf(events);
    assert.equal(error.code, 'PROVIDER_ERROR'); assert.equal(error.retryable, false); assert.match(error.message, /安全上の理由/);
    assert.ok(!events.some(event => event.type === 'tool_call' || event.type === 'text_delta'));
    reply = res => sse(res, [{ type: 'tool_use', id: 'toolu_cut', name: 'remember', input: { query: '途中' } }], 'max_tokens');
    events = await run(); error = failureOf(events);
    assert.equal(error.code, 'OUTPUT_LIMIT'); assert.equal(error.retryable, false); assert.ok(!events.some(event => event.type === 'tool_call'));
    // Only text from before the last switch point is kept; the declined model's tool call and thinking are discarded.
    reply = res => sse(res, [{ type: 'thinking', thinking: '', signature: 'declined' }, { type: 'text', text: '前半' }, { type: 'tool_use', id: 'toolu_declined', name: 'remember', input: { query: 'no' } },
      { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-5' } }, { type: 'text', text: '後半' }, { type: 'tool_use', id: 'toolu_served', name: 'remember', input: { query: 'yes' } }], 'tool_use', 'claude-opus-5');
    events = await run();
    assert.deepEqual(events.filter(event => event.type === 'text_delta' || event.type === 'tool_call'), [{ type: 'text_delta', text: '前半後半' },
      { type: 'tool_call', tool_call_id: 'toolu_served', name: 'remember', arguments: { query: 'yes' } }]);
    reply = res => sse(res, [{ type: 'tool_use', id: 'toolu_secret', name: 'remember', input: { api_key: 'value' } }], 'tool_use');
    assert.equal(failureOf(await run()).code, 'INVALID_RESPONSE');
  } finally { await fake.close(); }
});

test('HTTP failures map to trusted classes with retry-after and never echo the key or response body', async () => {
  let reply: (res: ServerResponse) => void = res => json(res, 200, {});
  const fake = await server((_req, _body, res) => reply(res));
  const adapter = new AnthropicAdapter({ apiKey: KEY, fetch: fake.transport }, opus);
  const failure = async (input: ModelRequest = local, timeout = 5000) => {
    const events = await collectModelEvents(adapter.run(input, { timeout_ms: timeout }));
    assert.ok(!JSON.stringify(events).includes(KEY)); assert.ok(!JSON.stringify(events).includes('upstream secret'));
    return failureOf(events);
  };
  const error = (status: number, type: string, headers: Record<string, string> = {}) => (res: ServerResponse) => json(res, status, { type: 'error', error: { type, message: `upstream secret ${KEY}` } }, headers);
  try {
    reply = error(401, 'authentication_error'); let result = await failure();
    assert.equal(result.code, 'AUTHENTICATION_FAILED'); assert.equal(result.retryable, false); assert.match(result.message, /APIキー/);
    reply = error(403, 'permission_error'); assert.equal((await failure()).code, 'PERMISSION_DENIED');
    reply = error(404, 'not_found_error'); result = await failure(); assert.equal(result.code, 'INVALID_REQUEST'); assert.equal(result.retryable, false);
    reply = error(400, 'invalid_request_error'); result = await failure(); assert.equal(result.code, 'INVALID_REQUEST'); assert.equal(result.retryable, false);
    reply = error(402, 'billing_error'); assert.equal((await failure()).code, 'QUOTA_EXCEEDED');
    const before = Math.floor(Date.now() / 1000);
    reply = error(429, 'rate_limit_error', { 'retry-after': '30' }); result = await failure();
    assert.equal(result.code, 'RATE_LIMITED'); assert.equal(result.retryable, true); assert.ok(result.reset_at! >= before + 29 && result.reset_at! <= before + 32);
    reply = error(529, 'overloaded_error'); result = await failure(); assert.equal(result.code, 'PROVIDER_UNAVAILABLE'); assert.equal(result.retryable, true);
    reply = error(500, 'api_error'); assert.equal((await failure()).code, 'PROVIDER_UNAVAILABLE');
    // An error event inside an open stream.
    reply = res => { res.setHeader('content-type', 'text/event-stream'); res.end(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: `upstream secret ${KEY}` } })}\n\n`); };
    result = await failure(); assert.equal(result.code, 'PROVIDER_UNAVAILABLE'); assert.equal(result.retryable, true);
    reply = () => undefined;
    result = await failure(local, 100); assert.equal(result.code, 'TIMED_OUT'); assert.equal(result.retryable, true);
    reply = res => sse(res, [{ type: 'text', text: 'ok' }], 'end_turn');
    // A key pasted into the conversation is redacted before sending; the request itself goes through.
    const pasted = await collectModelEvents(adapter.run({ ...local, messages: [{ role: 'user', content: `my key is ${KEY}` }] }, { timeout_ms: 5000 }));
    assert.equal(pasted.at(-1)?.type, 'completed');
    // A key that does not look like a secret is still never sent inside the conversation.
    const plain = 'artificialplainkey0123456789', sent = fake.seen.length;
    result = failureOf(await collectModelEvents(new AnthropicAdapter({ apiKey: plain, fetch: fake.transport }, opus).run({ ...local, messages: [{ role: 'user', content: `copy ${plain}` }] }, { timeout_ms: 5000 })));
    assert.equal(result.code, 'INVALID_REQUEST'); assert.equal(result.provider_request_sent, false); assert.equal(fake.seen.length, sent); assert.ok(!result.message.includes(plain));
    assert.equal(failureOf(await collectModelEvents(adapter.run({ ...local, response_contract: { type: 'json_schema', name: 'x', schema: {}, strict: true } }, { timeout_ms: 5000 }))).code, 'CAPABILITY_MISMATCH');
    assert.ok(!JSON.stringify(fake.seen.map(item => item.body)).includes(KEY));
  } finally { await fake.close(); }
  const network = failureOf(await collectModelEvents(adapter.run(local, { timeout_ms: 5000 })));
  assert.equal(network.code, 'NETWORK_ERROR'); assert.equal(network.retryable, true);
});

test('bots run the Niwa tool loop on Claude and a typed model id is accepted only when listing fails for reasons other than the key', async () => {
  let listing: 'ok' | 'down' | 'reject' = 'ok';
  const fake = await server((req, body, res) => {
    if (req.url!.startsWith('/v1/models')) return listing === 'ok' ? models(req, res) : listing === 'down' ? json(res, 503, { type: 'error', error: { type: 'api_error', message: 'x' } }) : json(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'x' } });
    const names = (body!.tools as { name: string }[] | undefined)?.map(tool => tool.name) ?? [];
    if (names.length === 1 && names[0] === 'memory_review') return sse(res, [{ type: 'text', text: '{"memories":[]}' }], 'end_turn');
    if (!JSON.stringify(body!.messages).includes('tool_result')) return sse(res, [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'tool_use', id: 'toolu_search', name: 'memory_search', input: { query: '人工' } }], 'tool_use');
    sse(res, [{ type: 'text', text: '記憶を確認して回答しました' }], 'end_turn');
  });
  const root = mkdtempSync(join(tmpdir(), 'niwa-anthropic-turn-')); const runtime = new Runtime(root);
  try {
    const admin = runtime.administrator(); const leader = runtime.bootstrap(admin);
    const gateway = new ModelGateway(runtime, fake.transport, undefined, undefined, { key: new MemoryApiKeyStore() });
    await assert.rejects(gateway.selectAnthropic(leader.id, 'claude-opus-5-5', 'high'), (error: unknown) => error instanceof ModelSetupError && error.failure.code === 'AUTH_UNAVAILABLE');
    await gateway.configureAnthropic({ apiKey: KEY });
    await assert.rejects(gateway.selectAnthropic(leader.id, 'claude-missing', 'medium'), /not available/);
    await assert.rejects(gateway.selectAnthropic(leader.id, 'claude-haiku-4-5', 'high'), /reasoning effort/);
    const selected = await gateway.selectAnthropic(leader.id, 'claude-opus-5-5', 'high');
    assert.deepEqual([selected.provider, selected.model, selected.reasoning], ['anthropic', 'claude-opus-5-5', 'high']);
    const room = runtime.createRoom(admin, 'Claude');
    runtime.tasks.create(admin, leader.id, room.id, '回答してください');
    await new TurnRunner(runtime, gateway.resolve).run(runtime.tasks.claim(admin)!);
    assert.equal(runtime.messages(admin, room.id).at(-1)?.body, '記憶を確認して回答しました');
    assert.equal(runtime.modelRoutes(admin)[0]!.provider, 'anthropic');
    const calls = fake.messages();
    assert.ok(calls.length >= 2 && calls.every(item => item.key === KEY && (item.body!.output_config as { effort: string }).effort === 'high'), 'the bot setting becomes output_config.effort');
    const final = calls.at(-1)!.body!.messages as { role: string; content: { type: string; signature?: string }[] }[];
    assert.ok(final.some(message => message.role === 'assistant' && message.content[0]?.type === 'thinking' && message.content[0].signature === 'sig'), 'the tool loop replays the thinking block');
    listing = 'down';
    const typed = await gateway.selectAnthropic(leader.id, 'claude-future-model', 'medium');
    assert.equal(typed.model, 'claude-future-model');
    listing = 'reject';
    await assert.rejects(gateway.selectAnthropic(leader.id, 'claude-other', 'medium'), (error: unknown) => error instanceof ModelSetupError && error.failure.code === 'AUTHENTICATION_FAILED');
    assert.ok(!readFileSync(join(root, 'control.db')).includes(KEY));
  } finally { runtime.close(); await fake.close(); rmSync(root, { recursive: true, force: true }); }
});

test('subscription quota can switch to a Claude fallback model with the bot effort and parallel limit', async () => {
  let active = 0, peak = 0;
  const fake = await server(async (req, body, res) => {
    if (req.url!.startsWith('/v1/models')) return models(req, res);
    active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 20)); active--;
    const names = (body!.tools as { name: string }[] | undefined)?.map(tool => tool.name) ?? [];
    sse(res, [{ type: 'text', text: names.length === 1 && names[0] === 'memory_review' ? '{"memories":[]}' : 'Claudeで継続' }], 'end_turn');
  });
  const root = mkdtempSync(join(tmpdir(), 'niwa-anthropic-fallback-')); const runtime = new Runtime(root);
  const credentials = new MemoryCredentialStore(); await credentials.write(credential);
  let primary = 0;
  const transport: typeof fetch = async (url, init) => {
    if (String(url).startsWith(ANTHROPIC_ORIGIN)) return fake.transport(url, init);
    if (String(url).includes('/models')) return Response.json({ models: [{ slug: 'artificial-model', supported_reasoning_levels: [{ effort: 'low' }], visibility: 'list' }] });
    primary++;
    return Response.json({ error: { type: 'usage_limit_reached', resets_at: Math.floor(Date.now() / 1000) + 3600 } }, { status: 429 });
  };
  const subscription = new Subscription(credentials, () => {}, { fetch: transport });
  try {
    const admin = runtime.administrator(); const leader = runtime.bootstrap(admin);
    const gateway = new ModelGateway(runtime, transport, subscription, undefined, { key: new MemoryApiKeyStore() });
    await gateway.configureAnthropic({ apiKey: KEY, parallel: 1 });
    await assert.rejects(gateway.selectFallback('claude-missing', 'anthropic'), /not available/);
    const settings = await gateway.selectFallback('claude-opus-5-5', 'anthropic');
    assert.equal(settings.fallbackProvider, 'anthropic'); assert.equal(settings.fallbackModel, 'claude-opus-5-5');
    runtime.setAgentModel(admin, leader.id, 'openai_subscription', 'artificial-model', 'low');
    const room = runtime.createRoom(admin, '切替');
    runtime.tasks.create(admin, leader.id, room.id, '回答してください');
    await new TurnRunner(runtime, gateway.resolve).run(runtime.tasks.claim(admin)!);
    assert.equal(primary, 1);
    assert.equal(runtime.tasks.list(admin)[0]!.result, 'Claudeで継続');
    assert.deepEqual([runtime.modelRoutes(admin)[0]!.provider, runtime.modelRoutes(admin)[0]!.reason], ['anthropic', 'quota']);
    assert.ok(fake.messages().every(item => (item.body!.output_config as { effort: string }).effort === 'low'));
    // The per-endpoint limit serializes requests.
    runtime.setAgentModel(admin, leader.id, 'anthropic', 'claude-opus-5-5', 'medium'); peak = 0;
    const adapter = await gateway.resolve(runtime.agents(admin)[0]!, 'synthetic');
    await Promise.all([1, 2, 3].map(() => collectModelEvents(adapter.run(local, { timeout_ms: 5000 }))));
    assert.equal(peak, 1);
    runtime.configureAnthropicParallel(admin, 3); peak = 0;
    await Promise.all([1, 2, 3].map(() => collectModelEvents(adapter.run(local, { timeout_ms: 5000 }))));
    assert.equal(peak, 3);
    assert.equal(unlistedAnthropicModel('x').max_tokens, 64000);
  } finally { await subscription.close(); runtime.close(); await fake.close(); rmSync(root, { recursive: true, force: true }); }
});

test('upgrading a schema51 database widens the provider and fallback constraints in place', () => {
  const root = mkdtempSync(join(tmpdir(), 'niwa-anthropic-upgrade-')); let runtime = new Runtime(root);
  try {
    let admin = runtime.administrator(); const leader = runtime.bootstrap(admin); const member = runtime.createAgent(runtime.agentSession(leader.id), '既存Bot');
    runtime.configureCompatible(admin, 'https://api.openai.com/v1'); runtime.configureFallback(admin, 'https://api.openai.com/v1', 'artificial-remote', 'openai_compatible');
    runtime.close();
    const db = new DatabaseSync(join(root, 'control.db'));
    const sql = (name: string) => String(db.prepare('SELECT sql FROM sqlite_schema WHERE name=?').get(name)!.sql);
    const version = Number(db.prepare('PRAGMA schema_version').get()!.schema_version);
    db.exec('BEGIN;');
    editSchema(db, () => {
      db.prepare("UPDATE sqlite_schema SET sql=? WHERE name='agents'").run(sql('agents').replace(",'anthropic'", '').replace("'local_llm'", "'ollama'"));
      db.prepare("UPDATE sqlite_schema SET sql=? WHERE name='model_settings'").run(sql('model_settings').replaceAll("'local_llm'", "'ollama'").replace(",'anthropic'", ''));
      db.exec(`PRAGMA schema_version=${version + 1}`);
    });
    db.exec('COMMIT;');
    db.exec('ALTER TABLE model_settings RENAME COLUMN local_llm_url TO ollama_url; ALTER TABLE model_settings DROP COLUMN anthropic_parallel; PRAGMA user_version=51;');
    assert.doesNotMatch(sql('agents') + sql('model_settings'), /anthropic/);
    const before = JSON.stringify(db.prepare('SELECT * FROM agents ORDER BY id').all());
    const autonomy = db.prepare('SELECT count(*) AS count FROM agent_autonomy').get()!.count;
    db.close();
    runtime = new Runtime(root); admin = runtime.administrator();
    const after = new DatabaseSync(join(root, 'control.db'));
    try {
      assert.equal(after.prepare('PRAGMA user_version').get()!.user_version, 58);
      assert.equal(JSON.stringify(after.prepare('SELECT * FROM agents ORDER BY id').all()), before);
      assert.equal(after.prepare('SELECT count(*) AS count FROM agent_autonomy').get()!.count, autonomy);
      assert.match(String(after.prepare("SELECT sql FROM sqlite_schema WHERE name='agents'").get()!.sql), /'openai_compatible','anthropic'/);
      assert.equal(after.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
    } finally { after.close(); }
    assert.deepEqual(runtime.modelSettings(admin), { localLlmUrl: null, fallbackModel: 'artificial-remote', maxParallel: 1, fallbackProvider: 'openai_compatible', compatibleUrl: 'https://api.openai.com/v1', compatibleParallel: 2, anthropicParallel: 2 });
    runtime.setAgentModel(admin, member.id, 'anthropic', 'claude-opus-5-5', 'medium');
    runtime.configureFallback(admin, ANTHROPIC_ORIGIN, 'claude-opus-5-5', 'anthropic');
    assert.equal(runtime.modelSettings(admin).fallbackProvider, 'anthropic');
    const check = new DatabaseSync(join(root, 'control.db'));
    try {
      assert.throws(() => check.prepare("UPDATE agents SET provider='bogus'").run(), /CHECK/);
      assert.throws(() => check.prepare("UPDATE model_settings SET fallback_provider='bogus'").run(), /CHECK/);
      assert.throws(() => check.prepare('UPDATE model_settings SET anthropic_parallel=9').run(), /CHECK/);
    } finally { check.close(); }
  } finally { runtime.close(); rmSync(root, { recursive: true, force: true }); }
});
