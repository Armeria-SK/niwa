import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Runtime } from '../src/runtime/runtime.ts';
import { TurnRunner } from '../src/runtime/turns.ts';
import type { ModelAdapter } from '../src/providers/shared/adapter.ts';
import type { ModelRequest, ModelEvent } from '../src/contracts/model.ts';
import { openAISubscriptionAdapterCapabilities } from '../src/providers/codex/adapter.ts';

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'niwa-memory-review-'));
  let runtime = new Runtime(root);
  t.after(() => { runtime.close(); rmSync(root, { recursive: true, force: true }); });
  const admin = runtime.administrator(), leader = runtime.bootstrap(admin), actor = runtime.agentSession(leader.id);
  const room = runtime.createRoom(admin, '共有');
  return { root, runtime, admin, leader, actor, room, reopen() { runtime.close(); runtime = new Runtime(root); return runtime; } };
}
const text = (content: string): ModelEvent[] => [{ type: 'text_delta', text: content }, { type: 'completed', finish_reason: 'stop' }];
const call = (name: string, args: Record<string, unknown>): ModelEvent[] => [{ type: 'tool_call', tool_call_id: 'artificial-review', name, arguments: args }, { type: 'completed', finish_reason: 'tool_calls' }];
const model = (reply: (request: ModelRequest) => ModelEvent[], tools = true): ModelAdapter => ({
  adapter_id: 'artificial', capabilities: { ...openAISubscriptionAdapterCapabilities, supports_tool_calls: tools },
  async *run(request) { yield* reply(request); },
});

test('conversation work selects a sourced memory before replying, and preserves corrections and deletion across later tasks and restart', async t => {
  const f = fixture(t);
  const source = f.runtime.post(f.admin, f.room.id, '朝は紅茶を飲みます。');
  const review = { memories: [{ source_message_id: source.id, body: 'ユーザーは朝に紅茶を飲む。' }] };
  let reviews = 0;
  const run = async (runtime: Runtime, expected: string | null) => {
    const admin = runtime.administrator();
    const task = runtime.tasks.create(admin, f.leader.id, f.room.id, '明日の朝の話');
    await new TurnRunner(runtime, async () => model(request => {
      if (request.tools.length === 1 && request.tools[0]!.name === 'memory_review') { reviews++; return call('memory_review', review); }
      if (expected) assert.ok(request.system_instructions.includes(expected));
      else assert.equal(request.system_instructions.includes('ユーザーは朝に紅茶を飲む。'), false);
      return call('conversation_send', { body: '朝の話を続けましょう。', recipient_ids: [] });
    })).run(runtime.tasks.claim(admin)!);
    assert.equal(runtime.tasks.get(admin, task.id).state, 'completed');
  };
  await run(f.runtime, review.memories[0]!.body);
  await run(f.runtime, review.memories[0]!.body);
  const memory = f.runtime.memories(f.admin, f.leader.id)[0]!;
  assert.equal(f.runtime.memories(f.admin, f.leader.id).length, 1);
  assert.equal(memory.source_message_id, source.id);
  f.runtime.correctMemory(f.admin, f.leader.id, memory.id, 1, '朝は麦茶に変更した。');
  await run(f.runtime, '朝は麦茶に変更した。');
  assert.equal(f.runtime.memories(f.admin, f.leader.id).length, 1);
  f.runtime.deleteMemory(f.admin, f.leader.id, memory.id, 2);
  const reopened = f.reopen();
  await run(reopened, null);
  assert.equal(reopened.memories(reopened.administrator(), f.leader.id).length, 0);
  assert.equal(reviews, 4);
  assert.equal(reopened.messages(reopened.administrator(), f.room.id).some(message => message.body.includes('source_message_id')), false);
});

test('memory review validates the whole batch and cannot cross rooms, bots, or stopped leases', t => {
  const f = fixture(t);
  const child = f.runtime.createAgent(f.actor, '仲間');
  const privateRoom = f.runtime.createRoom(f.admin, '個別', [f.leader.id]);
  const privateSource = f.runtime.post(f.admin, privateRoom.id, '私的な経験');
  const source = f.runtime.post(f.admin, f.room.id, '共有した経験');
  f.runtime.tasks.create(f.admin, f.leader.id, f.room.id, '整理');
  const lease = f.runtime.tasks.claim(f.admin)!;
  assert.throws(() => f.runtime.reviewMemory(f.actor, lease, { memories: [
    { source_message_id: source.id, body: '共有から保存' }, { source_message_id: privateSource.id, body: '別の個別から保存' },
  ] }), /outside this conversation/);
  assert.equal(f.runtime.memories(f.admin, f.leader.id).length, 0);
  assert.equal(f.runtime.memoryReviewed(f.actor, lease), false);
  assert.throws(() => f.runtime.reviewMemory(f.runtime.agentSession(child.id), lease, { memories: [] }), /no longer active/);
  f.runtime.reviewMemory(f.actor, lease, { memories: [{ source_message_id: source.id, body: '自分で残した経験' }] });
  assert.equal(f.runtime.context(f.runtime.agentSession(child.id), f.room.id).memories.length, 0);
  f.runtime.tasks.pause(f.admin, lease.task.id);
  assert.throws(() => f.runtime.reviewMemory(f.actor, lease, { memories: [] }), /no longer active/);
});

test('text-only models can return a private JSON review, while malformed or unrelated tool output is not published or executed', async t => {
  const f = fixture(t);
  const source = f.runtime.post(f.admin, f.room.id, '花を育てるのが好き。');
  const task = f.runtime.tasks.create(f.admin, f.leader.id, f.room.id, '植物の話');
  let calls = 0;
  await new TurnRunner(f.runtime, async () => model(() => ++calls === 1
    ? text(JSON.stringify({ memories: [{ source_message_id: source.id, body: 'ユーザーは花を育てるのが好き。' }] })) : text('植物の話をしましょう。'), false))
    .run(f.runtime.tasks.claim(f.admin)!);
  assert.equal(f.runtime.tasks.get(f.admin, task.id).state, 'completed');
  assert.equal(f.runtime.memories(f.admin, f.leader.id).length, 1);
  for (const output of [text('JSONではない整理'), call('agents_create', { name: '作ってはいけないBot' })]) {
    const next = f.runtime.tasks.create(f.admin, f.leader.id, f.room.id, '整理の形式');
    await new TurnRunner(f.runtime, async () => model(() => output)).run(f.runtime.tasks.claim(f.admin)!);
    assert.equal(f.runtime.tasks.get(f.admin, next.id).state, 'waiting_provider');
    assert.ok(f.runtime.tasks.get(f.admin, next.id).provider_retry_at);
  }
  assert.equal(f.runtime.agents(f.admin).length, 1);
  assert.equal(f.runtime.messages(f.admin, f.room.id).length, 2);
});

test('a memory correction during review invalidates that response and re-reviews before saving', async t => {
  const f = fixture(t);
  const source = f.runtime.post(f.admin, f.room.id, '人工の経験');
  const old = f.runtime.remember(f.actor, source.id, '訂正前の記憶');
  const task = f.runtime.tasks.create(f.admin, f.leader.id, f.room.id, '経験の話');
  let reviews = 0;
  await new TurnRunner(f.runtime, async () => model(request => {
    if (request.tools.length === 1) {
      if (++reviews === 1) {
        f.runtime.correctMemory(f.admin, f.leader.id, old.id, 1, '訂正後の記憶');
        return call('memory_review', { memories: [{ source_message_id: source.id, body: '保存されてはいけない旧候補' }] });
      }
      assert.match(request.system_instructions, /訂正後の記憶/);
      return call('memory_review', { memories: [] });
    }
    return text('最新の記憶で回答');
  })).run(f.runtime.tasks.claim(f.admin)!);
  assert.equal(reviews, 2);
  assert.equal(f.runtime.tasks.get(f.admin, task.id).state, 'completed');
  assert.deepEqual(f.runtime.memories(f.admin, f.leader.id).map(memory => memory.body), ['訂正後の記憶']);
});
