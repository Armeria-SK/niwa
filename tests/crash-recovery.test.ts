import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';

type State = { paused: boolean; tasks: { id: string; state: string }[]; schedules: { id: string; run_count: number }[]; artifacts: number; memories: number; messages: number };
async function worker(root: string, mode: string) {
  const child = fork(new URL('./fixtures/crash-worker.js', import.meta.url), [root, mode], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  await once(child, 'message'); let serial = 0;
  const call = (action: string) => new Promise<State>((resolve, reject) => {
    const id = ++serial;
    const receive = (message: { id: number; state: State; error?: string }) => { if (message.id === id) { child.off('message', receive); message.error ? reject(Error(message.error)) : resolve(message.state); } };
    child.on('message', receive); child.send({ id, action });
  });
  return { child, call, async kill() { const exited = once(child, 'exit'); child.kill('SIGKILL'); const [, signal] = await exited; assert.equal(signal, 'SIGKILL'); } };
}
for (const paused of [false, true]) test(`SIGKILL releases service lock and recovers durable work once; paused=${paused}`, { timeout: 20_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'niwa-crash-')); let current: Awaited<ReturnType<typeof worker>> | undefined;
  t.after(() => { current?.child.kill('SIGKILL'); rmSync(root, { recursive: true, force: true }); });
  current = await worker(root, 'before'); await current.call('seed');
  let before: State;
  do { await setTimeout(50); before = await current.call('state'); } while (before.artifacts !== 1);
  assert.equal(before.tasks.length, 1); assert.equal(before.schedules[0]!.run_count, 1);
  if (paused) await current.call('pause');
  await current.kill(); current = await worker(root, 'after');
  let after = await current.call('state');
  assert.equal(after.paused, paused); assert.equal(after.memories, before.memories); assert.equal(after.artifacts, 1);
  if (paused) { await setTimeout(250); after = await current.call('state'); assert.equal(after.tasks[0]!.state, 'queued'); await current.call('resume'); }
  do { await setTimeout(50); after = await current.call('state'); } while (after.tasks[0]!.state !== 'completed');
  assert.equal(after.tasks[0]!.id, before.tasks[0]!.id); assert.equal(after.tasks.length, 1); assert.equal(after.artifacts, 1); assert.equal(after.schedules[0]!.run_count, 1);
  assert.ok(after.messages >= before.messages);
  const exited = once(current.child, 'exit'); await current.call('close'); await exited; current = undefined;
});
