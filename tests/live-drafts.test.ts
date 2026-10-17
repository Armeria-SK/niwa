import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { JsonStringFieldStream } from '../src/shared/json-string-field.ts';
import { LiveUpdates, DraftComposer, displayDraft, DRAFT_MAX_CHARS, type LiveEvent } from '../src/runtime/live.ts';
import { Runtime } from '../src/runtime/runtime.ts';
import { TurnRunner } from '../src/runtime/turns.ts';
import { WebAuth } from '../src/web/auth.ts';
import { createApiServer } from '../src/web/api.ts';
import { LiveStreams, MAX_STREAMS } from '../src/web/live-stream.ts';
import { MemoryCredentialStore } from '../src/auth/credential-store.ts';
import { OpenAISubscriptionAdapter, openAISubscriptionAdapterCapabilities } from '../src/providers/codex/adapter.ts';
import { collectModelEvents, type ModelAdapter } from '../src/providers/shared/adapter.ts';
import type { ModelEvent, ModelOutputDelta } from '../src/contracts/model.ts';
import { credential, profile, request, frame } from './fixtures/model.ts';

const extract = (chunks: string[], field = 'body', max?: number) => { const stream = new JsonStringFieldStream(field, max); for (const chunk of chunks) stream.push(chunk); return stream; };

test('incremental field extraction matches JSON.parse at every chunk boundary, including escapes and \\u sequences', () => {
  const values = ['こんにちは\n"引用"\\tタブ\t/斜線 😀 \u00e9', 'a\u2028b\u0000c', ''];
  for (const value of values) {
    const json = JSON.stringify({ recipient_ids: ['x', { body: 'nested-decoy' }], note: 'body', body: value, after: { body: 'later-nested' } })
      .replace('😀', '\\ud83d\\ude00').replace('é', '\\u00E9');
    assert.equal(JSON.parse(json).body, value);
    for (let cut = 0; cut <= json.length; cut++) for (const second of [cut, Math.min(json.length, cut + 3)]) {
      const stream = extract([json.slice(0, cut), json.slice(cut, second), json.slice(second)]);
      assert.equal(stream.value, value, `split at ${cut}/${second}`); assert.equal(stream.complete, true);
    }
    // Byte-per-byte progress is always a prefix of the final value and never shows a lone high surrogate.
    const stream = new JsonStringFieldStream('body');
    for (const character of json) { stream.push(character); assert.ok(value.startsWith(stream.value)); assert.doesNotMatch(stream.value, /[\uD800-\uDBFF]$/u); }
  }
});

test('incremental field extraction handles partial, escaped keys, non-string values, duplicates, limits and invalid input', () => {
  const partial = extract(['{"body":"途中まで\\', 'n書い']);
  assert.equal(partial.value, '途中まで\n書い'); assert.equal(partial.complete, false); assert.equal(partial.found, true);
  assert.equal(extract(['{"bo\\u0064y":"escaped key"}']).value, 'escaped key');
  assert.equal(extract(['{"body":123,"x":"y"}']).found, false);
  assert.equal(extract(['{"body":{"body":"nested"}}']).found, false);
  assert.equal(extract(['{"body":"first","body":"last"}']).value, 'last');
  const limited = extract([JSON.stringify({ body: 'x'.repeat(50) })], 'body', 10);
  assert.equal(limited.value, 'x'.repeat(10)); assert.equal(limited.truncated, true);
  assert.equal(extract(['["body"]']).invalid, true);
  assert.equal(extract(['{"body":"bad \\q escape"}']).invalid, true);
  assert.equal(extract(['{"body":"\\u12G4"}']).invalid, true);
  assert.throws(() => new JsonStringFieldStream(''));
});

test('draft composer shows a conversation_send body, plain text, or nothing for other tools', () => {
  const send = new DraftComposer();
  send.push({ channel: 'text', delta: '内部の前置き' });
  send.push({ channel: 'tool_arguments', call_id: 'c1', name: 'conversation_send', delta: '{"recipient_ids":[],"bo' });
  send.push({ channel: 'tool_arguments', call_id: 'c1', delta: 'dy":"返答\\u3067' });
  assert.equal(send.text, '返答で');
  const plain = new DraftComposer(); plain.push({ channel: 'text', delta: 'そのまま' }); assert.equal(plain.text, 'そのまま');
  const other = new DraftComposer(); other.push({ channel: 'text', delta: '調べます' });
  other.push({ channel: 'tool_arguments', call_id: 'c2', name: 'web_search', delta: '{"query":"秘密ではない"}' });
  assert.equal(other.text, '');
  const long = new DraftComposer(); long.push({ channel: 'text', delta: 'あ'.repeat(DRAFT_MAX_CHARS + 10) });
  assert.equal(long.text.length, DRAFT_MAX_CHARS); assert.equal(long.truncated, true);
  // A partially streamed token is held back until a boundary, then redacted as a whole.
  assert.equal(displayDraft('鍵はsk-proj-abc'), '鍵は');
  assert.doesNotMatch(displayDraft('api_key="sk-abcdefghijklmnopqrstuvwxyz0123456789 です'), /abcdefghijklmnop/u);
});

test('live drafts are throttled, bounded, ephemeral and closed exactly once', async () => {
  const live = new LiveUpdates(); const events: LiveEvent[] = []; const stop = live.subscribe(event => events.push(event));
  const draft = live.open({ room_id: 'r', agent_id: 'a', task_id: 't' });
  for (let index = 0; index < 200; index++) draft.push({ channel: 'text', delta: 'あ' });
  assert.equal(events.length, 1, 'the first delta is shown at once, the rest wait for the throttle window');
  await new Promise(resolve => setTimeout(resolve, 260));
  const drafts = events.filter(event => event.type === 'draft');
  assert.equal(drafts.length, 2); assert.equal(drafts.at(-1)!.type === 'draft' && drafts.at(-1)!.draft.text, 'あ'.repeat(200));
  assert.equal(live.drafts().length, 1);
  draft.close('completed'); draft.close('failed'); draft.push({ channel: 'text', delta: '遅れた断片' });
  await new Promise(resolve => setTimeout(resolve, 220));
  assert.deepEqual(events.filter(event => event.type === 'draft_end').map(event => event.type === 'draft_end' && event.reason), ['completed']);
  assert.equal(live.drafts().length, 0); assert.equal(events.filter(event => event.type === 'draft').length, 2);
  // Calls that never produced visible text do not announce an end.
  const silent = live.open({ room_id: 'r', agent_id: 'a', task_id: 't2' }); silent.close('failed');
  assert.equal(events.length, 3); stop();
});

test('codex adapter reports display deltas without changing its validated events', async () => {
  const store = new MemoryCredentialStore(); await store.write(credential);
  const body = frame({ type: 'response.output_text.delta', delta: '考え' })
    + frame({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc1', call_id: 'call1', name: 'conversation_send', arguments: '' } })
    + frame({ type: 'response.function_call_arguments.delta', item_id: 'fc1', output_index: 0, delta: '{"body":"返' })
    + frame({ type: 'response.function_call_arguments.delta', item_id: 'fc1', output_index: 0, delta: '答","recipient_ids":[]}' })
    + frame({ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc1', call_id: 'call1', name: 'conversation_send', arguments: '{"body":"返答","recipient_ids":[]}' } })
    + frame({ type: 'response.completed', response: {} });
  const adapter = () => new OpenAISubscriptionAdapter({ model_profile: profile, experimental_opt_in: true, credential_store: store,
    fetch: async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }) });
  const deltas: ModelOutputDelta[] = [];
  const observed = await collectModelEvents(adapter().run(request, { timeout_ms: 1000, on_delta: delta => deltas.push(delta) }));
  const plain = await collectModelEvents(adapter().run(request, { timeout_ms: 1000 }));
  const throwing = await collectModelEvents(adapter().run(request, { timeout_ms: 1000, on_delta: () => { throw new Error('viewer failed'); } }));
  assert.deepEqual(observed, plain); assert.deepEqual(throwing, plain);
  assert.deepEqual(deltas, [{ channel: 'text', delta: '考え' },
    { channel: 'tool_arguments', call_id: 'fc1', name: 'conversation_send', delta: '{"body":"返' },
    { channel: 'tool_arguments', call_id: 'fc1', name: 'conversation_send', delta: '答","recipient_ids":[]}' }]);
  // Adapters that never call the optional observer remain valid.
  const legacy: ModelAdapter = { adapter_id: 'legacy', capabilities: openAISubscriptionAdapterCapabilities, async *run() { yield { type: 'text_delta', text: '旧' }; yield { type: 'completed', finish_reason: 'stop' }; } };
  assert.equal((await collectModelEvents(legacy.run(request, { timeout_ms: 1000, on_delta: () => assert.fail('unused') }))).at(-1)?.type, 'completed');
});

function turnFixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), 'niwa-live-'));
  const runtime = new Runtime(root); t.after(() => { runtime.close(); rmSync(root, { recursive: true, force: true }); });
  const admin = runtime.administrator(); const leader = runtime.bootstrap(admin); const room = runtime.createRoom(admin, '庭');
  return { root, runtime, admin, leader, room };
}
const streaming = (deltas: ModelOutputDelta[], events: ModelEvent[]): ModelAdapter => ({ adapter_id: 'artificial', capabilities: openAISubscriptionAdapterCapabilities,
  async *run(model, options) {
    if (model.tools.length === 1 && model.tools[0]?.name === 'memory_review') {
      options.on_delta?.({ channel: 'text', delta: '記憶整理は表示しない' });
      yield { type: 'tool_call', tool_call_id: 'm', name: 'memory_review', arguments: { memories: [] } }; yield { type: 'completed', finish_reason: 'tool_calls' }; return;
    }
    for (const delta of deltas) { options.on_delta?.(delta); await new Promise(resolve => setTimeout(resolve, 5)); }
    yield* events;
  } });

test('turn drafts reach live viewers, are cleared on completion and failure, and never reach steps or messages', async t => {
  for (const [outcome, events] of [
    ['completed', [{ type: 'tool_call', tool_call_id: 'c', name: 'conversation_send', arguments: { body: '確定した返答', recipient_ids: [] } }, { type: 'completed', finish_reason: 'tool_calls' }]],
    ['failed', [{ type: 'failed', error: { code: 'PROVIDER_ERROR', message: 'artificial', retryable: false } }]],
  ] as const) {
    const f = turnFixture(t); const seen: LiveEvent[] = []; f.runtime.live.subscribe(event => seen.push(event));
    const task = f.runtime.submit(f.admin, randomUUID(), f.room.id, '返答して', f.leader.id).task!; const lease = f.runtime.tasks.claim(f.admin)!;
    await new TurnRunner(f.runtime, async () => streaming([
      { channel: 'tool_arguments', call_id: 'c', name: 'conversation_send', delta: '{"body":"下書きだけの' },
      { channel: 'tool_arguments', call_id: 'c', delta: '文章です","recipient_ids":[]}' }], events as unknown as ModelEvent[])).run(lease);
    const drafts = seen.filter(event => event.type === 'draft');
    assert.ok(drafts.length >= 1, outcome); assert.ok(drafts.every(event => event.type === 'draft' && event.draft.task_id === task.id && event.draft.room_id === f.room.id && event.draft.agent_id === f.leader.id));
    assert.ok(drafts.every(event => event.type === 'draft' && !event.draft.text.includes('記憶整理')));
    assert.deepEqual(seen.filter(event => event.type === 'draft_end').map(event => event.type === 'draft_end' && event.reason), [outcome]);
    assert.equal(f.runtime.live.drafts().length, 0);
    const stored = JSON.stringify([f.runtime.tasks.steps(f.runtime.agentSession(f.leader.id), task.id), f.runtime.messages(f.admin, f.room.id), f.runtime.tasks.history(f.admin, task.id)]);
    assert.equal(stored.includes('下書きだけ'), false);
    if (outcome === 'completed') assert.ok(f.runtime.messages(f.admin, f.room.id).some(message => message.body === '確定した返答'));
  }
});

test('a cancelled turn clears its draft as cancelled', async t => {
  const f = turnFixture(t); const seen: LiveEvent[] = []; f.runtime.live.subscribe(event => seen.push(event));
  f.runtime.submit(f.admin, randomUUID(), f.room.id, '返答して', f.leader.id); const lease = f.runtime.tasks.claim(f.admin)!;
  const controller = new AbortController();
  const adapter: ModelAdapter = { adapter_id: 'artificial', capabilities: openAISubscriptionAdapterCapabilities,
    async *run(model, options) {
      if (model.tools.length === 1) { yield { type: 'tool_call', tool_call_id: 'm', name: 'memory_review', arguments: { memories: [] } }; yield { type: 'completed', finish_reason: 'tool_calls' }; return; }
      options.on_delta?.({ channel: 'text', delta: '途中の文' }); controller.abort(); await new Promise(() => undefined);
    } };
  await new TurnRunner(f.runtime, async () => adapter).run(lease, controller.signal);
  assert.deepEqual(seen.filter(event => event.type === 'draft_end').map(event => event.type === 'draft_end' && event.reason), ['cancelled']);
  assert.equal(f.runtime.live.drafts().length, 0);
});

type Sse = { status: number; events: { event: string; data: unknown }[]; response: IncomingMessage; close: () => void; wait: (match: (event: { event: string; data: unknown }) => boolean, ms?: number) => Promise<{ event: string; data: unknown }> };
test('event stream needs no login but refuses other sites, bounds open streams, and only relays visible drafts', async t => {
  const f = turnFixture(t); const origin = 'https://niwa.test';
  const server = createApiServer(f.runtime, new WebAuth(origin)); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  t.after(async () => { await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); });
  const open = (headers: Record<string, string> = {}) => new Promise<Sse>((resolve, reject) => {
    const outgoing = httpRequest(`http://127.0.0.1:${port}/api/events/stream`, { headers: { host: 'niwa.test', 'tailscale-user-login': 'owner@example.com', ...headers } }, response => {
      const events: Sse['events'] = []; let buffer = ''; const waiters = new Set<() => void>();
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        buffer += chunk; let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const name = /^event: (.+)$/mu.exec(block)?.[1]; const data = /^data: (.+)$/mu.exec(block)?.[1];
          if (name) events.push({ event: name, data: data === undefined ? undefined : JSON.parse(data) });
        }
        for (const wake of [...waiters]) wake();
      });
      response.on('error', () => undefined);
      const wait: Sse['wait'] = (match, ms = 2000) => new Promise((done, fail) => {
        const check = () => { const found = events.find(match); if (found) { waiters.delete(check); clearTimeout(timer); done(found); } };
        const timer = setTimeout(() => { waiters.delete(check); fail(new Error('event not received')); }, ms);
        waiters.add(check); check();
      });
      resolve({ status: response.statusCode!, events, response, close: () => outgoing.destroy(), wait });
    });
    outgoing.on('error', reject); outgoing.end();
  });
  const foreign = await open({ origin: 'https://evil.test' }); assert.equal(foreign.status, 403); foreign.close();
  const crossSite = await open({ 'sec-fetch-site': 'cross-site' }); assert.equal(crossSite.status, 403); crossSite.close();
  const sameSite = await open({ 'sec-fetch-site': 'same-site' }); assert.equal(sameSite.status, 403); sameSite.close();
  const rebound = await open({ host: 'evil.test' }); assert.equal(rebound.status, 403); rebound.close();
  const stream = await open({ 'sec-fetch-site': 'same-origin' }); assert.equal(stream.status, 200);
  assert.match(String(stream.response.headers['content-type']), /^text\/event-stream/u);
  await stream.wait(event => event.event === 'ready');
  const extra: Sse[] = []; for (let index = 1; index < MAX_STREAMS; index++) { const next = await open(); assert.equal(next.status, 200); extra.push(next); }
  const over = await open(); assert.equal(over.status, 429); over.close();
  // Content changes become a content-free refresh hint.
  f.runtime.post(f.admin, f.room.id, '人工の変更');
  const changed = await stream.wait(event => event.event === 'changed');
  assert.deepEqual(Object.keys(changed.data as object), ['version']);
  // Drafts for a deleted (unreadable) room are never relayed; visible drafts are.
  const hidden = f.runtime.createRoom(f.admin, '削除する会話'); f.runtime.deleteContent(f.admin, 'room', hidden.id);
  const secret = f.runtime.live.open({ room_id: hidden.id, agent_id: f.leader.id, task_id: randomUUID() });
  secret.push({ channel: 'text', delta: '見えてはいけない下書き' });
  const draft = f.runtime.live.open({ room_id: f.room.id, agent_id: f.leader.id, task_id: randomUUID() });
  draft.push({ channel: 'text', delta: '見える下書き' });
  const relayed = await stream.wait(event => event.event === 'draft');
  assert.equal((relayed.data as { text: string; room_id: string }).text, '見える下書き');
  draft.close('completed'); secret.close('completed');
  await stream.wait(event => event.event === 'draft_end');
  assert.equal(JSON.stringify(stream.events).includes('見えてはいけない'), false);
  // Closing a stream releases its slot.
  extra.pop()!.close(); await new Promise(resolve => setTimeout(resolve, 50));
  const reopened = await open(); assert.equal(reopened.status, 200);
  const late = await open(); assert.equal(late.status, 429); late.close();
  for (const item of [stream, reopened, ...extra]) item.close();
});

test('event stream heartbeats and ends when Niwa closes it', async t => {
  const f = turnFixture(t);
  const live = new LiveStreams(f.runtime, f.admin, { heartbeatMs: 30, pollMs: 20 });
  const server = createServer((req, res) => { live.open(req, res); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = (server.address() as { port: number }).port;
  t.after(async () => { await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); });
  const get = (path: string) => new Promise<IncomingMessage>((resolve, reject) => { const outgoing = httpRequest(`http://127.0.0.1:${port}${path}`, resolve); outgoing.on('error', reject); outgoing.end(); });
  const stream = await get('/stream'); assert.equal(stream.statusCode, 200);
  let text = ''; stream.setEncoding('utf8'); stream.on('data', (chunk: string) => { text += chunk; });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.match(text, /event: ready/u); assert.match(text, /: ping/u); assert.equal(live.size, 1);
  live.close();
  await once(stream, 'end'); assert.equal(live.size, 0);
});
