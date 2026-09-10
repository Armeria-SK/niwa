import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {Runtime} from '../src/runtime/runtime.ts';

function fixture(t: {after(fn: () => void): void}) {
  const root = mkdtempSync(join(tmpdir(), 'niwa-autonomy-boundary-'));
  let r = new Runtime(root);
  const admin = r.administrator(), leader = r.bootstrap(admin), actor = r.agentSession(leader.id);
  const bot = r.createAgent(actor, '担当'), reviewer = r.createAgent(actor, '確認係'), room = r.createRoom(admin, '共同作業');
  t.after(() => {r.close(); rmSync(root, {recursive: true, force: true});});
  return {r, admin, leader, actor, bot, reviewer, room, reopen() {r.close(); r = new Runtime(root); return r;}};
}

for (const mode of ['global', 'individual'] as const) {
  test(`user work, addressed replies and delegated results continue with ${mode} autonomy off`, t => {
    const f = fixture(t), {r, admin, actor, leader, bot, reviewer, room} = f;
    if (mode === 'global') r.updateSettings(admin, {autonomous: false});
    else for (const member of [leader, bot, reviewer]) r.autonomousWakes.configure(admin, member.id, false);
    const root = r.tasks.create(admin, leader.id, room.id, '人工の資料を共同で確認してください');
    r.respond(actor, r.tasks.claim(admin)!, '資料の確認をお願いします。', [bot.id]);
    const addressed = r.tasks.list(admin).find(task => task.parent_id === root.id)!;
    assert.ok(r.tasks.queuedRequestAgents(admin).has(bot.id));
    assert.ok(!r.tasks.autonomyBlocked(admin).has(addressed.id));
    const reply = r.tasks.claim(admin)!;
    assert.equal(reply?.task.id, addressed.id);
    const botActor = r.agentSession(bot.id);
    assert.equal(r.tasks.workState(botActor, reply).autonomous, false);
    assert.equal(r.tasks.executionAllowed(botActor, reply.task.id, reply.token, false), true);
    const child = r.tasks.delegate(botActor, reply, reviewer.id, '確認結果を返してください');
    const review = r.tasks.claim(admin)!;
    assert.equal(review.task.id, child.id);
    r.respond(r.agentSession(reviewer.id), review, '確認が終わりました。', [bot.id]);
    const continued = r.tasks.claim(admin)!;
    assert.equal(continued.task.id, addressed.id);
    r.respond(botActor, continued, '確認結果をまとめました。', []);
    assert.equal(r.tasks.get(admin, root.id).state, 'completed');
    assert.equal(r.tasks.get(admin, addressed.id).state, 'completed');
    assert.equal(r.tasks.list(admin).length, 3);
    assert.equal(r.tasks.claim(admin), undefined);
  });

  test(`switching ${mode} autonomy off retains a running user reply and recovers the same work after restart`, t => {
    const f = fixture(t), {r, admin, actor, leader, bot, room} = f;
    r.tasks.create(admin, leader.id, room.id, '人工の依頼');
    r.respond(actor, r.tasks.claim(admin)!, '確認をお願いします。', [bot.id]);
    const reply = r.tasks.claim(admin)!, botActor = r.agentSession(bot.id);
    if (mode === 'global') r.updateSettings(admin, {autonomous: false});
    else r.autonomousWakes.configure(admin, bot.id, false);
    assert.equal(r.tasks.active(botActor, reply), true);
    assert.equal(r.tasks.executionAllowed(botActor, reply.task.id, reply.token, false), true);
    let calls = 0;
    const input = {source: 'synthetic'};
    const saved = r.tasks.once(botActor, reply, 'read', input, () => {calls++; return {value: 42};});
    r.tasks.updatePlan(botActor, reply, 'plan', 0, ['前の結果を使って仕上げる']);
    const reopened = f.reopen(), a = reopened.administrator();
    reopened.tasks.recover(a);
    const resumed = reopened.tasks.claim(a)!;
    assert.equal(resumed.task.id, reply.task.id);
    assert.deepEqual(reopened.tasks.workState(reopened.agentSession(bot.id), resumed).remaining_plan.remaining, ['前の結果を使って仕上げる']);
    assert.deepEqual(reopened.tasks.once(reopened.agentSession(bot.id), resumed, 'read', input, () => {calls++; return {};}), saved);
    assert.equal(calls, 1);
    reopened.respond(reopened.agentSession(bot.id), resumed, '仕上げました。', []);
    assert.equal(reopened.tasks.list(a).length, 2);
    assert.equal(reopened.messages(a, room.id).length, 2);
  });
}

test('normal reply permission does not bypass task pause, global pause, archive, approval or private-room access', t => {
  const {r, admin, actor, leader, bot, reviewer, room} = fixture(t);
  r.updateSettings(admin, {autonomous: false});
  r.tasks.create(admin, leader.id, room.id, '人工依頼');
  r.respond(actor, r.tasks.claim(admin)!, '確認してください。', [bot.id]);
  const reply = r.tasks.claim(admin)!, botActor = r.agentSession(bot.id);
  r.tasks.pause(admin, reply.task.id);
  assert.equal(r.tasks.active(botActor, reply), false);
  assert.equal(r.tasks.claim(admin), undefined);
  r.tasks.resume(admin, reply.task.id);
  r.updateSettings(admin, {paused: true}); assert.equal(r.tasks.claim(admin), undefined);
  r.updateSettings(admin, {paused: false});
  r.organizeRoom(admin, room.id, {archived: true}); assert.equal(r.tasks.claim(admin), undefined);
  r.organizeRoom(admin, room.id, {archived: false});
  const resumed = r.tasks.claim(admin)!;
  assert.equal(resumed.task.id, reply.task.id);
  assert.equal(r.authorizeAction(botActor, resumed, 'send', '人工送信', {destination: 'synthetic'}), false);
  assert.equal(r.tasks.get(admin, reply.task.id).state, 'waiting_user');
  assert.equal(r.tasks.claim(admin), undefined);
  const privateRoom = r.createRoom(admin, '個別', [leader.id]);
  r.tasks.create(admin, leader.id, privateRoom.id, '個別の依頼');
  assert.throws(() => r.respond(actor, r.tasks.claim(admin)!, '個別の情報', [reviewer.id]), /Room unavailable/);
  assert.equal(r.messages(admin, privateRoom.id).length, 0);
});

test('autonomous origin remains gated through replies and delegation, with the original shared call allowance', t => {
  const {r, admin, actor, leader, bot, reviewer} = fixture(t), now = Date.now();
  r.autonomousWakes.dispatch(admin, now); r.autonomousWakes.dispatch(admin, now + 60_000);
  const origin = r.tasks.claim(admin)!;
  assert.equal(origin.task.agent_id, leader.id);
  for (let i = 0; i < 23; i++) assert.equal(r.tasks.reserveModelCall(actor, origin), true);
  r.respond(actor, origin, '人工の調査について確認してください。', [bot.id]);
  const reply = r.tasks.claim(admin)!, botActor = r.agentSession(bot.id);
  assert.equal(r.tasks.workState(botActor, reply).autonomous, true);
  r.tasks.delegate(botActor, reply, reviewer.id, '調査結果を確認してください');
  const delegated = r.tasks.claim(admin)!, reviewerActor = r.agentSession(reviewer.id);
  r.autonomousWakes.configure(admin, bot.id, false);
  assert.equal(r.tasks.active(reviewerActor, delegated), false);
  assert.equal(r.tasks.claim(admin), undefined);
  r.autonomousWakes.configure(admin, bot.id, true);
  r.updateSettings(admin, {autonomous: false});
  assert.equal(r.tasks.claim(admin), undefined);
  r.updateSettings(admin, {autonomous: true});
  const resumed = r.tasks.claim(admin)!;
  assert.equal(resumed.task.id, delegated.task.id);
  assert.equal(r.tasks.reserveModelCall(reviewerActor, resumed), true);
  assert.equal(r.tasks.reserveModelCall(reviewerActor, resumed), false);
  assert.equal(r.tasks.get(admin, resumed.task.id).state, 'waiting_provider');
  assert.ok(r.tasks.get(admin, resumed.task.id).provider_retry_at! > now);
  assert.equal(r.tasks.list(admin).length, 3);
});

for (const autonomous of [false, true]) {
  test(`schedule autonomy=${autonomous} is retained by addressed work when autonomy is switched off`, t => {
    const {r, admin, actor, leader, bot, room} = fixture(t);
    const schedule = {id: randomUUID(), agent_id: leader.id, room_id: room.id, prompt: '人工の予定',
      interval_ms: 60_000, next_at: Date.now() + 60_000, max_runs: 1, timeout_ms: 60_000, autonomous};
    r.schedules.create(admin, schedule); r.schedules.dispatch(admin, schedule.next_at);
    r.respond(actor, r.tasks.claim(admin)!, '結果を確認してください。', [bot.id]);
    const reply = r.tasks.list(admin).at(-1)!;
    r.updateSettings(admin, {autonomous: false});
    assert.equal(r.tasks.claim(admin)?.task.id, autonomous ? undefined : reply.id);
    assert.equal(r.tasks.list(admin).length, 2);
  });
}
