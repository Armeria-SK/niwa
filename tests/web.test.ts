import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { request } from 'node:http';
import { Runtime } from '../src/runtime/runtime.ts';
import { WebAuth } from '../src/web/auth.ts';
import { createApiServer } from '../src/web/api.ts';

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = mkdtempSync(join(tmpdir(), 'niwa-web-'));
  const runtime = new Runtime(root); const admin = runtime.administrator(); const leader = runtime.bootstrap(admin);
  const key = randomBytes(32).toString('base64url'); const origin = 'https://niwa.test';
  const server = createApiServer(runtime, new WebAuth(origin, key));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address() as { port: number };
  t.after(async () => { await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); runtime.close(); rmSync(root, { recursive: true, force: true }); });
  let cookie = '';
  const call = (path: string, method = 'GET', body?: unknown, extra: Record<string, string> = {}) => new Promise<Response>((resolve, reject) => {
    const outgoing = request(`http://127.0.0.1:${address.port}${path}`, {
      method, headers: { host: 'niwa.test', origin, cookie, 'content-type': 'application/json',
        ...(body === undefined ? {} : { 'content-length': Buffer.byteLength(JSON.stringify(body)) }), ...extra },
    }, incoming => {
      const chunks: Buffer[] = [];
      incoming.on('data', chunk => chunks.push(Buffer.from(chunk)));
      incoming.on('end', () => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) if (value) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
        resolve(new Response(Buffer.concat(chunks), { status: incoming.statusCode!, headers }));
      });
      incoming.on('error', reject);
    });
    outgoing.on('error', reject); outgoing.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const login = async () => {
    const response = await call('/api/login', 'POST', { key }); assert.equal(response.status, 200);
    cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    return response;
  };
  return { runtime, admin, leader, call, login, root };
}

test('administrator schedules API validates input and persists stop/resume', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('/api/schedules')).status, 401);
  await f.login();
  const room = f.runtime.createRoom(f.admin, '定期の依頼');
  const input = { id: randomUUID(), agent_id: f.leader.id, room_id: room.id, prompt: '調査を更新',
    interval_ms: 86400_000, next_at: Date.now() + 60_000, max_runs: 7, timeout_ms: 3600_000 };
  assert.equal((await f.call('/api/schedules', 'POST', { ...input, max_runs: 0 })).status, 400);
  assert.equal((await f.call('/api/schedules', 'POST', input)).status, 200);
  assert.equal((await f.call('/api/schedules', 'POST', input)).status, 200);
  assert.equal((await f.call(`/api/schedules/${input.id}`, 'PATCH', { enabled: false })).status, 200);
  const rows = await (await f.call('/api/schedules')).json() as { enabled: number }[];
  assert.equal(rows.length, 1); assert.equal(rows[0]!.enabled, 0);
  assert.equal((await f.call(`/api/schedules/${input.id}`, 'PATCH', { enabled: true })).status, 200);
});

test('thread organization persists, preserves messages and requires restoration for new submissions', async t => {
  const f = await fixture(t); await f.login();
  const room = f.runtime.createRoom(f.admin, '保管する会話');
  const message = f.runtime.post(f.admin, room.id, '残す内容');
  const path = `/api/rooms/${room.id}/organization`;
  assert.equal((await f.call(path, 'PATCH', { pinned: true, archived: true })).status, 200);
  assert.equal((await f.call(path, 'PATCH', { archived: 'false' })).status, 400);
  assert.throws(() => f.runtime.organizeRoom(f.runtime.agentSession(f.leader.id), room.id, { archived: false }), /Administrator/);
  assert.equal((await f.call(`/api/rooms/${room.id}/messages`, 'POST', { id: randomUUID(), body: 'まだ返信できない' })).status, 409);
  const reopened = new Runtime(f.root);
  try { assert.deepEqual(reopened.roomPreferences(reopened.administrator(), room.id), { pinned: true, archived: true }); }
  finally { reopened.close(); }
  assert.equal((await f.call(path, 'PATCH', { archived: false })).status, 200);
  assert.deepEqual(f.runtime.roomPreferences(f.admin, room.id), { pinned: true, archived: false });
  assert.equal((await f.call(`/api/rooms/${room.id}/messages`, 'POST', { id: randomUUID(), body: '復帰後の返信' })).status, 200);
  assert.equal(f.runtime.messages(f.admin, room.id)[0]?.id, message.id);
});

test('HTTP authentication rejects forged identity and cross-origin mutations; logout revokes session', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('/api/state', 'GET', undefined, { 'x-agent-id': f.leader.id, 'x-role': 'admin' })).status, 401);
  assert.equal((await f.call('/api/login', 'POST', { key: 'wrong' })).status, 401);
  const login = await f.login();
  assert.match(login.headers.get('set-cookie')!, /HttpOnly; SameSite=Strict.*Secure/);
  assert.equal((await f.call('/api/state')).status, 200);
  assert.equal((await f.call('/api/settings', 'PATCH', { paused: true }, { origin: 'https://other.test' })).status, 403);
  assert.equal((await f.call('/api/settings', 'PATCH', { paused: true }, { origin: '' })).status, 403);
  assert.equal((await f.call('/api/state', 'GET', undefined, { host: 'attacker.test' })).status, 403);
  assert.equal(f.runtime.settings(f.admin).paused, false);
  assert.equal((await f.call('/api/logout', 'POST', {})).status, 200);
  assert.equal((await f.call('/api/state')).status, 401);
});

test('HTTP submission posts and queues atomically, rejects extra authority, and deduplicates retries', async t => {
  const f = await fixture(t); await f.login();
  const room = await (await f.call('/api/rooms', 'POST', { title: 'HTTPの庭' })).json() as { id: string };
  const path = `/api/rooms/${room.id}/messages`;
  const body = { id: randomUUID(), body: '仕事の依頼', agent_id: f.leader.id };
  assert.equal((await f.call(path, 'POST', { ...body, author_id: f.leader.id })).status, 400);
  const first = await (await f.call(path, 'POST', body)).json();
  assert.deepEqual(await (await f.call(path, 'POST', body)).json(), first);
  assert.equal((await f.call(path, 'POST', { ...body, body: '改変' })).status, 409);
  assert.equal(f.runtime.messages(f.admin, room.id).length, 1);
  assert.equal(f.runtime.messages(f.admin, room.id)[0]?.author_id, 'administrator');
  assert.equal(f.runtime.tasks.list(f.admin).length, 1);
  assert.equal((await f.call(path, 'POST', { ...body, id: randomUUID(), agent_id: randomUUID() })).status, 404);
  assert.equal(f.runtime.messages(f.admin, room.id).length, 1);
  // Private recipient mismatch also rolls the message insertion back.
  const child = f.runtime.createAgent(f.runtime.agentSession(f.leader.id), '人工の子');
  const privateRoom = f.runtime.createRoom(f.admin, '個別', [f.leader.id]);
  assert.equal((await f.call(`/api/rooms/${privateRoom.id}/messages`, 'POST', { ...body, id: randomUUID(), agent_id: child.id })).status, 403);
  assert.equal(f.runtime.messages(f.admin, privateRoom.id).length, 0);
});

test('HTTP memory edits use revisions, accept tool-generated ids, and never return old audit text', async t => {
  const f = await fixture(t); await f.login();
  const room = f.runtime.createRoom(f.admin, '庭'); const source = f.runtime.post(f.admin, room.id, '出所');
  const memory = f.runtime.remember(f.runtime.agentSession(f.leader.id), source.id, '古い人工記憶', 'tool-operation');
  const path = `/api/agents/${f.leader.id}/memories/${memory.id}`;
  assert.equal((await f.call(path, 'PATCH', { revision: 1, body: '訂正した記憶' })).status, 200);
  assert.equal((await f.call(path, 'DELETE', { revision: 1 })).status, 409);
  assert.equal((await f.call(path, 'DELETE', { revision: 2 })).status, 200);
  assert.deepEqual(await (await f.call(`/api/agents/${f.leader.id}/memories`)).json(), []);
  assert.doesNotMatch(await (await f.call(`/api/agents/${f.leader.id}/memory-audit`)).text(), /古い人工記憶|訂正した記憶/);
});

test('conversation creation retries return the same room, message and job; a bad recipient leaves no room', async t => {
  const f = await fixture(t); await f.login();
  const body = { id: randomUUID(), title: '新しい会話', body: '最初の依頼', agent_id: f.leader.id };
  const first = await (await f.call('/api/conversations', 'POST', body)).json();
  assert.deepEqual(await (await f.call('/api/conversations', 'POST', body)).json(), first);
  assert.equal(f.runtime.rooms(f.admin).length, 1);
  assert.equal(f.runtime.tasks.list(f.admin).length, 1);
  assert.equal((await f.call('/api/conversations', 'POST', { ...body, title: '別の会話' })).status, 409);
  assert.equal((await f.call('/api/conversations', 'POST', { ...body, id: randomUUID(), agent_id: randomUUID() })).status, 404);
  assert.equal(f.runtime.rooms(f.admin).length, 1);
  assert.equal(f.runtime.tasks.list(f.admin).length, 1);
});

test('profile updates persist display choices without granting leader authority or exposing other profiles', async t => {
  const f = await fixture(t); await f.login();
  const actor = f.runtime.agentSession(f.leader.id);
  const child = f.runtime.createAgent(actor, '人工の子');
  const patch = { name: '新しい名前', role: 'リーダー', persona: '静かに話す', shape: 'cat', color: '#123abc', motion: 'sway' };
  assert.equal((await f.call(`/api/agents/${child.id}/profile`, 'PATCH', patch)).status, 200);
  assert.equal(f.runtime.agents(f.admin).find(agent => agent.id === child.id)?.role, 'member');
  assert.equal(f.runtime.agents(f.admin).find(agent => agent.id === child.id)?.name, '新しい名前');
  assert.equal(f.runtime.profile(f.admin, child.id).shape, 'cat');
  assert.throws(() => f.runtime.profile(actor, child.id), /Private/);
  assert.throws(() => f.runtime.updateProfile(f.runtime.agentSession(child.id), child.id, { name: '勝手な変更' }), /Administrator/);
  assert.equal((await f.call(`/api/agents/${child.id}/profile`, 'PATCH', { shape: '../secrets' })).status, 400);
});
