import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runtime } from '../src/runtime/runtime.ts';
import { TurnRunner } from '../src/runtime/turns.ts';
import type { ModelRequest, ModelEvent } from '../src/contracts/model.ts';
import type { ModelAdapter } from '../src/providers/shared/adapter.ts';
import { openAISubscriptionAdapterCapabilities } from '../src/providers/codex/adapter.ts';

const text = (content: string): ModelEvent[] => [{ type: 'text_delta', text: content }, { type: 'completed', finish_reason: 'stop' }];
const tool = (name: string, args: Record<string, unknown>): ModelEvent[] => [{ type: 'tool_call', tool_call_id: 'artificial', name, arguments: args }, { type: 'completed', finish_reason: 'tool_calls' }];
const model = (reply: (request: ModelRequest) => ModelEvent[]): ModelAdapter => ({ adapter_id: 'artificial', capabilities: openAISubscriptionAdapterCapabilities,
  async *run(request) { yield* request.tools.length === 1 && request.tools[0]!.name === 'memory_review' ? tool('memory_review', { memories: [] }) : reply(request); } });

test('research completion waits for a sourced summary and resumes after restart without repeating the research or reply', async t => {
  const root = mkdtempSync(join(tmpdir(), 'niwa-completion-summary-'));
  let runtime = new Runtime(root); t.after(() => { runtime.close(); rmSync(root, { recursive: true, force: true }); });
  let admin = runtime.administrator(); const leader = runtime.bootstrap(admin); let actor = runtime.agentSession(leader.id);
  const room = runtime.createRoom(admin, '調査'); runtime.post(admin, room.id, '花の資料を調べて');
  const task = runtime.tasks.create(admin, leader.id, room.id, '花の調査'); let reads = 0, normalCalls = 0, summaryCalls = 0;
  let interrupt = true;
  const adapter = model(request => {
    if (request.tools.length === 1 && request.tools[0]!.name === 'task_summary_save') {
      summaryCalls++;
      assert.equal(runtime.tasks.get(admin, task.id).state, 'running');
      assert.equal(runtime.messages(admin, room.id).length, 1);
      const state = JSON.parse(request.messages.at(-1)!.content!).work_state;
      assert.match(JSON.stringify(state.proposed_completion), /確認しました/);
      assert.equal(state.summary_sources.some((source: { kind: string; source_id: string }) => source.kind === 'task' && source.source_id === task.id), false);
      if (interrupt) { interrupt = false; runtime.tasks.interrupt(admin, currentLease); }
      return tool('task_summary_save', { conclusion: '花の人工資料を確認した。', reason: '公開資料の読取結果による。', unresolved: ['実地確認はまだ'], next_steps: ['実地で確認する'],
        sources: state.summary_sources.map(({ kind, source_id, revision }: { kind: string; source_id: string; revision: string }) => ({ kind, source_id, revision })) });
    }
    if (++normalCalls === 1) return tool('web_read', { url: 'https://example.com/flowers' });
    return text('資料を確認しました。');
  });
  const external = { readPage: async (url: string) => { reads++; return { url, content_type: 'text/plain', text: '花に関する人工資料', fetched_at: new Date().toISOString(), untrusted: true, truncated: false }; } };
  let currentLease = runtime.tasks.claim(admin)!;
  await new TurnRunner(runtime, async () => adapter, external).run(currentLease);
  assert.equal(runtime.tasks.get(admin, task.id).state, 'queued');
  assert.equal(runtime.messages(admin, room.id).length, 1);
  runtime.close(); runtime = new Runtime(root); admin = runtime.administrator(); actor = runtime.agentSession(leader.id);
  currentLease = runtime.tasks.claim(admin)!;
  await new TurnRunner(runtime, async () => adapter, external).run(currentLease);
  assert.equal(runtime.tasks.get(admin, task.id).state, 'completed');
  assert.equal(reads, 1); assert.equal(normalCalls, 2); assert.equal(summaryCalls, 2);
  assert.equal(runtime.messages(admin, room.id).length, 2);
  const summary = runtime.readHistory(actor, room.id, 'summary', task.id);
  assert.match(String(summary.text), /花の人工資料を確認した/);
  assert.match(String(summary.text), /completed/);
  assert.equal(runtime.searchHistory(actor, room.id, '実地確認').some(item => item.kind === 'summary'), true);
});

test('an unrelated tool during completion summarization is not executed and the saved reply can resume', async t => {
  const root = mkdtempSync(join(tmpdir(), 'niwa-summary-retry-')); const runtime = new Runtime(root);
  t.after(() => { runtime.close(); rmSync(root, { recursive: true, force: true }); });
  const admin = runtime.administrator(), leader = runtime.bootstrap(admin), actor = runtime.agentSession(leader.id), room = runtime.createRoom(admin, '仕事');
  runtime.post(admin, room.id, '仕事の計画');
  const task = runtime.tasks.create(admin, leader.id, room.id, '計画を作る'); let calls = 0, valid = false;
  const adapter = model(request => {
    if (request.tools.length === 1 && request.tools[0]!.name === 'task_summary_save') {
      if (!valid) return tool('agents_create', { name: '作成しない' });
      const source = JSON.parse(request.messages.at(-1)!.content!).work_state.summary_sources[0];
      return tool('task_summary_save', { conclusion: '計画を確認', reason: 'ユーザーの依頼', unresolved: [], next_steps: [],
        sources: [{ kind: source.kind, source_id: source.source_id, revision: source.revision }] });
    }
    return ++calls === 1 ? tool('task_plan_update', { expected_revision: 0, remaining: ['確認する'] }) : text('計画を確認しました。');
  });
  await new TurnRunner(runtime, async () => adapter).run(runtime.tasks.claim(admin)!);
  assert.equal(runtime.tasks.get(admin, task.id).state, 'waiting_provider');
  assert.equal(runtime.agents(admin).length, 1); assert.equal(runtime.messages(admin, room.id).length, 1);
  valid = true; runtime.tasks.resume(admin, task.id);
  await new TurnRunner(runtime, async () => adapter).run(runtime.tasks.claim(admin)!);
  assert.equal(runtime.tasks.get(admin, task.id).state, 'completed');
  assert.equal(calls, 2); assert.equal(runtime.messages(admin, room.id).length, 2);
  assert.match(String(runtime.readHistory(actor, room.id, 'summary', task.id).text), /計画を確認/);
});
