import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { request } from 'node:http';
import { Runtime } from '../src/runtime/runtime.ts';
import { WebAuth } from '../src/web/auth.ts';
import { createApiServer } from '../src/web/api.ts';
import { Backups } from '../src/backup/backups.ts';
import { initializeProduct } from '../src/config/paths.ts';
import { initializeInstallation, readInstallation } from '../src/config/installation.ts';

test('content deletion and approval endpoints refuse other sites and reject stale approval details', async t => {
  const f = await fixture(t); const actor = f.runtime.agentSession(f.leader.id); const room = f.runtime.createRoom(f.admin, '人工会話');
  const artifact = f.runtime.createArtifact(actor, room.id, '人工.txt', '資料', '説明', '本文');
  const task = f.runtime.tasks.create(f.admin, f.leader.id, room.id, '人工確認'); const lease = f.runtime.tasks.claim(f.admin)!;
  f.runtime.requestApproval(actor, lease, '承認する案', '人工の条件');
  const version = f.runtime.approvals(f.admin)[0]!.version;
  assert.equal((await f.call(`/api/artifacts/${artifact}`, 'DELETE', {}, { origin: 'https://evil.test' })).status, 403);
  assert.equal((await f.call(`/api/rooms/${room.id}`, 'DELETE', {}, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await f.call(`/api/approvals/${task.id}`, 'POST', { approved: true })).status, 400);
  assert.equal((await f.call(`/api/approvals/${task.id}`, 'POST', { approved: true, version: randomUUID() })).status, 409);
  assert.equal(f.runtime.tasks.get(f.admin, task.id).state, 'waiting_user');
  assert.equal((await f.call(`/api/approvals/${task.id}`, 'POST', { approved: true, version })).status, 200);
  assert.equal((await f.call(`/api/approvals/${task.id}`, 'POST', { approved: true, version })).status, 409);
  assert.equal((await f.call(`/api/artifacts/${artifact}`, 'DELETE', {})).status, 200);
  assert.equal((await f.call(`/api/artifacts/${artifact}`)).status, 404);
  assert.equal((await f.call(`/api/rooms/${room.id}`, 'DELETE', {})).status, 200);
  assert.equal((await f.call(`/api/rooms/${room.id}/messages`)).status, 404);
});

test('backup API reports incomplete storage on its first listing and can still save',async t=>{
 const f=await fixture(t,true);mkdirSync(join(f.root,'backups',randomUUID()));
 assert.equal((await f.call('/api/backups','GET',undefined,{'sec-fetch-site':'cross-site'})).status,403);
 const first=await f.call('/api/backups');assert.equal(first.status,200);
 const listing=await first.json();assert.match(listing.error,/確認できない/);assert.deepEqual(listing.items,[]);
 assert.equal((await f.call('/api/backups','POST',{})).status,200);
 const next=await (await f.call('/api/backups')).json();assert.equal(next.items.length,1);assert.match(next.error,/確認できない/);
});

test('backup switch API refuses other sites and saves a boolean without deleting snapshots', async t => {
  const f = await fixture(t, true);
  assert.equal((await f.call('/api/settings', 'PATCH', { backupEnabled: false }, { origin: 'https://evil.test' })).status, 403);
  assert.equal((await f.call('/api/settings', 'PATCH', { backupEnabled: 'false' })).status, 400);
  assert.equal((await f.call('/api/backups', 'POST', {})).status, 200);
  assert.equal((await f.call('/api/settings', 'PATCH', { backupEnabled: false })).status, 200);
  assert.equal((await (await f.call('/api/state')).json()).settings.backupEnabled, false);
  assert.equal((await (await f.call('/api/backups')).json()).items.length, 1);
  assert.equal((await f.call('/api/settings', 'PATCH', { backupEnabled: true })).status, 200);
  assert.equal(f.runtime.settings(f.admin).backupEnabled, true);
});

test('the display language is saved through the settings API and unknown languages are refused', async t => {
  const f = await fixture(t);
  assert.equal((await (await f.call('/api/state')).json()).settings.language, 'ja');
  assert.equal((await f.call('/api/settings', 'PATCH', { language: 'en' }, { origin: 'https://evil.test' })).status, 403);
  assert.equal((await f.call('/api/settings', 'PATCH', { language: 'fr' })).status, 400);
  assert.equal((await f.call('/api/settings', 'PATCH', { language: 'a-much-too-long-language' })).status, 400);
  assert.equal((await f.call('/api/settings', 'PATCH', { language: 'zh-CN' })).status, 200);
  assert.equal((await (await f.call('/api/state')).json()).settings.language, 'zh-CN');
});

/** `login` is what Tailscale Serve would name (null: a request that did not come through Serve); `logins` is config/niwa.json `tailscaleLogins`. */
async function fixture(t: { after: (fn: () => Promise<void>) => void }, includeBackups=false, serve: { login?: string | null; logins?: string[] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'niwa-web-'));
  const runtime = new Runtime(root); const admin = runtime.administrator(); const leader = runtime.bootstrap(admin);
  const origin = 'https://niwa.test';
  const backups=includeBackups?new Backups(runtime,initializeProduct(root),{version:1,origin,port:3210}):undefined;
  const server = createApiServer(runtime, new WebAuth(origin, serve.logins),undefined,undefined,backups);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address() as { port: number };
  t.after(async () => { await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); await backups?.stop();runtime.close(); rmSync(root, { recursive: true, force: true }); });
  const call = (path: string, method = 'GET', body?: unknown, extra: Record<string, string> = {}) => new Promise<Response>((resolve, reject) => {
    const outgoing = request(`http://127.0.0.1:${address.port}${path}`, {
      method, headers: { host: 'niwa.test', origin, 'content-type': 'application/json', ...(serve.login === null ? {} : { 'tailscale-user-login': serve.login ?? 'owner@example.com' }),
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
  return { runtime, admin, leader, call, root, port: address.port };
}

test('administrator schedules API validates input and persists stop/resume', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('/api/schedules', 'GET', undefined, { 'sec-fetch-site': 'same-site' })).status, 403);
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
  assert.equal((await f.call(`/api/schedules/${input.id}`, 'DELETE')).status, 200);
  assert.equal((await f.call(`/api/schedules/${input.id}`, 'DELETE')).status, 200);
  assert.deepEqual(await (await f.call('/api/schedules')).json(), []);
  assert.equal((await f.call(`/api/schedules/${input.id}`, 'PATCH', { enabled: true })).status, 404);
  assert.equal((await f.call('/api/schedules', 'POST', input)).status, 409);
});

test('thread organization persists, preserves messages and requires restoration for new submissions', async t => {
  const f = await fixture(t);
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

test('there is no login: identity headers grant nothing, and other origins, hosts and sites are refused', async t => {
  const f = await fixture(t);
  const state = await f.call('/api/state', 'GET', undefined, { 'x-agent-id': f.leader.id, 'x-role': 'admin' });
  assert.equal(state.status, 200); assert.equal(state.headers.get('set-cookie'), null);
  assert.equal((await f.call('/api/login', 'POST', { key: 'anything' })).status, 404);
  assert.equal((await f.call('/api/session')).status, 404);
  assert.equal((await f.call('/api/settings', 'PATCH', { paused: true }, { origin: 'https://other.test' })).status, 403);
  assert.equal((await f.call('/api/settings', 'PATCH', { paused: true }, { origin: '' })).status, 403);
  assert.equal((await f.call('/api/settings', 'PATCH', { paused: true }, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await f.call('/api/state', 'GET', undefined, { host: 'attacker.test' })).status, 403);
  assert.equal((await f.call('/api/state', 'GET', undefined, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal(f.runtime.settings(f.admin).paused, false);
  assert.equal((await f.call('/api/settings', 'PATCH', { paused: true }, { 'sec-fetch-site': 'same-origin' })).status, 200);
  assert.equal(f.runtime.settings(f.admin).paused, true);
});

test('the web origin must be exact, plain HTTP is only for this computer, and only same-origin or address-bar requests count as Niwa\'s own', () => {
  assert.throws(() => new WebAuth('http://niwa.example.net'), /HTTPS/);
  assert.throws(() => new WebAuth('https://niwa.test/path'), /exact/);
  assert.doesNotThrow(() => new WebAuth('http://127.0.0.1:3210'));
  assert.doesNotThrow(() => new WebAuth('https://niwa.tailnet.example.net'));
  const auth = new WebAuth('https://niwa.test');
  const sent = (site?: string) => auth.sentByThisSite({ headers: site === undefined ? {} : { 'sec-fetch-site': site } } as never);
  assert.deepEqual([sent(), sent('same-origin'), sent('none'), sent('same-site'), sent('cross-site')], [true, true, true, false, false]);
});

test('a remote origin needs the person Tailscale Serve names, one of the allowed accounts when set, and a local origin needs neither', () => {
  const ask = (auth: WebAuth, login?: string) => auth.fromTailnet({ headers: login === undefined ? {} : { 'tailscale-user-login': login } } as never);
  const local = new WebAuth('http://127.0.0.1:3210'), remote = new WebAuth('https://niwa.test');
  assert.equal(ask(local), true); assert.equal(ask(new WebAuth('http://localhost:3210')), true);
  assert.deepEqual([ask(remote), ask(remote, ''), ask(remote, 'owner@example.com'), ask(remote, 'owner@example.com, guest@example.com'), ask(remote, 'two words')],
    [false, false, true, false, false]);
  const narrowed = new WebAuth('https://niwa.test', ['Owner@Example.com']);
  assert.deepEqual([ask(narrowed, 'owner@example.com'), ask(narrowed, 'guest@example.com'), ask(narrowed)], [true, false, false]);
  assert.throws(() => new WebAuth('https://niwa.test', ['a, b']), /Tailscale login/);
  assert.throws(() => new WebAuth('https://niwa.test', ['']), /Tailscale login/);
});

test('without the Serve identity the page and API are refused, while schedule hooks and the MCP login return still answer', async t => {
  const f = await fixture(t, false, { login: null });
  const state = await f.call('/api/state');
  assert.equal(state.status, 403); assert.equal((await state.json()).error, 'tailnet_required');
  assert.equal((await f.call('/api/settings', 'PATCH', { paused: true })).status, 403); assert.equal(f.runtime.settings(f.admin).paused, false);
  const page = await f.call('/');
  assert.equal(page.status, 403); assert.match(await page.text(), /<html lang="ja">.*Tailscale Serve を通した接続だけ/s);
  f.runtime.updateSettings(f.admin, { language: 'en' });
  const english = await (await f.call('/')).text();
  assert.match(english, /<html lang="en">.*only accepts connections through Tailscale Serve/s); assert.doesNotMatch(english, /接続/);
  f.runtime.updateSettings(f.admin, { language: 'ja' });
  const room = f.runtime.createRoom(f.admin, '通知の庭'), id = randomUUID();
  f.runtime.schedules.create(f.admin, { id, agent_id: f.leader.id, room_id: room.id, prompt: '届いた通知を読む', interval_ms: 60_000, next_at: Date.now() + 60_000, max_runs: 5, timeout_ms: 60_000, trigger_kind: 'webhook' });
  const { token } = f.runtime.schedules.issueHookToken(f.admin, id);
  assert.equal((await f.call(`/api/hooks/${id}`, 'POST', { event: 'push' }, { authorization: `Bearer ${token}` })).status, 202);
  const callback = await f.call('/api/mcp/oauth/callback?state=x&code=y');
  assert.notEqual(callback.status === 403 ? (await callback.json()).error : '', 'tailnet_required');
});

test('allowed Tailscale accounts narrow who may use Niwa from another device', async t => {
  const guest = await fixture(t, false, { login: 'guest@example.com', logins: ['owner@example.com'] });
  assert.equal((await guest.call('/api/state')).status, 403);
  const owner = await fixture(t, false, { login: 'OWNER@example.com', logins: ['owner@example.com'] });
  assert.equal((await owner.call('/api/state')).status, 200);
  const root = mkdtempSync(join(tmpdir(), 'niwa-logins-')); t.after(async () => rmSync(root, { recursive: true, force: true }));
  initializeInstallation(join(root, 'kept'), { version: 1, origin: 'https://niwa.test', port: 3210, tailscaleLogins: ['owner@example.com'] });
  assert.deepEqual(readInstallation(join(root, 'kept')).tailscaleLogins, ['owner@example.com']);
  assert.throws(() => initializeInstallation(join(root, 'listed'), { version: 1, origin: 'https://niwa.test', port: 3210, tailscaleLogins: ['owner@example.com, guest@example.com'] }), /Tailscale login/);
});

test('HTTP submission posts and queues atomically, rejects extra authority, and deduplicates retries', async t => {
  const f = await fixture(t);
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
  const f = await fixture(t);
  const room = f.runtime.createRoom(f.admin, '庭'); const source = f.runtime.post(f.admin, room.id, '出所');
  const memory = f.runtime.remember(f.runtime.agentSession(f.leader.id), source.id, '古い人工記憶', 'tool-operation');
  const path = `/api/agents/${f.leader.id}/memories/${memory.id}`;
  assert.equal((await f.call(path, 'PATCH', { revision: 1, body: '訂正した記憶' })).status, 200);
  assert.equal((await f.call(path, 'DELETE', { revision: 1 })).status, 409);
  assert.equal((await f.call(path, 'DELETE', { revision: 2 })).status, 200);
  assert.deepEqual(await (await f.call(`/api/agents/${f.leader.id}/memories`)).json(), []);
  assert.equal((await f.call(`/api/agents/${f.leader.id}/memory-audit`)).status, 404);
});

test('conversation creation retries return the same room, message and job; a bad recipient leaves no room', async t => {
  const f = await fixture(t);
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
  const f = await fixture(t);
  const actor = f.runtime.agentSession(f.leader.id);
  const child = f.runtime.createAgent(actor, '人工の子');
  const patch = { name: '新しい名前', role: 'リーダー', persona: '静かに話す', shape: 'cat', color: '#123abc', motion: 'sway' };
  const version = f.runtime.profileVersion(f.admin, child.id);
  const response = await f.call(`/api/agents/${child.id}/profile`, 'PATCH', { patch, version });
  assert.equal(response.status, 200);
  assert.equal((await f.call(`/api/agents/${child.id}/profile`, 'PATCH', { patch: { persona: '古い画面の変更' }, version })).status, 409);
  assert.equal(f.runtime.profile(f.admin, child.id).persona, '静かに話す');
  assert.equal((await f.call(`/api/agents/${child.id}/profile`, 'PATCH', patch)).status, 400);
  assert.equal(f.runtime.agents(f.admin).find(agent => agent.id === child.id)?.role, 'member');
  assert.equal(f.runtime.agents(f.admin).find(agent => agent.id === child.id)?.name, '新しい名前');
  assert.equal(f.runtime.profile(f.admin, child.id).shape, 'cat');
  assert.throws(() => f.runtime.profile(actor, child.id), /Private/);
  assert.throws(() => f.runtime.updateProfile(f.runtime.agentSession(child.id), child.id, { name: '勝手な変更' }), /Administrator/);
  assert.equal((await f.call(`/api/agents/${child.id}/profile`, 'PATCH', { patch: { shape: '../secrets' }, version: f.runtime.profileVersion(f.admin, child.id) })).status, 400);
});

test('administrator deletion requires the displayed Bot version and retains history attribution', async t => {
  const f = await fixture(t);
  const child = f.runtime.createAgent(f.runtime.agentSession(f.leader.id), '削除する人工Bot');
  const version = f.runtime.profileVersion(f.admin, child.id);
  f.runtime.updateProfile(f.admin, child.id, { name: '変更後の人工Bot' });
  assert.equal((await f.call(`/api/agents/${child.id}`, 'DELETE', { version })).status, 409);
  assert.equal((await f.call(`/api/agents/${child.id}`, 'DELETE', {})).status, 400);
  assert.equal((await f.call(`/api/agents/${f.leader.id}`, 'DELETE', { version: f.runtime.profileVersion(f.admin, f.leader.id) })).status, 403);
  const body = { version: f.runtime.profileVersion(f.admin, child.id) };
  assert.equal((await f.call(`/api/agents/${child.id}`, 'DELETE', body)).status, 200);
  assert.equal((await f.call(`/api/agents/${child.id}`, 'DELETE', body)).status, 200);
  const state = await (await f.call('/api/state')).json();
  assert.equal(state.agents.some((agent: { id: string }) => agent.id === child.id), false);
  assert.equal(state.deletedAgents.some((agent: { id: string }) => agent.id === child.id), true);
  assert.equal((await f.call(`/api/agents/${child.id}/profile`, 'PATCH', { patch: { name: '復活' }, version: body.version })).status, 404);
});

test('member creation, structured reply and schedule edit routes validate authorization and persistence', async t => {
  const f = await fixture(t); const draft = { id: randomUUID(), name: 'UI member', profile: { role: 'Testing' } };
  assert.equal((await f.call('/api/agents', 'POST', draft, { origin: 'https://evil.test' })).status, 403);
  const created = await (await f.call('/api/agents', 'POST', draft)).json() as { id: string };
  assert.equal((await (await f.call('/api/agents', 'POST', draft)).json()).id, created.id);
  assert.equal(f.runtime.rooms(f.admin).length, 0);
  const room = f.runtime.createRoom(f.admin, 'Synthetic thread');
  const message = f.runtime.post(f.runtime.agentSession(created.id), room.id, 'Synthetic original');
  const reply = await f.call(`/api/rooms/${room.id}/messages`, 'POST', { id: randomUUID(), body: 'Clean reply', reply_to: message.id, agent_ids: [created.id] });
  assert.equal(reply.status, 200); const data = await reply.json(); assert.equal(data.message.body, 'Clean reply'); assert.equal(data.message.reply_to, message.id);
  const schedule = { id: randomUUID(), agent_id: created.id, room_id: room.id, prompt: 'Original schedule', interval_ms: 60_000, next_at: Date.now() + 600_000, max_runs: 10, timeout_ms: 60_000 };
  const saved = await (await f.call('/api/schedules', 'POST', schedule)).json();
  const { id, ...body } = schedule;
  const edited = await f.call(`/api/schedules/${id}`, 'PUT', { ...body, prompt: 'Edited schedule', version: saved.version });
  assert.equal(edited.status, 200); assert.equal((await edited.json()).prompt, 'Edited schedule');
  assert.equal((await f.call(`/api/schedules/${id}`, 'PUT', { ...body, version: saved.version })).status, 409);
  assert.equal((await f.call(`/api/schedules/${id}`, 'PUT', { ...body, version: saved.version, run_count: 0 })).status, 400);
});

test('artifact review and freezing require exact hashes from Niwa\'s own page without approving external work',async t=>{
 const f=await fixture(t),actor=f.runtime.agentSession(f.leader.id),room=f.runtime.createRoom(f.admin,'版の確認');
 const id=f.runtime.createArtifact(actor,room.id,'version.txt','資料','人工','body');
 const hash=f.runtime.artifactVersions.inspect(actor,id).sha256;
 const review={expected_sha256:hash,verdict:'approved',note:'人工の確認'};
 assert.equal((await f.call(`/api/artifacts/${id}/review`,'POST',review,{origin:'https://evil.test'})).status,403);
 assert.equal((await f.call(`/api/artifacts/${id}/freeze`,'POST',{expected_sha256:hash},{'sec-fetch-site':'cross-site'})).status,403);
 assert.equal((await f.call(`/api/artifacts/${id}/freeze`,'POST',{expected_sha256:hash})).status,409);
 assert.equal((await f.call(`/api/artifacts/${id}/review`,'POST',{...review,expected_sha256:'0'.repeat(64)})).status,409);
 assert.equal((await f.call(`/api/artifacts/${id}/review`,'POST',review)).status,200);
 assert.equal((await f.call(`/api/artifacts/${id}/freeze`,'POST',{expected_sha256:hash})).status,200);
 const item=await (await f.call(`/api/artifacts/${id}`)).json() as {frozen:number;sha256:string};
 assert.equal(item.frozen,1);assert.equal(item.sha256,hash);assert.equal(f.runtime.approvals(f.admin).length,0);
 const board=await (await f.call(`/api/rooms/${room.id}/coordination`)).json() as {digest:{artifact_count:number}};
 assert.equal(board.digest.artifact_count,1);
});

test('webhook endpoint takes its own token, bounds the body and is reachable through a proxy host', async t => {
  const f = await fixture(t); const room = f.runtime.createRoom(f.admin, '外部の通知');
  const schedule = { id: randomUUID(), agent_id: f.leader.id, room_id: room.id, prompt: '届いた通知を確認する', interval_ms: 60_000,
    next_at: Date.now() + 60_000, max_runs: 5, timeout_ms: 60_000, trigger_kind: 'webhook' };
  assert.equal((await f.call(`/api/schedules/${schedule.id}/token`, 'POST', {}, { origin: 'https://evil.test' })).status, 403);
  assert.equal((await f.call('/api/schedules', 'POST', { ...schedule, source_url: 'https://news.example.com/' })).status, 400);
  assert.equal((await f.call('/api/schedules', 'POST', schedule)).status, 200);
  const issued = await (await f.call(`/api/schedules/${schedule.id}/token`, 'POST', {})).json() as { token: string; path: string };
  assert.equal(issued.path, `/api/hooks/${schedule.id}`); assert.match(issued.token, /^[A-Za-z0-9_-]{43}$/);
  const listed = await (await f.call('/api/schedules')).json() as { hook_ready: number }[];
  assert.equal(listed[0]!.hook_ready, 1); assert.ok(!JSON.stringify(listed).includes(issued.token));
  // No Origin, and the Host an HTTPS proxy forwards.
  const hook = (headers: Record<string, string>, body: string | Buffer = '{"event":"issue"}', method = 'POST', path = issued.path) => new Promise<{ status: number; headers: Record<string, unknown> }>((resolve, reject) => {
    const outgoing = request(`http://127.0.0.1:${f.port}${path}`, { method, agent: false, headers: { host: 'niwa.tailnet.example.net', 'content-type': 'application/json', ...headers } }, incoming => {
      incoming.resume(); incoming.on('end', () => resolve({ status: incoming.statusCode!, headers: incoming.headers }));
    });
    outgoing.on('error', reject); outgoing.end(body);
  });
  const bearer = { authorization: `Bearer ${issued.token}` };
  assert.equal((await hook({})).status, 401);
  const wrong = await hook({ authorization: `Bearer ${issued.token.slice(0, -2)}xx` }); assert.equal(wrong.status, 401); assert.equal(wrong.headers['www-authenticate'], 'Bearer');
  assert.equal((await hook({ authorization: `Bearer ${randomBytes(32).toString('base64url')}` }, '{}', 'POST', `/api/hooks/${randomUUID()}`)).status, 401);
  assert.equal((await hook(bearer, '{}', 'GET')).status, 405);
  assert.equal((await hook({ ...bearer, origin: 'https://attacker.example' })).status, 403);
  assert.equal((await hook({ ...bearer, 'content-type': 'image/png' })).status, 415);
  assert.equal((await hook(bearer, '{"broken"')).status, 400);
  assert.equal((await hook(bearer, Buffer.from([0xff, 0xfe]))).status, 400);
  assert.equal((await hook(bearer, 'x'.repeat(65_537))).status, 413);
  assert.equal(f.runtime.schedules.list(f.admin)[0]!.has_pending, 0);
  assert.equal((await hook(bearer)).status, 202);
  assert.equal((await hook({ 'x-niwa-token': issued.token, 'content-type': 'text/plain; charset=utf-8' }, 'メールが届きました')).status, 202);
  assert.equal(f.runtime.schedules.list(f.admin)[0]!.has_pending, 1);
  // The admin routes still reject the proxy host, and a reissued token replaces the old one.
  assert.equal((await hook(bearer, '{}', 'GET', '/api/schedules')).status, 403);
  await f.call(`/api/schedules/${schedule.id}/token`, 'POST', {});
  assert.equal((await hook(bearer)).status, 401);
  assert.equal((await f.call(`/api/schedules/${schedule.id}`, 'PATCH', { enabled: false })).status, 200);
});
