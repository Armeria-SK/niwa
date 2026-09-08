import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createBrowserServer } from '../src/tools/browser/server.ts';
import { browserExecutor } from '../src/tools/browser/client.ts';
import { Runtime } from '../src/runtime/runtime.ts';
import { executeAsyncTurnTool, turnTools } from '../src/runtime/turn-tools.ts';
import type { BrowserSnapshot } from '../src/tools/browser/page.ts';

const snapshot = (title: string): BrowserSnapshot => ({ title, url: 'https://fixture.invalid/', revision: title,
  text: 'synthetic public page', elements: [{ ref: 0, role: 'a', name: 'Next', href: 'https://fixture.invalid/next' }], blocked: [], untrusted: true });
async function fixture(t: { after(fn: () => Promise<void>): void }, create: Parameters<typeof createBrowserServer>[0]) {
  const root = mkdtempSync(join(tmpdir(), 'niwa-browser-service-'));
  const path = process.platform === 'win32' ? `\\\\.\\pipe\\niwa-browser-${randomUUID()}` : join(root, 'socket');
  const server = createBrowserServer(create); server.server.listen(path); await once(server.server, 'listening');
  t.after(async () => { await server.stop(); rmSync(root, { recursive: true, force: true }); });
  return { root, execute: browserExecutor(path, () => {}) };
}

test('browser IPC separates Bot and conversation sessions and expires failed references', async t => {
  let created = 0, closed = 0;
  const f = await fixture(t, () => {
    const title = String(++created);
    return { navigate: async () => snapshot(title), snapshot: async () => snapshot(title),
      follow: async revision => { if (revision !== title) throw Error('stale'); return snapshot(title); }, close: async () => { closed++; } };
  });
  const base = { agent_id: 'one', room_id: 'room', task_id: 'task' };
  assert.equal((await f.execute({ ...base, action: { kind: 'navigate', url: 'https://fixture.invalid/' } })).title, '1');
  assert.equal((await f.execute({ ...base, action: { kind: 'snapshot' } })).title, '1');
  await assert.rejects(f.execute({ ...base, agent_id: 'two', action: { kind: 'follow', revision: '1', ref: 0 } }));
  assert.equal(created, 1);
  assert.equal((await f.execute({ ...base, room_id: 'other', action: { kind: 'navigate', url: 'https://fixture.invalid/' } })).title, '2');
  await assert.rejects(f.execute({ ...base, action: { kind: 'follow', revision: '2', ref: 0 } })); assert.equal(closed, 1);
  await assert.rejects(f.execute({ ...base, action: { kind: 'snapshot' } }));
  assert.equal((await f.execute({ ...base, action: { kind: 'navigate', url: 'https://fixture.invalid/' } })).title, '3');
});

test('browser tool supplies runtime identity, caches completed reads and refuses forged arguments or stopped tasks', async t => {
  let reads = 0;
  let runtime!: Runtime; t.after(async () => runtime?.close());
  const f = await fixture(t, () => ({ navigate: async () => { reads++; return snapshot('observed'); },
    snapshot: async () => snapshot('observed'), follow: async () => snapshot('observed'), close: async () => {} }));
  runtime = new Runtime(join(f.root, 'state'));
  const admin = runtime.administrator(), leader = runtime.bootstrap(admin), actor = runtime.agentSession(leader.id), room = runtime.createRoom(admin, 'browser');
  const task = runtime.tasks.create(admin, leader.id, room.id, 'read'); const lease = runtime.tasks.claim(admin)!;
  const external = { browser: f.execute };
  assert.equal(turnTools(true).some(tool => tool.name.startsWith('browser_')), false);
  assert.deepEqual(turnTools(false, external).filter(tool => tool.name.startsWith('browser_')).map(tool => tool.name).sort(),
    ['browser_follow', 'browser_form_prepare', 'browser_interact', 'browser_navigate', 'browser_snapshot']);
  const call = { name: 'browser_navigate', tool_call_id: 'synthetic', arguments: { url: 'https://fixture.invalid/' } };
  assert.equal((await executeAsyncTurnTool(runtime, actor, lease, { ...call, arguments: { ...call.arguments, agent_id: 'other' } }, 'bad', undefined, external)).error, 'Invalid tool arguments');
  const first = await executeAsyncTurnTool(runtime, actor, lease, call, 'read', undefined, external);
  assert.equal(first.untrusted, true); assert.equal(first.title, 'observed');
  assert.deepEqual(await executeAsyncTurnTool(runtime, actor, lease, call, 'read', undefined, external), first); assert.equal(reads, 1);
  runtime.tasks.pause(admin, task.id);
  assert.ok((await executeAsyncTurnTool(runtime, actor, lease, call, 'later', undefined, external)).error); assert.equal(reads, 1);
});

test('browser IPC cancellation reaches the session and disposes its page', async t => {
  let started!: () => void, disposed!: () => void;
  const start = new Promise<void>(resolve => { started = resolve; }), disposal = new Promise<void>(resolve => { disposed = resolve; });
  const f = await fixture(t, () => ({ navigate: async (_url, signal) => { started(); await once(signal!, 'abort'); throw Error('stopped'); },
    snapshot: async () => snapshot('none'), follow: async () => snapshot('none'), close: async () => { disposed(); } }));
  const controller = new AbortController();
  const pending = f.execute({ agent_id: 'bot', room_id: 'room', task_id: 'task', action: { kind: 'navigate', url: 'https://fixture.invalid/' } }, controller.signal);
  await start; controller.abort(); await assert.rejects(pending); await disposal;
});
