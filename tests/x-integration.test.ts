import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { request } from 'node:http';
import { Runtime } from '../src/runtime/runtime.ts';
import { executeAsyncTurnTool, turnTools } from '../src/runtime/turn-tools.ts';
import { XPostLog } from '../src/tools/x/post-log.ts';
import { XOAuth } from '../src/auth/x-oauth.ts';
import { MemoryCredentialStore } from '../src/auth/credential-store.ts';
import { createApiServer } from '../src/web/api.ts';
import { WebAuth } from '../src/web/auth.ts';

test('X tools enforce shared-room publication and reconcile unknown outcomes without another send', async () => {
  const root = mkdtempSync(join(tmpdir(), 'niwa-x-turn-')), runtime = new Runtime(join(root, 'state'));
  let sends = 0; const posts = new XPostLog(join(root, 'posts.db'), '123', async () => { sends++; return { error: 'outcome_unknown' }; });
  try {
    const admin = runtime.administrator(), leader = runtime.bootstrap(admin), actor = runtime.agentSession(leader.id);
    const api = { read: async () => ({ posts: [], untrusted: true }), mentions: async () => ({ posts: [], untrusted: true }) }, external = { x: { api, posts } };
    assert.equal(turnTools(true).some(tool => tool.name.startsWith('x_')), false);
    assert.equal(turnTools(false, external, false).some(tool => tool.name === 'x_post'), false);
    assert.equal(turnTools(false, external, true).filter(tool => tool.name.startsWith('x_')).length, 3);
    const privateRoom = runtime.createRoom(admin, 'private', [leader.id]); const privateTask = runtime.tasks.create(admin, leader.id, privateRoom.id, 'private');
    const privateLease = runtime.tasks.claim(admin)!;
    const call = { name: 'x_post', tool_call_id: 'synthetic', arguments: { text: 'artificial', reply_to: null } };
    assert.ok((await executeAsyncTurnTool(runtime, actor, privateLease, call, 'post', undefined, external)).error); assert.equal(sends, 0);
    runtime.tasks.complete(admin, privateTask.id);
    const room = runtime.createRoom(admin, 'shared'), task = runtime.tasks.create(admin, leader.id, room.id, 'post'), lease = runtime.tasks.claim(admin)!;
    assert.ok((await executeAsyncTurnTool(runtime, actor, lease, { ...call, arguments: { ...call.arguments, account_id: 'other' } }, 'forged', undefined, external)).error);
    assert.deepEqual(await executeAsyncTurnTool(runtime, actor, lease, { name: 'x_mentions', tool_call_id: 'read', arguments: { since_id: null } }, 'mentions', undefined, external), { posts: [], untrusted: true });
    assert.deepEqual(await executeAsyncTurnTool(runtime, actor, lease, call, 'post', undefined, external), { error: 'outcome_unknown' });
    assert.equal(runtime.tasks.get(admin, task.id).state, 'waiting_user'); runtime.tasks.resume(admin, task.id);
    assert.deepEqual(await executeAsyncTurnTool(runtime, actor, runtime.tasks.claim(admin)!, call, 'post', undefined, external), { error: 'outcome_unknown' });
    assert.equal(sends, 1);
  } finally { await posts.close(); runtime.close(); rmSync(root, { recursive: true, force: true }); }
});

test('X login requires administrator and same-origin POST; cookie-free callback must consume the issued state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'niwa-x-admin-')), runtime = new Runtime(root); runtime.bootstrap(runtime.administrator());
  const store = new MemoryCredentialStore(); let exchanges = 0;
  const x = new XOAuth(store, { client_id: 'synthetic' }, '123', async url => {
    if (String(url).endsWith('/token')) { exchanges++; return Response.json({ access_token: 'fake-access', refresh_token: 'fake-refresh', token_type: 'bearer', expires_in: 7200, scope: 'tweet.read tweet.write users.read offline.access' }); }
    return Response.json({ data: { id: '123' } });
  });
  const key = 'synthetic-key-012345678901234567890123456789012345', origin = 'https://niwa.test';
  const server = createApiServer(runtime, new WebAuth(origin, key), undefined, undefined, undefined, undefined, x);
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = (server.address() as { port: number }).port;
  const call = (path: string, method = 'GET', body?: unknown, cookie = '', source = origin) => new Promise<{ status: number; data: any; cookie: string }>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method, headers: { Host: 'niwa.test', Origin: source, Cookie: cookie, 'Content-Type': 'application/json' } }, res => {
      let content = ''; res.setEncoding('utf8'); res.on('data', chunk => { content += chunk; }); res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode!, data: JSON.parse(content), cookie: res.headers['set-cookie']?.[0]?.split(';')[0] ?? '' }));
    }); req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  try {
    assert.equal((await call('/api/x/login', 'POST', {})).status, 401);
    const cookie = (await call('/api/login', 'POST', { key })).cookie;
    assert.equal((await call('/api/x/login', 'POST', {}, cookie, 'https://other.test')).status, 403);
    const begin = await call('/api/x/login', 'POST', {}, cookie), state = new URL(begin.data.url).searchParams.get('state')!;
    assert.equal((await call('/api/x/callback?state=forged&code=code')).status, 400); assert.equal(exchanges, 0);
    assert.equal((await call(`/api/x/callback?state=${state}&code=code`)).status, 200);
    assert.equal((await call(`/api/x/callback?state=${state}&code=code`)).status, 400); assert.equal(exchanges, 1);
    const status = await call('/api/x', 'GET', undefined, cookie); assert.equal(status.data.connected, true);
    assert.ok(!JSON.stringify(status).includes('fake-access')); assert.ok(!JSON.stringify(status).includes('fake-refresh'));
    await call('/api/x/logout', 'POST', {}, cookie); assert.equal(await store.read(), undefined);
  } finally { x.close(); await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); runtime.close(); rmSync(root, { recursive: true, force: true }); }
});
