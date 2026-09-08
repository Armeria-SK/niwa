import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Runtime } from '../src/runtime/runtime.ts';
import { TurnRunner } from '../src/runtime/turns.ts';
import type { ModelEvent, ModelRequest } from '../src/contracts/model.ts';
import type { ModelAdapter } from '../src/providers/shared/adapter.ts';
import { openAISubscriptionAdapterCapabilities } from '../src/providers/codex/adapter.ts';
import { turnTools, executeTurnTool, executeAsyncTurnTool } from '../src/runtime/turn-tools.ts';

function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), 'niwa-turns-'));
  const runtime = new Runtime(root); t.after(() => { runtime.close(); rmSync(root, { recursive: true, force: true }); });
  const admin = runtime.administrator(); const leader = runtime.bootstrap(admin);
  const actor = runtime.agentSession(leader.id); const room = runtime.createRoom(admin, '庭');
  return { root, runtime, admin, leader, actor, room };
}
const complete = (text: string): ModelEvent[] => [{ type: 'text_delta', text }, { type: 'completed', finish_reason: 'stop' }];
const tool = (name: string, args: Record<string, unknown>): ModelEvent[] => [
  { type: 'tool_call', tool_call_id: 'artificial-call', name, arguments: args }, { type: 'completed', finish_reason: 'tool_calls' },
];
function model(reply: (request: ModelRequest) => ModelEvent[] | Promise<ModelEvent[]>): ModelAdapter {
  return { adapter_id: 'artificial', capabilities: openAISubscriptionAdapterCapabilities,
    async *run(request) {
      if (request.tools.length === 1 && request.tools[0]?.name === 'memory_review') { yield* tool('memory_review', { memories: [] }); return; }
      if (request.tools.length === 1 && request.tools[0]?.name === 'task_summary_save') {
        const state = JSON.parse(request.messages.at(-1)!.content!).work_state;
        yield* tool('task_summary_save', { conclusion: '人工の引継ぎ', reason: '保存済み資料を参照', unresolved: [], next_steps: [],
          sources: state.summary_sources.slice(0, 1).map(({ kind, source_id, revision }: { kind: string; source_id: string; revision: string }) => ({ kind, source_id, revision })) }); return;
      }
      yield* await reply(request);
    } };
}

test('addressed bot replies continue at the recipient without leader echo and respect pause and archive', async t => {
  const f = fixture(t); const child = f.runtime.createAgent(f.actor, '仲間');
  let visits: string[] = [];
  const runner = new TurnRunner(f.runtime, async agent => model(request => {
    assert.match(request.system_instructions, /@相手の名前/); assert.match(request.system_instructions, /ラベルや署名を付けず/);
    visits.push(agent.id);
    return agent.id === f.leader.id ? complete('@仲間 この話題はどう思いますか？') : complete('面白いと思います。');
  }));
  const root = f.runtime.tasks.create(f.admin, f.leader.id, f.room.id, '会話してください');
  const original = f.runtime.tasks.claim(f.admin)!; await runner.run(original); await runner.run(original);
  assert.equal(f.runtime.tasks.list(f.admin).length, 2);
  f.runtime.updateSettings(f.admin, { autonomous: false }); assert.equal(f.runtime.tasks.claim(f.admin), undefined);
  f.runtime.updateSettings(f.admin, { autonomous: true });
  f.runtime.organizeRoom(f.admin, f.room.id, { archived: true }); assert.equal(f.runtime.tasks.claim(f.admin), undefined);
  f.runtime.organizeRoom(f.admin, f.room.id, { archived: false });
  await runner.run(f.runtime.tasks.claim(f.admin)!);
  assert.deepEqual(visits, [f.leader.id, child.id]); assert.equal(f.runtime.tasks.claim(f.admin), undefined);
  assert.equal(f.runtime.tasks.get(f.admin, root.id).state, 'completed');
  assert.deepEqual(f.runtime.messages(f.admin, f.room.id).map(message => message.author_id), visits);
});

test('directed conversation respects private membership and continues beyond sixteen replies', async t => {
  const f = fixture(t); const child = f.runtime.createAgent(f.actor, '仲間');
  const privateRoom = f.runtime.createRoom(f.admin, '個別', [f.leader.id]);
  const privateTask = f.runtime.tasks.create(f.admin, f.leader.id, privateRoom.id, '非共有');
  const privateLease = f.runtime.tasks.claim(f.admin)!; f.runtime.respond(f.actor, privateLease, '@仲間 個別の内容');
  assert.equal(f.runtime.tasks.get(f.admin, privateTask.id).state, 'completed'); assert.equal(f.runtime.tasks.list(f.admin).length, 1);
  const runner = new TurnRunner(f.runtime, async agent => model(() => complete(`@${agent.id === child.id ? f.leader.name : child.name} 続けますか？`)));
  f.runtime.tasks.create(f.admin, f.leader.id, f.room.id, '会話');
  for (let index = 0; index < 20; index++) await runner.run(f.runtime.tasks.claim(f.admin)!);
  assert.equal(f.runtime.messages(f.admin, f.room.id).length, 20);
  assert.equal(f.runtime.tasks.list(f.admin).some(item => item.state === 'waiting_user'), false);
  assert.ok(f.runtime.tasks.claim(f.admin));
});

test('queued addressed conversations survive restart and can rest or retry without resuming a finished sender', async t => {
  const f = fixture(t); const child = f.runtime.createAgent(f.actor, '仲間');
  f.runtime.tasks.create(f.admin, f.leader.id, f.room.id, '会話');
  await new TurnRunner(f.runtime, async () => model(() => complete('@仲間 続けたい話題はありますか？'))).run(f.runtime.tasks.claim(f.admin)!);
  f.runtime.close(); const runtime = new Runtime(f.root); const admin = runtime.administrator();
  try {
    const task = runtime.tasks.list(admin).at(-1)!; runtime.tasks.cancel(admin, task.id); runtime.tasks.retry(admin, task.id);
    const runner = new TurnRunner(runtime, async agent => model(request => {
      assert.equal(agent.id, child.id); assert.match(request.system_instructions, /別のBotからあなたへの会話/);
      return tool('task_rest', {});
    }));
    await runner.run(runtime.tasks.claim(admin)!);
    assert.equal(runtime.tasks.get(admin, task.id).state, 'completed'); assert.equal(runtime.tasks.claim(admin), undefined);
    assert.equal(runtime.messages(admin, f.room.id).length, 1);
  } finally { runtime.close(); }
});

test('multiple administrator recipients create one message and atomic replay-safe jobs', t => {
  const f = fixture(t); const child = f.runtime.createAgent(f.actor, '仲間'); const id = randomUUID();
  f.runtime.submit(f.admin, id, f.room.id, '二人に質問', [f.leader.id, child.id]);
  f.runtime.submit(f.admin, id, f.room.id, '二人に質問', [child.id, f.leader.id, child.id]);
  assert.equal(f.runtime.messages(f.admin, f.room.id).length, 1);
  assert.deepEqual(f.runtime.tasks.list(f.admin).map(item => item.agent_id).sort(), [child.id, f.leader.id].sort());
  const room = f.runtime.createRoom(f.admin, '個別', [f.leader.id]);
  assert.throws(() => f.runtime.submit(f.admin, randomUUID(), room.id, '秘密', [f.leader.id, child.id]));
  assert.equal(f.runtime.messages(f.admin, room.id).length, 0); assert.equal(f.runtime.tasks.list(f.admin).length, 2);
});

test('structured bot conversation delivers to all recipients once and enforces privacy', async t => {
  const f = fixture(t); const a = f.runtime.createAgent(f.actor, 'A'); const b = f.runtime.createAgent(f.actor, 'B');
  const runner = new TurnRunner(f.runtime, async agent => model(request => {
    assert.match(request.system_instructions, /通常の会話はプレーンテキスト/);
    return tool('conversation_send', { body: agent.id === f.leader.id ? '@A ＠A @B どう思いますか？' : 'どう思いますか？', recipient_ids: agent.id === f.leader.id ? [a.id, b.id] : [] });
  }));
  f.runtime.tasks.create(f.admin, f.leader.id, f.room.id, '話して'); const first = f.runtime.tasks.claim(f.admin)!;
  await runner.run(first); await runner.run(first);
  assert.equal(f.runtime.tasks.list(f.admin).length, 3);
  assert.equal(f.runtime.messages(f.admin, f.room.id)[0]!.body, '@A @B どう思いますか？');
  await runner.run(f.runtime.tasks.claim(f.admin)!); await runner.run(f.runtime.tasks.claim(f.admin)!);
  assert.equal(f.runtime.tasks.claim(f.admin), undefined); assert.equal(f.runtime.messages(f.admin, f.room.id).length, 3);
  const room = f.runtime.createRoom(f.admin, '個別', [f.leader.id]); f.runtime.tasks.create(f.admin, f.leader.id, room.id, '秘密');
  const lease = f.runtime.tasks.claim(f.admin)!;
  assert.throws(() => f.runtime.respond(f.actor, lease, '秘密', [a.id]));
  assert.throws(() => f.runtime.respond(f.actor, lease, '秘密', [randomUUID()]));
  assert.equal(f.runtime.messages(f.admin, room.id).length, 0);
});

test('branching conversations continue beyond the former shared count limit', async t => {
  const f = fixture(t); const a = f.runtime.createAgent(f.actor, 'A'); const b = f.runtime.createAgent(f.actor, 'B');
  const ids = [f.leader.id, a.id, b.id];
  const runner = new TurnRunner(f.runtime, async agent => model(() => tool('conversation_send', { body: '続きは？', recipient_ids: ids.filter(id => id !== agent.id) })));
  f.runtime.tasks.create(f.admin, f.leader.id, f.room.id, '会話');
  for (let runs = 0; runs < 20; runs++) await runner.run(f.runtime.tasks.claim(f.admin)!);
  assert.equal(f.runtime.messages(f.admin, f.room.id).length, 20);
  assert.equal(f.runtime.tasks.list(f.admin).some(item => item.state === 'waiting_user'), false);
});

test('common rules reject stale edits, persist, and discard an old rule response before publishing', async t => {
  const f = fixture(t); const initial = f.runtime.commonRules(f.admin);
  assert.throws(() => f.runtime.updateCommonRules(f.actor, initial.revision, 'モデルからの変更'), /Administrator/);
  f.runtime.updateCommonRules(f.admin, initial.revision, '旧ルールの目印');
  assert.throws(() => f.runtime.updateCommonRules(f.admin, initial.revision, '古い画面の変更'), /Rules changed/);
  const task = f.runtime.tasks.create(f.admin, f.leader.id, f.room.id, '共通ルールを使う');
  let calls = 0;
  const runner = new TurnRunner(f.runtime, async () => model(request => {
    if (++calls === 1) {
      assert.match(request.system_instructions, /旧ルールの目印/);
      f.runtime.updateCommonRules(f.admin, f.runtime.commonRules(f.admin).revision, '新ルールの目印');
      return complete('古い応答を公開しない');
    }
    assert.match(request.system_instructions, /新ルールの目印/); assert.doesNotMatch(request.system_instructions, /旧ルールの目印/);
    assert.match(request.system_instructions, /ほかのBotの個別記憶/);
    return complete('新しいルールで回答');
  }));
  await runner.run(f.runtime.tasks.claim(f.admin)!);
  assert.equal(f.runtime.messages(f.admin, f.room.id).length, 0);
  assert.equal(f.runtime.tasks.get(f.admin, task.id).state, 'queued');
  await runner.run(f.runtime.tasks.claim(f.admin)!);
  assert.equal(f.runtime.tasks.get(f.admin, task.id).result, '新しいルールで回答');
  const reopened = new Runtime(f.root);
  try { assert.equal(reopened.commonRules(reopened.administrator()).body, '新ルールの目印'); }
  finally { reopened.close(); }
});

test('an administrator profile edit discards saved instructions across restart before a waiting task resumes', async t => {
  const f = fixture(t); const task = f.runtime.tasks.create(f.admin, f.leader.id, f.room.id, '変更後の人格で続ける');
  const lease = f.runtime.tasks.claim(f.admin)!;
  const revision = f.runtime.context(f.actor, f.room.id).revision;
  f.runtime.tasks.saveStep(f.actor, lease, revision, tool('agents_create', { name: '変更前の指示から生成' }));
  f.runtime.tasks.wait(f.actor, lease, 'waiting_user', '続行待ち');
  f.runtime.updateProfile(f.admin, f.leader.id, { persona: 'Botを追加せず、簡潔に回答する' });
  assert.equal(f.runtime.isContextCurrent(f.actor, revision), false);
  const reopened = new Runtime(f.root);
  try {
    const admin = reopened.administrator(); const actor = reopened.agentSession(f.leader.id);
    assert.deepEqual(reopened.tasks.steps(actor, task.id)[0]!.events, []);
    reopened.tasks.resume(admin, task.id);
    await new TurnRunner(reopened, async () => model(request => {
      assert.match(request.system_instructions, /Botを追加せず、簡潔に回答する/);
      return complete('変更後の人格で完了');
    })).run(reopened.tasks.claim(admin)!);
    assert.equal(reopened.agents(admin).length, 1);
    assert.equal(reopened.tasks.get(admin, task.id).result, '変更後の人格で完了');
  } finally { reopened.close(); }
});

test('saved tool calls from a previous rule revision are not executed after resuming', async t => {
  const f = fixture(t); const task = f.runtime.tasks.create(f.admin, f.leader.id, f.room.id, '新しいルールで続行');
  const lease = f.runtime.tasks.claim(f.admin)!;
  f.runtime.tasks.saveStep(f.actor, lease, f.runtime.context(f.actor, f.room.id).revision, tool('agents_create', { name: '旧ルールからの生成' }));
  f.runtime.tasks.wait(f.actor, lease, 'waiting_user', '続行待ち');
  f.runtime.updateCommonRules(f.admin, 1, 'Botを追加せず回答してください');
  f.runtime.tasks.resume(f.admin, task.id);
  await new TurnRunner(f.runtime, async () => model(request => {
    assert.match(request.system_instructions, /Botを追加せず/);
    return complete('追加せず完了');
  })).run(f.runtime.tasks.claim(f.admin)!);
  assert.equal(f.runtime.agents(f.admin).length, 1);
  assert.equal(f.runtime.tasks.steps(f.actor, task.id)[0]!.discarded, 1);
  assert.equal(f.runtime.tasks.get(f.admin, task.id).result, '追加せず完了');
});

test('autonomous work can choose quiet rest, then act on a later occasion within the same budget', async t => {
  const f = fixture(t);
  f.runtime.updateProfile(f.admin, f.leader.id, { persona: '雨音の観察に関心があります。' });
  const input = { id: randomUUID(), agent_id: f.leader.id, room_id: f.room.id, prompt: '関心を探究してください', autonomous: true,
    interval_ms: 60_000, next_at: Date.now() + 60_000, max_runs: 3, timeout_ms: 60_000 };
  f.runtime.schedules.create(f.admin, input); f.runtime.schedules.dispatch(f.admin, input.next_at);
  let calls = 0;
  const runner = new TurnRunner(f.runtime, async () => model(request => {
    assert.match(request.system_instructions, /雨音の観察/); assert.match(request.system_instructions, /自発活動の機会/);
    assert.equal(request.tools.some(item => item.name === 'task_rest'), true);
    return ++calls === 1 ? tool('task_rest', {}) : complete('雨音の観察について、次に調べたいことを整理しました');
  }));
  await runner.run(f.runtime.tasks.claim(f.admin)!);
  assert.equal(f.runtime.messages(f.admin, f.room.id).length, 0); assert.equal(f.runtime.updates(f.admin).length, 0);
  assert.equal(f.runtime.tasks.list(f.admin)[0]!.result, '今回は休息しました。');
  f.runtime.schedules.dispatch(f.admin, input.next_at + 60_000);
  await runner.run(f.runtime.tasks.claim(f.admin)!);
  assert.equal(f.runtime.messages(f.admin, f.room.id).length, 1);
  assert.equal(f.runtime.schedules.list(f.admin)[0]!.model_calls, 2);
  assert.equal(f.runtime.schedules.list(f.admin)[0]!.run_count, 2);
  const regular = f.runtime.tasks.create(f.admin, f.leader.id, f.room.id, '通常の依頼');
  const lease = f.runtime.tasks.claim(f.admin)!;
  assert.equal(turnTools(true).some(item => item.name === 'task_rest'), false);
  assert.equal(executeTurnTool(f.runtime, f.actor, lease, { name: 'task_rest', tool_call_id: 'invalid-rest', arguments: {} }, 'invalid-rest').error, 'forbidden');
  assert.equal(f.runtime.tasks.get(f.admin, regular.id).state, 'running');
});

test('autonomous work waits without sending when the model cannot choose rest', async t => {
  const f = fixture(t); let calls = 0;
  const input = { id: randomUUID(), agent_id: f.leader.id, room_id: f.room.id, prompt: '関心を探究', autonomous: true,
    interval_ms: 60_000, next_at: Date.now() + 60_000, max_runs: 3, timeout_ms: 60_000 };
  f.runtime.schedules.create(f.admin, input); f.runtime.schedules.dispatch(f.admin, input.next_at);
  await new TurnRunner(f.runtime, async () => ({ ...model(() => { calls++; return complete('呼ばれない'); }),
    capabilities: { ...openAISubscriptionAdapterCapabilities, supports_tool_calls: false } })).run(f.runtime.tasks.claim(f.admin)!);
  assert.equal(calls, 0); assert.equal(f.runtime.schedules.list(f.admin)[0]!.model_calls, 0);
  assert.equal(f.runtime.tasks.list(f.admin)[0]!.state, 'waiting_provider');
});

test('shared-change work reads the current conversation and its reply does not trigger itself', async t => {
  const f = fixture(t); let calls = 0;
  const input = { id: randomUUID(), agent_id: f.leader.id, room_id: f.room.id, prompt: '新しい話題を検討', trigger_kind: 'shared_changes' as const,
    interval_ms: 60_000, next_at: Date.now() + 60_000, max_runs: 3, timeout_ms: 60_000 };
  f.runtime.schedules.create(f.admin, input);
  f.runtime.post(f.admin, f.room.id, '共有会話の新しい話題');
  f.runtime.schedules.dispatch(f.admin, input.next_at);
  await new TurnRunner(f.runtime, async () => model(request => {
    calls++; assert.match(JSON.stringify(request.messages), /共有会話の新しい話題/);
    return complete('変更を踏まえて回答しました');
  })).run(f.runtime.tasks.claim(f.admin)!);
  f.runtime.schedules.dispatch(f.admin, input.next_at + 60_000);
  assert.equal(f.runtime.tasks.list(f.admin).length, 1); assert.equal(calls, 1);
  assert.equal(f.runtime.schedules.list(f.admin)[0]!.model_calls, 2); // Memory review also consumes the configured budget.
});

test('schedule budget prevents another model call after a transport failure and restart', async t => {
  const f = fixture(t); let calls = 0;
  const input = { id: randomUUID(), agent_id: f.leader.id, room_id: f.room.id, prompt: '予定の調査',
    interval_ms: 60_000, next_at: Date.now() + 60_000, max_runs: 3, timeout_ms: 60_000, max_model_calls: 1 };
  f.runtime.schedules.create(f.admin, input); f.runtime.schedules.dispatch(f.admin, input.next_at);
  const lease = f.runtime.tasks.claim(f.admin)!;
  const runner = new TurnRunner(f.runtime, async () => model(() => { calls++; throw new Error('人工接続失敗'); }));
  await runner.run(lease);
  assert.equal(calls, 1); assert.equal(f.runtime.tasks.get(f.admin, lease.task.id).state, 'waiting_provider');
  f.runtime.close(); const reopened = new Runtime(f.root);
  try {
    const admin = reopened.administrator(); reopened.tasks.resume(admin, lease.task.id);
    await new TurnRunner(reopened, async () => model(() => { calls++; return complete('呼ばれない'); })).run(reopened.tasks.claim(admin)!);
    assert.equal(calls, 1); assert.equal(reopened.schedules.list(admin)[0]!.model_calls, 1);
    assert.equal(reopened.tasks.get(admin, lease.task.id).state, 'waiting_user');
    assert.match(reopened.tasks.get(admin, lease.task.id).wait_reason!, /上限/);
  } finally { reopened.close(); }
});

test('long turns compact complete exchanges, recreate the adapter, and preserve initial conversation instructions', async t => {
  const f = fixture(t); let resolutions = 0, requests = 0, reads = 0;
  f.runtime.post(f.admin, f.room.id, '最初の重要指示');
  for (let n = 0; n < 45; n++) f.runtime.post(f.admin, f.room.id, `途中の会話${n}`);
  const runner = new TurnRunner(f.runtime, async () => {
    const generation = ++resolutions;
    return { ...model(request => {
      const encoded = JSON.stringify(request.messages);
      assert.match(encoded, /最初の重要指示/);
      if (++requests < 3) return tool('web_read', { url: `https://example.com/${requests}` });
      assert.equal(generation, 2);
      assert.equal(encoded.includes('古い資料'.repeat(100)), false);
      assert.equal(encoded.includes('新しい資料'.repeat(100)), true);
      assert.equal(request.budget.max_requests, 1);
      assert.equal(request.budget.max_total_tokens, 64_000);
      return complete('圧縮後に完了');
    }), context_window: 50_000 };
  }, { readPage: async url => ({ url, content_type: 'text/plain', text: (++reads === 1 ? '古い資料' : '新しい資料').repeat(7000),
    fetched_at: new Date().toISOString(), untrusted: true, truncated: false }) });
  const task = f.runtime.tasks.create(f.admin, f.leader.id, f.room.id, '二つの資料を確認');
  await runner.run(f.runtime.tasks.claim(f.admin)!);
  assert.equal(f.runtime.tasks.get(f.admin, task.id).state, 'completed');
  assert.equal(requests, 3); assert.equal(reads, 2); assert.equal(resolutions, 3);
  assert.equal(f.runtime.tasks.steps(f.actor, task.id).length, 5);
});

test('interruption during compaction rebuilds from stored steps after restart without repeating completed reads', async t => {
  const f = fixture(t); let resolutions = 0, reads = 0, requests = 0;
  const task = f.runtime.tasks.create(f.admin, f.leader.id, f.room.id, '停止をまたいで継続');
  const lease = f.runtime.tasks.claim(f.admin)!;
  const external = { readPage: async (url: string) => ({ url, content_type: 'text/plain', text: `資料${++reads}`.repeat(10_000),
    fetched_at: new Date().toISOString(), untrusted: true, truncated: false }) };
  const runner = new TurnRunner(f.runtime, async () => {
    if (++resolutions === 2) f.runtime.tasks.interrupt(f.admin, lease);
    return { ...model(() => { requests++; return tool('web_read', { url: `https://example.com/${requests}` }); }), context_window: 50_000 };
  }, external);
  await runner.run(lease);
  assert.equal(requests, 2); assert.equal(reads, 2);
  assert.equal(f.runtime.tasks.get(f.admin, task.id).state, 'queued');
  f.runtime.close();
  const reopened = new Runtime(f.root);
  try {
    const admin = reopened.administrator();
    const resumed = new TurnRunner(reopened, async () => ({ ...model(request => {
      assert.match(JSON.stringify(request.messages), /停止をまたいで継続/);
      assert.equal(JSON.stringify(request.messages).includes('資料1'.repeat(100)), false);
      assert.equal(JSON.stringify(request.messages).includes('資料2'.repeat(100)), true);
      return complete('再起動後に完了');
    }), context_window: 50_000 }), external);
    await resumed.run(reopened.tasks.claim(admin)!);
    assert.equal(reopened.tasks.get(admin, task.id).state, 'completed');
    assert.equal(reads, 2);
    assert.equal(reopened.tasks.steps(reopened.agentSession(f.leader.id), task.id).length, 3);
  } finally { reopened.close(); }
});

test('model saves a sourced procedure and applies it through the common tool path', async t => {
  const f = fixture(t); let calls = 0;
  const source = f.runtime.post(f.admin, f.room.id, '確認した資料');
  const previous = f.runtime.tasks.create(f.admin, f.leader.id, f.room.id, '成功した前回の仕事');
  f.runtime.tasks.finish(f.actor, f.runtime.tasks.claim(f.admin)!, '検証済み');
  const runner = new TurnRunner(f.runtime, async () => model(request => {
    const state = JSON.parse(request.messages.at(-1)!.content!).work_state;
    if (++calls === 1) return tool('procedure_save', { id: null, expected_revision: 0, procedure: {
      title: '資料の更新確認', conditions: '同じ資料を更新するとき', steps: ['資料を読む', '差分を確認する'], source_task_id: previous.id,
      sources: [{ kind: 'message', source_id: source.id, revision: f.runtime.readHistory(f.actor, f.room.id, 'message', source.id).revision }],
    } });
    if (calls === 2) {
      const saved = JSON.parse(request.messages.findLast(message => message.role === 'tool')!.content!);
      return tool('procedure_apply', { id: saved.id, revision: saved.revision, plan_revision: state.remaining_plan.revision, applicability: '同じ資料の更新を確認するため' });
    }
    assert.deepEqual(state.remaining_plan.remaining, ['資料を読む', '差分を確認する']);
    assert.equal(state.applied_procedures.length, 1); assert.equal(state.external_operations.length, 0);
    return complete('採用した手順を確認');
  }));
  const task = f.runtime.tasks.create(f.admin, f.leader.id, f.room.id, '前回の手順を再利用');
  await runner.run(f.runtime.tasks.claim(f.admin)!);
  assert.equal(f.runtime.tasks.get(f.admin, task.id).state, 'completed'); assert.equal(calls, 3);
});

test('model can read a source and save a searchable auxiliary summary with its exact revision', async t => {
  const f = fixture(t); let calls = 0;
  const source = f.runtime.post(f.admin, f.room.id, '人工の確認済み資料');
  const runner = new TurnRunner(f.runtime, async () => model(request => {
    if (++calls === 1) return tool('history_read', { kind: 'message', source_id: source.id, offset: 0, revision: null });
    if (calls === 2) {
      const result = JSON.parse(request.messages.findLast(message => message.role === 'tool')!.content!);
      return tool('task_summary_save', { conclusion: '確認できた結論', reason: '資料を確認した', unresolved: [], next_steps: ['翌日に更新'],
        sources: [{ kind: 'message', source_id: source.id, revision: result.revision }] });
    }
    return complete('要約を保存しました');
  }));
  const task = f.runtime.tasks.create(f.admin, f.leader.id, f.room.id, '要点を保存');
  await runner.run(f.runtime.tasks.claim(f.admin)!);
  const result = f.runtime.searchHistory(f.actor, f.room.id, '確認できた結論').find(item => item.kind === 'summary')!;
  const saved = JSON.parse(f.runtime.readHistory(f.actor, f.room.id, 'summary', result.source_id).text);
  assert.equal(saved.sources[0].source_id, source.id);
  assert.equal(saved.task_state, 'completed'); assert.equal(saved.task_id, task.id);
  assert.equal(calls, 3);
});

test('planning tool feeds remaining steps into the next turn without granting execution authority', async t => {
  const f = fixture(t); let calls = 0;
  const runner = new TurnRunner(f.runtime, async () => model(request => {
    const state = JSON.parse(request.messages.at(-1)!.content!).work_state;
    if (++calls === 1) return tool('task_plan_update', { expected_revision: state.remaining_plan.revision, remaining: ['出所を確認', '資料を保存'] });
    assert.deepEqual(state.remaining_plan, { revision: 1, remaining: ['出所を確認', '資料を保存'] });
    assert.equal(state.task.state, 'running');
    assert.equal(state.external_operations.length, 0);
    return complete('手順を確認');
  }));
  const task = f.runtime.tasks.create(f.admin, f.leader.id, f.room.id, '手順を整理');
  await runner.run(f.runtime.tasks.claim(f.admin)!);
  assert.equal(f.runtime.tasks.get(f.admin, task.id).state, 'completed');
  assert.equal(calls, 2);
});

test('task history tool reads saved results without executing the original tool or caching private text', async t => {
  const f = fixture(t);
  const task = f.runtime.tasks.create(f.admin, f.leader.id, f.room.id, '以前の読取を確認');
  const lease = f.runtime.tasks.claim(f.admin)!;
  const input = { name: 'web_read', arguments: { url: 'https://example.com/' } };
  f.runtime.tasks.saveStep(f.actor, lease, 0, [{ type: 'tool_call', tool_call_id: 'original', ...input }, { type: 'completed', finish_reason: 'tool_calls' }]);
  f.runtime.tasks.once(f.actor, lease, '0:0', input, () => ({ text: '前の結果' }));
  const call = { name: 'task_history_read', tool_call_id: 'history', arguments: { step: 0, offset: 0, revision: null } };
  const result = executeTurnTool(f.runtime, f.actor, lease, call, 'read-old');
  assert.equal(JSON.parse(result.text as string).tool_results[0].result.text, '前の結果');
  f.runtime.tasks.discardStep(f.actor, lease, 0);
  assert.equal(executeTurnTool(f.runtime, f.actor, lease, call, 'read-old').error, 'not_found');
  assert.equal(f.runtime.tasks.get(f.admin, task.id).state, 'running');
});

test('long room history is retained in storage and fitted automatically for known and unknown capacity', async t => {
  const f = fixture(t); let requests = 0;
  for (let n = 0; n < 5; n++) f.runtime.post(f.admin, f.room.id, '大'.repeat(10_000));
  for (const capacity of [undefined, 20000]) {
    const runner = new TurnRunner(f.runtime, async () => ({ ...model(request => { requests++; assert.match(JSON.stringify(request.messages), /大きな会話/); return complete('完了'); }),
      ...(capacity === undefined ? {} : { context_window: capacity }) }));
    const task = f.runtime.tasks.create(f.admin, f.leader.id, f.room.id, '大きな会話');
    await runner.run(f.runtime.tasks.claim(f.admin)!);
    const waiting = f.runtime.tasks.get(f.admin, task.id);
    assert.equal(waiting.state, 'completed');
  }
  assert.equal(requests, 2);
  assert.equal(f.runtime.messages(f.admin, f.room.id).filter(message => message.body === '大'.repeat(10_000)).length, 5);
});

test('a single task completes more than twenty-four model steps without administrator continuation', async t => {
  const f = fixture(t); let requests = 0;
  const task = f.runtime.tasks.create(f.admin, f.leader.id, f.room.id, '長い作業');
  const runner = new TurnRunner(f.runtime, async () => model(request => {
    requests++;
    if (requests === 4) assert.match(request.system_instructions, /同じ引数のツール操作が3回/);
    return requests <= 30 ? tool('history_search', { query: '資料' }) : complete('完了');
  }));
  await runner.run(f.runtime.tasks.claim(f.admin)!);
  assert.equal(requests, 31);
  assert.equal(f.runtime.tasks.get(f.admin, task.id).state, 'completed');
});

test('public page tool stores a read receipt, rejects other bots and does not publish after interruption', async t => {
  const f = fixture(t);
  f.runtime.tasks.create(f.admin, f.leader.id, f.room.id, '公開資料を読む');
  const lease = f.runtime.tasks.claim(f.admin)!;
  const call = { name: 'web_read', tool_call_id: 'page-call', arguments: { url: 'https://example.com/' } };
  let reads = 0;
  const reader = async () => { reads++; return { url: 'https://example.com/', content_type: 'text/plain', text: '人工の公開資料',
    fetched_at: new Date().toISOString(), untrusted: true, truncated: false }; };
  const first = await executeAsyncTurnTool(f.runtime, f.actor, lease, call, 'page-1', undefined, { readPage: reader });
  assert.deepEqual(await executeAsyncTurnTool(f.runtime, f.actor, lease, call, 'page-1', undefined, { readPage: reader }), first);
  assert.equal(reads, 1);
  const other = f.runtime.createAgent(f.actor, '別Bot');
  await executeAsyncTurnTool(f.runtime, f.runtime.agentSession(other.id), lease, call, 'other', undefined, { readPage: reader });
  assert.equal(reads, 1);
  const stopped = await executeAsyncTurnTool(f.runtime, f.actor, lease, call, 'page-2', undefined, { readPage: async () => {
    f.runtime.tasks.interrupt(f.admin, lease); return reader();
  } });
  assert.equal(stopped.error, 'conflict');
  assert.equal(f.runtime.messages(f.admin, f.room.id).length, 0);
});

test('page data fetched during a memory correction is discarded before saving its receipt', async t => {
  const f = fixture(t);
  const source = f.runtime.post(f.admin, f.room.id, '記憶の人工の出所');
  const memory = f.runtime.remember(f.actor, source.id, '古い記憶');
  f.runtime.tasks.create(f.admin, f.leader.id, f.room.id, '公開資料を読む');
  const lease = f.runtime.tasks.claim(f.admin)!;
  const call = { name: 'web_read', tool_call_id: 'page-call', arguments: { url: 'https://example.com/' } };
  let reads = 0;
  const reader = async () => {
    if (++reads === 1) f.runtime.correctMemory(f.admin, f.leader.id, memory.id, 1, '新しい記憶');
    return { url: 'https://example.com/', content_type: 'text/plain', text: `資料${reads}`,
      fetched_at: new Date().toISOString(), untrusted: true, truncated: false };
  };
  assert.equal((await executeAsyncTurnTool(f.runtime, f.actor, lease, call, 'page', undefined, { readPage: reader })).error, 'conflict');
  assert.equal((await executeAsyncTurnTool(f.runtime, f.actor, lease, call, 'page', undefined, { readPage: reader })).text, '資料2');
  assert.equal(reads, 2);
});

test('workspace reads are scoped to the active bot and discard a late reply after stop', async t => {
  const f = fixture(t);
  f.runtime.tasks.create(f.admin, f.leader.id, f.room.id, '共有資料を読む');
  const lease = f.runtime.tasks.claim(f.admin)!;
  let reads = 0;
  const external = { workspace: async () => {
    reads++; f.runtime.tasks.interrupt(f.admin, lease);
    return { content: '停止後に戻った人工資料', untrusted: true };
  } };
  assert.equal(turnTools(true).some(tool => tool.name.startsWith('workspace_')), false);
  assert.equal(turnTools(true, external).filter(tool => tool.name.startsWith('workspace_')).length, 2);
  const call = { name: 'workspace_read', tool_call_id: 'read-shared', arguments: { path: 'research.md' } };
  const other = f.runtime.createAgent(f.actor, '別のBot');
  await executeAsyncTurnTool(f.runtime, f.runtime.agentSession(other.id), lease, call, 'scope', undefined, external);
  assert.equal(reads, 0);
  assert.equal((await executeAsyncTurnTool(f.runtime, f.actor, lease, call, 'read', undefined, external)).error, 'conflict');
  assert.equal(reads, 1); assert.equal(f.runtime.messages(f.admin, f.room.id).length, 0);
});

test('bot can use a shared file read result as a source in its current conversation', async t => {
  const f = fixture(t); let requests = 0;
  const runner = new TurnRunner(f.runtime, async () => model(request => {
    if (++requests === 1) return tool('workspace_read', { path: 'research.md' });
    assert.match(JSON.stringify(request.messages), /前回の人工調査/);
    return complete('前回の調査を確認しました');
  }), { workspace: async (operation, path) => {
    assert.equal(operation, 'read'); assert.equal(path, 'research.md');
    return { content: '前回の人工調査', untrusted: true };
  } });
  const task = f.runtime.tasks.create(f.admin, f.leader.id, f.room.id, '共有資料を確認する');
  await runner.run(f.runtime.tasks.claim(f.admin)!);
  assert.equal(f.runtime.tasks.get(f.admin, task.id).state, 'completed');
  assert.equal(requests, 2);
});

test('shared workspace writes are hidden and rejected in private conversations, and complete in shared work', async t => {
  const f = fixture(t); let writes = 0;
  const external = {
    workspace: async () => ({ entries: [] }),
    workspaceWrite: async (input: { operation_id: string; path: string }) => {
      writes++; assert.match(input.operation_id, /^[a-f0-9-]{36}$/);
      return { path: input.path, revision: 'a'.repeat(64), shared: true };
    },
  };
  assert.equal(turnTools(true, external, false).some(tool => tool.name === 'workspace_write'), false);
  assert.equal(turnTools(true, external, true).some(tool => tool.name === 'workspace_write'), true);
  const privateRoom = f.runtime.createRoom(f.admin, '個別', [f.leader.id]);
  f.runtime.tasks.create(f.admin, f.leader.id, privateRoom.id, '私的な資料');
  const privateLease = f.runtime.tasks.claim(f.admin)!;
  const args = { path: 'report.md', content: '人工の資料', expected_revision: null };
  const rejected = await executeAsyncTurnTool(f.runtime, f.actor, privateLease, { name: 'workspace_write', arguments: args, tool_call_id: 'write' }, 'write', undefined, external);
  assert.ok(rejected.error); assert.equal(writes, 0);
  f.runtime.tasks.finish(f.actor, privateLease, '非共有を維持');
  let requests = 0;
  const runner = new TurnRunner(f.runtime, async () => model(request => {
    assert.ok(request.tools.some(tool => tool.name === 'workspace_write'));
    if (++requests === 1) return tool('workspace_write', args);
    assert.match(JSON.stringify(request.messages), /report.md/);
    return complete('共有資料を保存しました');
  }), external);
  const task = f.runtime.tasks.create(f.admin, f.leader.id, f.room.id, '共有資料を保存');
  await runner.run(f.runtime.tasks.claim(f.admin)!);
  assert.equal(writes, 1); assert.equal(requests, 2);
  assert.equal(f.runtime.tasks.get(f.admin, task.id).state, 'completed');
});

test('one bot can search, read a source and save a sourced artifact through the common tool loop', async t => {
  const f = fixture(t); let requests = 0;
  const runner = new TurnRunner(f.runtime, async () => model(request => {
    assert.ok(request.tools.some(tool => tool.name === 'web_search'));
    switch (++requests) {
      case 1: return tool('web_search', { query: '人工の調査' });
      case 2:
        assert.match(JSON.stringify(request.messages), /https:\/\/example.com\/source/);
        return tool('web_read', { url: 'https://example.com/source' });
      case 3:
        assert.match(JSON.stringify(request.messages), /原文の人工資料/);
        return tool('artifact_create', { name: '調査.md', kind: '資料', description: '出典付き調査', content: '原文の人工資料\n出典: https://example.com/source' });
      default: {
        const latest = request.messages.at(-1)!;
        assert.equal(latest.role, 'user');
        const state = JSON.parse(latest.content!).work_state;
        assert.equal(state.artifacts[0].name, '調査.md');
        assert.equal(state.task.prompt, '出典付き資料を作る');
        assert.equal(state.saved_model_steps, 3);
        return complete('出典付き資料を保存しました');
      }
    }
  }), {
    search: async () => ({ results: [{ title: '人工資料', url: 'https://example.com/source' }], untrusted: true }),
    readPage: async url => ({ url, content_type: 'text/plain', text: '原文の人工資料', fetched_at: new Date().toISOString(), truncated: false, untrusted: true }),
  });
  const task = f.runtime.tasks.create(f.admin, f.leader.id, f.room.id, '出典付き資料を作る');
  await runner.run(f.runtime.tasks.claim(f.admin)!);
  assert.equal(f.runtime.tasks.get(f.admin, task.id).state, 'completed');
  assert.equal(requests, 4);
  assert.equal(f.runtime.artifacts(f.admin).length, 1);
});

test('model tool loop creates one child, delegates, resumes parent and recalls the same child', async t => {
  const f = fixture(t);
  let leaderRequests = 0;
  const runner = new TurnRunner(f.runtime, async agent => model(request => {
    if (agent.role !== 'leader') return complete('子が担当分を完了しました');
    leaderRequests++;
    const child = f.runtime.agents(f.admin).find(item => item.role === 'member');
    if (leaderRequests === 1) return tool('agents_create', { name: '人工の子' });
    if (leaderRequests === 2) return tool('task_delegate', { agent_id: child!.id, prompt: '担当分を調べる' });
    assert.match(JSON.stringify(request.messages), /子が担当分を完了しました/);
    if (leaderRequests === 3) return tool('agents_sleep', { agent_id: child!.id });
    if (leaderRequests === 4) return tool('agents_recall', { agent_id: child!.id });
    return complete('親も結果を確認しました');
  }));
  const task = f.runtime.tasks.create(f.admin, f.leader.id, f.room.id, '仲間と共同作業してください');
  await runner.run(f.runtime.tasks.claim(f.admin)!);
  assert.equal(f.runtime.tasks.get(f.admin, task.id).state, 'waiting_child');
  await runner.run(f.runtime.tasks.claim(f.admin)!);
  await runner.run(f.runtime.tasks.claim(f.admin)!);
  assert.equal(f.runtime.tasks.get(f.admin, task.id).state, 'completed');
  assert.equal(f.runtime.agents(f.admin).length, 2);
  assert.equal(f.runtime.agents(f.admin)[1]?.status, 'active');
  assert.equal(f.runtime.messages(f.admin, f.room.id).filter(message => message.body === '親も結果を確認しました').length, 1);
});

test('an instruction arriving during generation rejects the old response and reaches the next model call', async t => {
  const f = fixture(t);
  const task = f.runtime.tasks.create(f.admin, f.leader.id, f.room.id, '最初の依頼');
  let calls = 0;
  const runner = new TurnRunner(f.runtime, async () => model(request => {
    if (++calls === 1) {
      f.runtime.tasks.instruct(f.admin, task.id, '追加した優先事項');
      return complete('取り消す古い応答');
    }
    assert.match(JSON.stringify(request.messages), /追加した優先事項/);
    return complete('指示に従った応答');
  }));
  await runner.run(f.runtime.tasks.claim(f.admin)!);
  assert.equal(f.runtime.messages(f.admin, f.room.id).length, 0);
  await runner.run(f.runtime.tasks.claim(f.admin)!);
  assert.equal(f.runtime.messages(f.admin, f.room.id)[0]?.body, '指示に従った応答');
  assert.equal(f.runtime.updates(f.admin).filter(item => item.task_id === task.id).length, 1);
});

test('repeated memory corrections discard stale answers without a three-retry manual stop', async t => {
  const f = fixture(t);
  const source = f.runtime.post(f.admin, f.room.id, '人工の出所');
  const memory = f.runtime.remember(f.actor, source.id, '訂正前の秘密');
  let calls = 0;
  const runner = new TurnRunner(f.runtime, async () => model(request => {
    calls++;
    if (calls <= 4) {
      f.runtime.correctMemory(f.admin, f.leader.id, memory.id, calls, `訂正後の情報${calls}`);
      return complete('訂正前の秘密を含む古い応答');
    }
    assert.doesNotMatch(request.system_instructions, /訂正前/);
    assert.match(request.system_instructions, /訂正後/);
    return complete('最新の情報で回答');
  }));
  f.runtime.tasks.create(f.admin, f.leader.id, f.room.id, '回答してください');
  await runner.run(f.runtime.tasks.claim(f.admin)!);
  assert.equal(calls, 5);
  assert.equal(f.runtime.messages(f.admin, f.room.id).some(message => message.body.includes('古い応答')), false);
});

test('a correction after a tool step clears earlier model text and tool results', async t => {
  const f = fixture(t);
  const source = f.runtime.post(f.admin, f.room.id, '人工の出所');
  const memory = f.runtime.remember(f.actor, source.id, '旧記憶の固有文字列');
  let calls = 0;
  const runner = new TurnRunner(f.runtime, async () => model(request => {
    calls++;
    if (calls === 1) return [{ type: 'text_delta', text: '旧記憶の固有文字列' }, ...tool('memory_search', { query: '旧記憶' })];
    if (calls === 2) {
      assert.match(JSON.stringify(request.messages), /旧記憶の固有文字列/);
      f.runtime.correctMemory(f.admin, f.leader.id, memory.id, 1, '更新済みの記憶');
      return complete('破棄される回答');
    }
    assert.doesNotMatch(JSON.stringify(request), /旧記憶の固有文字列/);
    assert.match(request.system_instructions, /更新済みの記憶/);
    return complete('更新後の回答');
  }));
  const task = f.runtime.tasks.create(f.admin, f.leader.id, f.room.id, '記憶を確認');
  await runner.run(f.runtime.tasks.claim(f.admin)!);
  assert.equal(calls, 3);
  assert.equal(f.runtime.tasks.get(f.admin, task.id).state, 'completed');
  assert.doesNotMatch(JSON.stringify(f.runtime.tasks.steps(f.actor, task.id)), /旧記憶の固有文字列/);
});

test('operation replay does not create duplicate bots or resurrect a deleted memory', t => {
  const f = fixture(t);
  const task = f.runtime.tasks.create(f.admin, f.leader.id, f.room.id, '操作');
  const lease = f.runtime.tasks.claim(f.admin)!;
  const profile = { role: '調査', persona: '簡潔で穏やか', shape: 'star', color: '#123456', motion: 'none' };
  const call = { name: 'agents_create', tool_call_id: 'call', arguments: { name: '同じBot', profile } };
  const first = executeTurnTool(f.runtime, f.actor, lease, call, '0:0');
  const replay = executeTurnTool(f.runtime, f.actor, lease, call, '0:0');
  assert.deepEqual(first, replay);
  assert.equal(f.runtime.agents(f.admin).length, 2);
  assert.deepEqual(f.runtime.profile(f.admin, first.id as string), profile);
  assert.equal(f.runtime.agents(f.admin).find(agent => agent.id === first.id)!.role, 'member');
  const forged = { ...call, arguments: { name: '権限変更', profile: { ...profile, provider: 'ollama' } } };
  assert.ok(executeTurnTool(f.runtime, f.actor, lease, forged, '0:1').error);
  assert.equal(f.runtime.agents(f.admin).length, 2);
  const source = f.runtime.post(f.admin, f.room.id, '人工の出所');
  const memory = f.runtime.remember(f.actor, source.id, '消す内容', `${task.id}:memory`);
  f.runtime.deleteMemory(f.admin, f.leader.id, memory.id, 1);
  assert.throws(() => f.runtime.remember(f.actor, source.id, '消す内容', `${task.id}:memory`), /deleted/);
});

test('model transcripts remain private even when the task itself belongs to a shared room', t => {
  const f = fixture(t);
  const child = f.runtime.createAgent(f.actor, '人工の子');
  const task = f.runtime.tasks.create(f.admin, f.leader.id, f.room.id, '共有タスク');
  const lease = f.runtime.tasks.claim(f.admin)!;
  f.runtime.tasks.saveStep(f.actor, lease, 0, complete('内部の応答断片'));
  const childActor = f.runtime.agentSession(child.id);
  assert.equal(f.runtime.tasks.get(childActor, task.id).id, task.id);
  assert.throws(() => f.runtime.tasks.steps(childActor, task.id), /Private memory/);
});

test('initial dialogue asks in the conversation and saves its own identity after the administrator replies', async t => {
  const f = fixture(t); let calls = 0;
  const runner = new TurnRunner(f.runtime, async () => model(request => {
    calls++;
    if (calls === 1) return tool('ask_user', { question: 'どんな名前と話し方にしましょうか？' });
    if (calls === 2) {
      assert.match(JSON.stringify(request.messages), /ハル/);
      return tool('profile_update', { name: 'ハル', persona: '簡潔で穏やかに話す。' });
    }
    assert.match(request.system_instructions, /ハル/); assert.match(request.system_instructions, /簡潔で穏やか/);
    return complete('ハルとして、よろしくお願いします。');
  }));
  const first = f.runtime.submit(f.admin, randomUUID(), f.room.id, '初めまして', f.leader.id);
  await runner.run(f.runtime.tasks.claim(f.admin)!);
  assert.equal(f.runtime.tasks.get(f.admin, first.task!.id).state, 'waiting_user');
  assert.equal(f.runtime.messages(f.admin, f.room.id).at(-1)?.body, 'どんな名前と話し方にしましょうか？');
  const reply = f.runtime.submit(f.admin, randomUUID(), f.room.id, '名前はハル、簡潔で穏やかに話してね', f.leader.id);
  assert.equal(reply.task?.id, first.task!.id);
  await runner.run(f.runtime.tasks.claim(f.admin)!);
  assert.equal(f.runtime.tasks.get(f.admin, first.task!.id).state, 'completed');
  assert.equal(f.runtime.agents(f.admin)[0]?.name, 'ハル');
  assert.equal(f.runtime.profile(f.admin, f.leader.id).persona, '簡潔で穏やかに話す。');
  assert.equal(f.runtime.messages(f.admin, f.room.id).filter(message => message.body.includes('どんな名前')).length, 1);
});

test('long work yields to queued requests and resumes without repeating committed tools', async t => {
  const f = fixture(t); const r = f.runtime;
  const first = r.tasks.create(f.admin, f.leader.id, f.room.id, 'Long work');
  const lease = r.tasks.claim(f.admin)!;
  const second = r.tasks.create(f.admin, f.leader.id, f.room.id, 'New question');
  let calls = 0;
  const runner = new TurnRunner(r, async () => model(() => {
    calls++;
    return calls <= 4 ? tool('decision_report', { title: `Progress ${calls}`, detail: 'Synthetic progress' }) : complete('Finished');
  }));
  await runner.run(lease);
  assert.equal(r.tasks.get(f.admin, first.id).state, 'queued');
  assert.equal(r.tasks.active(f.actor, lease), false);
  const next = r.tasks.claim(f.admin)!; assert.equal(next.task.id, second.id);
  r.tasks.finish(f.actor, next, 'Answered');
  await runner.run(r.tasks.claim(f.admin)!);
  assert.equal(r.tasks.get(f.admin, first.id).state, 'completed');
  assert.equal(calls, 5);
  assert.equal(r.updates(f.admin).filter(item => item.kind === 'decision').length, 4);
});

for (const shared of [false, true]) test(`model instructions reflect room permissions, configured tools and autonomous setting; shared=${shared}`, async t => {
  const f = fixture(t), room = shared ? f.room : f.runtime.createRoom(f.admin, 'Private capability check', [f.leader.id]);
  f.runtime.updateSettings(f.admin, {autonomous: shared});
  f.runtime.updateCommonRules(f.admin, f.runtime.commonRules(f.admin).revision, '人工の事業方針');
  const unavailable = async (): Promise<never> => { throw Error('Capability inspection must not execute tools'); };
  let observed = 0;
  const runner = new TurnRunner(f.runtime, async () => model(request => {
    observed++;
    const line = request.system_instructions.split('\n').find(line => line.startsWith('現在の実行環境: '))!;
    const state = JSON.parse(line.slice('現在の実行環境: '.length));
    assert.equal(state.conversation, shared ? 'shared' : 'private');
    assert.equal(state.autonomous_enabled, shared); assert.equal(state.activity_paused, false);
    assert.equal(state.model_supports_tools, true); assert.equal(state.this_task_autonomous, false);
    for (const name of ['program_run', 'workspace_write', 'web_download']) {
      assert.equal(state.configured_tools_here.includes(name), shared);
      assert.equal(request.tools.some(tool => tool.name === name), shared);
      assert.ok(state.configured_tools_in_shared_room.includes(name));
    }
    assert.ok(!state.configured_tools_in_shared_room.includes('x_post'));
    assert.match(request.system_instructions, /人工の事業方針/);
    assert.match(request.system_instructions, /Niwa全体の未実装と混同しません/);
    return complete('環境を確認しました');
  }), {program: unavailable, workspace: unavailable, workspaceWrite: unavailable});
  f.runtime.tasks.create(f.admin, f.leader.id, room.id, '実行環境を説明してください');
  await runner.run(f.runtime.tasks.claim(f.admin)!); assert.equal(observed, 1);
});
