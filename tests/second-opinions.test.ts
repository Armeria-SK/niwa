import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Runtime } from '../src/runtime/runtime.ts';
import { SecondOpinions, type SelectAdapter } from '../src/runtime/second-opinions.ts';
import { openAISubscriptionAdapterCapabilities } from '../src/providers/codex/adapter.ts';
import type { ModelRequest } from '../src/contracts/model.ts';
import { DomainError } from '../src/domain/types.ts';

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'niwa-opinion-'));
  const runtime = new Runtime(root);
  const db = new DatabaseSync(join(root, 'control.db'));
  t.after(() => { db.close(); runtime.close(); rmSync(root, { recursive: true, force: true }); });
  const admin = runtime.administrator(), leader = runtime.bootstrap(admin), bot = runtime.agentSession(leader.id);
  return { root, runtime, db, admin, leader, bot };
}
/** An artificial model that records what it was sent and answers with fixed text; no provider is called. */
function artificial(reply: string, sent: { selection: unknown; request: ModelRequest }[] = []): SelectAdapter {
  return async selection => ({ adapter_id: 'anthropic', capabilities: openAISubscriptionAdapterCapabilities, context_window: 200_000,
    async *run(request) {
      sent.push({ selection, request });
      yield { type: 'text_delta' as const, text: reply };
      yield { type: 'usage' as const, input_tokens: 1200, output_tokens: 80, total_tokens: 1280 };
      yield { type: 'completed' as const, finish_reason: 'stop' as const };
    } });
}
const claude = { provider: 'anthropic' as const, model: 'claude-artificial', reasoning: 'medium' };

test('another model answers with the same Bot, memories and earlier conversation, and nothing is posted until kept', async t => {
  const { runtime, db, admin, leader, bot } = fixture(t);
  const shared = runtime.createRoom(admin, '共有の相談'), hidden = runtime.createRoom(admin, '個別', [leader.id]);
  const told = runtime.post(admin, shared.id, '集合は駅の北口にしましょう');
  const secret = runtime.post(admin, hidden.id, '個別の合言葉は青い鳥');
  runtime.remember(bot, told.id, '集合は駅の北口'); runtime.remember(bot, secret.id, '合言葉は青い鳥');
  const task = runtime.tasks.create(admin, leader.id, shared.id, '集合場所を案内文にまとめて');
  const answer = runtime.post(bot, shared.id, '集合は北口です。');
  runtime.tasks.linkMessage(admin, answer.id, task.id, 'response');
  runtime.post(admin, shared.id, 'このあとの発言');
  const sent: { selection: unknown; request: ModelRequest }[] = [];
  const opinions = new SecondOpinions(runtime, artificial('北口の改札を出たところに集合です。', sent));

  const estimate = opinions.estimate(admin, shared.id, answer.id);
  assert.equal(estimate.messages, 1); assert.equal(estimate.memories, 1); assert.ok(estimate.estimated_input_tokens > 0);
  assert.equal(estimate.agent_id, leader.id);
  const result = await opinions.ask(admin, shared.id, answer.id, claude);
  assert.ok('answer' in result && result.answer === '北口の改札を出たところに集合です。');
  assert.equal(sent.length, 1);
  const request = sent[0]!.request;
  assert.deepEqual(request.tools, []);
  assert.match(request.system_instructions, /集合は駅の北口/);
  assert.doesNotMatch(request.system_instructions, /青い鳥/);
  assert.equal(request.messages.length, 2);
  assert.match(request.messages[0]!.content ?? '', /駅の北口にしましょう/);
  assert.equal(request.messages[1]!.content, '現在の依頼: 集合場所を案内文にまとめて');
  assert.ok(!JSON.stringify(request).includes('集合は北口です。'), 'the compared answer itself is not shown to the other model');
  assert.ok(!JSON.stringify(request).includes('このあとの発言'));
  assert.equal(request.reasoning_effort, 'medium');

  // Usage counts like any other call, with no task; the Bot's model route is untouched.
  const runs = db.prepare('SELECT task_id,phase,status,input_tokens,output_tokens FROM prompt_runs').all();
  assert.deepEqual(runs.map(row => ({ ...row })), [{ task_id: null, phase: 'second_opinion', status: 'completed', input_tokens: 1200, output_tokens: 80 }]);
  assert.deepEqual(runtime.tasks.usageSince(admin, 0), { since: 0, calls: 1, input: 1200, output: 80, estimated: 0 });
  assert.equal(runtime.modelRoutes(admin).find(row => row.id === leader.id)!.provider, null);
  assert.equal(runtime.messages(admin, shared.id).length, 3);

  const kept = opinions.keep(admin, (result as { id: string }).id);
  assert.equal(kept.author_id, leader.id); assert.equal(kept.reply_to, answer.id);
  assert.match(kept.body, /^（別のモデルでの答え：Claude claude-artificial・推論 medium）\n北口の改札/);
  assert.equal(opinions.keep(admin, (result as { id: string }).id).id, kept.id, 'keeping twice posts once');
  assert.equal(runtime.messages(admin, shared.id).length, 4);
});

test('a comparison needs a Bot message and another model, and a failed call is shown, counted and never kept', async t => {
  const { runtime, db, admin, leader, bot } = fixture(t);
  const room = runtime.createRoom(admin, '相談');
  const asked = runtime.post(admin, room.id, '質問です');
  const answer = runtime.post(bot, room.id, '答えです');
  const opinions = new SecondOpinions(runtime, async () => ({ adapter_id: 'local-llm', capabilities: openAISubscriptionAdapterCapabilities,
    async *run() { yield { type: 'failed' as const, error: { code: 'RATE_LIMITED' as const, message: '混雑しています', retryable: true } }; } }));
  await assert.rejects(opinions.ask(admin, room.id, asked.id, claude), (error: unknown) => error instanceof DomainError && error.code === 'invalid');
  const own = { provider: leader.provider, model: leader.model, reasoning: leader.reasoning };
  await assert.rejects(opinions.ask(admin, room.id, answer.id, own), (error: unknown) => error instanceof DomainError && error.code === 'invalid');
  const failed = await opinions.ask(admin, room.id, answer.id, claude);
  assert.deepEqual('failure' in failed && failed.failure, { code: 'RATE_LIMITED', message: '混雑しています' });
  assert.equal(db.prepare("SELECT count(*) AS n FROM prompt_runs WHERE task_id IS NULL AND status='failed'").get()!.n, 1);
  // Setting up the connection failed before any call: nothing is counted.
  const offline = new SecondOpinions(runtime, async () => { throw new Error('no connection'); });
  assert.equal(('failure' in (await offline.ask(admin, room.id, answer.id, claude))), true);
  assert.equal(db.prepare('SELECT count(*) AS n FROM prompt_runs').get()!.n, 1);
  assert.throws(() => opinions.keep(admin, '00000000-0000-4000-8000-000000000000'), (error: unknown) => error instanceof DomainError && error.code === 'not_found');
});

test('a model check comes from another provider, is saved per condition, and never verifies, blocks or freezes a version', async t => {
  const { runtime, admin, leader, bot } = fixture(t);
  const room = runtime.createRoom(admin, '資料');
  const id = runtime.createArtifact(bot, room.id, '案内文.md', 'document', '集合場所の案内', '集合は北口です。');
  const item = runtime.artifactVersions.inspect(admin, id);
  const sent: { selection: unknown; request: ModelRequest }[] = [];
  const opinions = new SecondOpinions(runtime, artificial('```json\n{"checks":[{"criterion":"overall","verdict":"fail","note":"時刻が書かれていません。"}],"summary":"時刻を足してください。"}\n```', sent));
  const estimate = opinions.checkEstimate(admin, id);
  assert.ok(!estimate.providers.includes(leader.provider)); assert.equal(estimate.criteria, 1);
  await assert.rejects(opinions.check(admin, id, item.sha256, { provider: leader.provider, model: 'same-company', reasoning: 'medium' }), (error: unknown) => error instanceof DomainError && error.code === 'invalid');
  await assert.rejects(opinions.check(admin, id, 'f'.repeat(64), claude), (error: unknown) => error instanceof DomainError && error.code === 'conflict');
  const result = await opinions.check(admin, id, item.sha256, claude);
  assert.ok('verdict' in result && result.verdict === 'changes_requested');
  assert.match(JSON.stringify(sent[0]!.request.messages), /集合は北口です。/);

  const after = runtime.artifactVersions.inspect(admin, id);
  assert.deepEqual(after.reviews, []);
  assert.equal(after.model_checks!.length, 1);
  assert.equal(after.model_checks![0]!.review_model, 'anthropic/claude-artificial/medium');
  assert.deepEqual(JSON.parse(String(after.model_checks![0]!.checks)), [{ criterion: 'overall', verdict: 'fail', note: '時刻が書かれていません。' }]);
  assert.equal(after.quality_status, 'unchecked', 'the model opinion does not mark the version for changes');
  assert.equal('model_checks' in runtime.artifactVersions.inspect(bot, id), false, 'Bots never read model checks');
  assert.throws(() => runtime.artifactVersions.freeze(admin, id, item.sha256), (error: unknown) => error instanceof DomainError && error.code === 'conflict');
  // The administrator's own review still decides, whatever the model said.
  runtime.artifactVersions.review(admin, id, item.sha256, 'approved', '時刻は別の案内で伝えるので、このままでよいです。');
  assert.equal(runtime.artifactVersions.inspect(admin, id).quality_status, 'reviewed');
  assert.deepEqual(runtime.artifactVersions.freeze(admin, id, item.sha256), { frozen: true, sha256: item.sha256 });

  // An approving model check alone never permits freezing another version either.
  const next = runtime.createArtifact(bot, room.id, '案内文2.md', 'document', '集合場所の案内', '集合は北口、10時です。');
  const nextItem = runtime.artifactVersions.inspect(admin, next);
  const approving = new SecondOpinions(runtime, artificial('{"checks":[{"criterion":"overall","verdict":"pass","note":"時刻と場所があります。"}],"summary":"十分です。"}'));
  assert.equal(('verdict' in (await approving.check(admin, next, nextItem.sha256, claude))) && 'approved', 'approved');
  assert.equal(runtime.artifactVersions.inspect(admin, next).quality_status, 'unchecked');
  assert.throws(() => runtime.artifactVersions.freeze(admin, next, nextItem.sha256), (error: unknown) => error instanceof DomainError && error.code === 'conflict');
  // An unreadable reply is shown as a failure and nothing is saved.
  const vague = new SecondOpinions(runtime, artificial('よさそうです'));
  assert.equal('failure' in (await vague.check(admin, next, nextItem.sha256, { ...claude, model: 'claude-other' })), true);
  assert.equal(runtime.artifactVersions.inspect(admin, next).model_checks!.length, 1);
  assert.equal(runtime.tasks.usageSince(admin, 0).calls, 3);
});

test('prompt runs accept calls without a task after upgrading, and the change replays safely', t => {
  const { root, runtime, db } = fixture(t);
  const column = () => db.prepare('PRAGMA table_info(prompt_runs)').all().find(row => row.name === 'task_id')!;
  assert.equal(column().notnull, 0);
  const latest = db.prepare('PRAGMA user_version').get()!.user_version;
  runtime.close();
  db.exec('PRAGMA user_version=57');
  const reopened = new Runtime(root);
  try {
    assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, latest);
    assert.equal(column().notnull, 0);
    assert.equal(db.prepare('PRAGMA quick_check').get()!.quick_check, 'ok');
  } finally { reopened.close(); }
});
