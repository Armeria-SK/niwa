import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryCredentialStore } from '../src/auth/credential-store.ts';
import { XOAuth } from '../src/auth/x-oauth.ts';
import { xJson } from '../src/tools/x/http.ts';
import { readXClient } from '../src/auth/x-client.ts';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const tokens = { access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', expires_in: 7200,
  token_type: 'bearer', scope: 'tweet.read tweet.write users.read offline.access' };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

test('X PKCE consumes state once, checks scopes and exact dedicated account before saving', async () => {
  const store = new MemoryCredentialStore(); const calls: string[] = [];
  const auth = new XOAuth(store, { client_id: 'synthetic-client', client_secret: 'synthetic-secret' }, '123', async (url, init) => {
    calls.push(String(url)); assert.equal(init?.redirect, 'error');
    if (String(url).endsWith('/token')) {
      assert.equal(new URLSearchParams(init!.body as URLSearchParams).get('grant_type'), 'authorization_code');
      assert.equal((init!.headers as Record<string, string>).Authorization, 'Basic ' + Buffer.from('synthetic-client:synthetic-secret').toString('base64'));
      return json(tokens);
    }
    assert.equal(String(url), 'https://api.x.com/2/users/me'); return json({ data: { id: '123' } });
  });
  const begin = new URL(auth.begin('https://niwa.example/x/callback').url);
  assert.equal(begin.origin, 'https://x.com'); assert.equal(begin.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(!begin.href.includes('synthetic-secret')); assert.ok(!begin.searchParams.has('code_verifier'));
  await assert.rejects(auth.finish('wrong', 'code')); assert.equal(calls.length, 0);
  assert.deepEqual(await auth.finish(begin.searchParams.get('state')!, 'code'), { account_id: '123', connected: true });
  await assert.rejects(auth.finish(begin.searchParams.get('state')!, 'code')); assert.equal(calls.length, 2);
  assert.equal(await auth.access(), tokens.access_token); assert.equal(calls.length, 2);
  assert.equal((await store.read())?.account_id, '123');
  await auth.disconnect(); assert.equal(await store.read(), undefined); await assert.rejects(auth.access());
});

test('X rejects another account or missing permission and does not save their tokens', async () => {
  for (const response of [{ ...tokens, scope: 'tweet.read' }, tokens]) {
    const store = new MemoryCredentialStore(); let requests = 0;
    const auth = new XOAuth(store, { client_id: 'client' }, '123', async url => {
      requests++; return String(url).endsWith('/token') ? json(response) : json({ data: { id: '456' } });
    });
    const state = new URL(auth.begin('https://niwa.example/x/callback').url).searchParams.get('state')!;
    await assert.rejects(auth.finish(state, 'code')); assert.equal(await store.read(), undefined);
    assert.equal(requests, response.scope === 'tweet.read' ? 1 : 2);
  }
});

test('X refresh is shared, failed refresh is not replayed, and disconnect prevents an in-flight token from being saved', async () => {
  const expired = { access_token: 'old', refresh_token: 'refresh', expires_at: 0, account_id: '123' };
  const store = new MemoryCredentialStore(); await store.write(expired); let refreshes = 0;
  const auth = new XOAuth(store, { client_id: 'client' }, '123', async url => {
    if (String(url).endsWith('/token')) { refreshes++; return json(tokens); } return json({ data: { id: '123' } });
  });
  assert.deepEqual(await Promise.all([auth.access(), auth.access()]), [tokens.access_token, tokens.access_token]); assert.equal(refreshes, 1);
  const failedStore = new MemoryCredentialStore(); await failedStore.write(expired);
  const failed = new XOAuth(failedStore, { client_id: 'client' }, '123', async () => { throw Error('synthetic failure'); });
  await assert.rejects(failed.access()); await assert.rejects(failed.access(), /renewed/);
  const stoppedStore = new MemoryCredentialStore(); await stoppedStore.write(expired);
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void; const start = new Promise<void>(resolve => { started = resolve; });
  const stopped = new XOAuth(stoppedStore, { client_id: 'client' }, '123', async url => {
    if (String(url).endsWith('/token')) { started(); await held; return json(tokens); } return json({ data: { id: '123' } });
  });
  const pending = stopped.access(); await start; await stopped.disconnect(); release();
  await assert.rejects(pending, /changed/); assert.equal(await stoppedStore.read(), undefined);
});

test('X JSON transport rejects arbitrary hosts, redirects and oversized responses', async () => {
  let calls = 0;
  const fake: typeof fetch = async (_url, init) => { calls++; assert.equal(init?.redirect, 'error'); return json('x'.repeat(256 * 1024)); };
  await assert.rejects(xJson('https://private.example/', {}, fake)); assert.equal(calls, 0);
  await assert.rejects(xJson('https://api.x.com/2/users/me', {}, fake), /too large/); assert.equal(calls, 1);
  await assert.rejects(xJson('https://api.x.com/2/users/me', {}, async () => new Response('invalid synthetic-sensitive-value')), error =>
    error instanceof Error && error.message === 'Invalid X JSON response');
});

test('X client configuration is explicit and malformed secret data is never included in errors', () => {
  const root = mkdtempSync(join(tmpdir(), 'niwa-x-client-'));
  try {
    assert.equal(readXClient(root), undefined);
    writeFileSync(join(root, 'x-client.json'), JSON.stringify({ client_id: 'synthetic', client_secret: 'synthetic-secret' }), { mode: 0o600 });
    assert.deepEqual(readXClient(root), { client_id: 'synthetic', client_secret: 'synthetic-secret' });
    writeFileSync(join(root, 'x-client.json'), 'invalid synthetic-sensitive-value');
    assert.throws(() => readXClient(root), error => error instanceof Error && error.message === 'X client configuration is invalid');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
