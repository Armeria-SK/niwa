import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { Runtime } from '../src/runtime/runtime.ts';
import { TurnRunner } from '../src/runtime/turns.ts';
import { Scheduler } from '../src/runtime/scheduler.ts';
import { executeAsyncTurnTool, turnTools } from '../src/runtime/turn-tools.ts';
import { ProgramLog } from '../src/sandbox/program-log.ts';
import { createProgramServer } from '../src/sandbox/server.ts';
import { programExecutor } from '../src/sandbox/client.ts';
import { openAISubscriptionAdapterCapabilities } from '../src/providers/codex/adapter.ts';
import type { ModelAdapter } from '../src/providers/shared/adapter.ts';

const call = { name: 'program_run', arguments: { command: ['python3', 'work.py'], seconds: 30 }, tool_call_id: 'program-call' };
async function fixture(t: { after: (fn: () => Promise<void>) => void }, run: ConstructorParameters<typeof ProgramLog>[2]) {
  const root = mkdtempSync(join(tmpdir(), 'niwa-program-turn-')); const runtime = new Runtime(join(root, 'state'));
  const admin = runtime.administrator(); const leader = runtime.bootstrap(admin); const actor = runtime.agentSession(leader.id); const room = runtime.createRoom(admin, '共有');
  const log = new ProgramLog(join(root, 'programs.db'), 'artificial-environment', run); const broker = createProgramServer(log);
  const path = process.platform === 'win32' ? `\\\\.\\pipe\\niwa-program-${randomUUID()}` : join(root, 'socket'); broker.server.listen(path); await once(broker.server, 'listening');
  t.after(async () => { await broker.stop(); log.close(); runtime.close(); rmSync(root, { recursive: true, force: true }); });
  return { runtime, admin, leader, actor, room, external: { program: programExecutor(path, () => {}) } };
}

test('program tool is shared-only and its IPC result feeds the model loop without repeating completed work', async t => {
  let runs = 0; const f = await fixture(t, async request => { runs++; assert.deepEqual(request, call.arguments); return { code: 0, stdout: 'artificial result', stderr: '' }; });
  assert.equal(turnTools(true, {}, true).some(tool => tool.name === call.name), false);
  assert.equal(turnTools(true, f.external, false).some(tool => tool.name === call.name), false);
  assert.equal(turnTools(false, f.external, true).some(tool => tool.name === call.name), true);
  const privateRoom = f.runtime.createRoom(f.admin, '個別', [f.leader.id]); f.runtime.tasks.create(f.admin, f.leader.id, privateRoom.id, '個別');
  const privateLease = f.runtime.tasks.claim(f.admin)!;
  assert.ok((await executeAsyncTurnTool(f.runtime, f.actor, privateLease, call, '0:0', undefined, f.external)).error); assert.equal(runs, 0);
  f.runtime.tasks.finish(f.actor, privateLease, 'done');
  let modelCalls = 0;
  const adapter: ModelAdapter = { adapter_id: 'artificial', capabilities: openAISubscriptionAdapterCapabilities, async *run(request) {
    if (++modelCalls === 1) { yield { type: 'tool_call', ...call }; yield { type: 'completed', finish_reason: 'tool_calls' }; }
    else { assert.match(JSON.stringify(request.messages), /artificial result/); assert.match(JSON.stringify(request.messages), /untrusted/); yield { type: 'text_delta', text: '完了' }; yield { type: 'completed', finish_reason: 'stop' }; }
  } };
  const task = f.runtime.tasks.create(f.admin, f.leader.id, f.room.id, '計算'); const lease = f.runtime.tasks.claim(f.admin)!;
  const runner = new TurnRunner(f.runtime, async () => adapter, f.external); await runner.run(lease); await runner.run(lease);
  assert.equal(runs, 1); assert.equal(modelCalls, 2); assert.equal(f.runtime.tasks.get(f.admin, task.id).state, 'completed');
});

test('scheduler pause reaches the program service and resume reconciles the pending receipt without rerunning', async t => {
  let started!: () => void; const start = new Promise<void>(resolve => { started = resolve; }); let runs = 0;
  const f = await fixture(t, async (_request, signal) => { runs++; started(); await once(signal!, 'abort'); throw Error('interrupted'); });
  const task = f.runtime.tasks.create(f.admin, f.leader.id, f.room.id, '停止検証');
  const scheduler = new Scheduler(f.runtime, { run: async (lease, signal) => { await executeAsyncTurnTool(f.runtime, f.actor, lease, call, '0:0', signal, f.external); } });
  scheduler.tick(); await start; f.runtime.tasks.pause(f.admin, task.id); scheduler.tick(); await scheduler.stop();
  assert.equal(f.runtime.tasks.get(f.admin, task.id).paused, 1);
  f.runtime.tasks.resume(f.admin, task.id); const resumed = f.runtime.tasks.claim(f.admin)!;
  assert.deepEqual(await executeAsyncTurnTool(f.runtime, f.actor, resumed, call, '0:0', undefined, f.external), { error: 'outcome_unknown' });
  assert.equal(f.runtime.tasks.get(f.admin, task.id).state, 'waiting_user'); assert.equal(runs, 1);
});
