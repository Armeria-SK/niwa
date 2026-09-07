import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { CodexConnection } from '../src/providers/codex/connection.ts';
import { MemoryCredentialStore } from '../src/auth/credential-store.ts';
import { collectModelEvents } from '../src/providers/shared/adapter.ts';
import { credential, profile, request, response } from './fixtures/model.ts';
import { Subscription } from '../src/auth/subscription.ts';
import { ConnectionGate } from '../src/providers/shared/serial.ts';
import { OAuthAccount } from '../src/auth/account.ts';

test('parallel subscription authentication failures share one credential refresh', async () => {
  const store = new MemoryCredentialStore(); await store.write(credential); let refreshes = 0; let firstAttempts = 0;
  let release!: () => void; const both = new Promise<void>(resolve => { release = resolve; });
  const account = new OAuthAccount(store, async current => { refreshes++; await setImmediate(); return { ...current, access_token: 'artificial-rotated-access' }; });
  const connection = new CodexConnection({ credential_store: account, refresh: account.refresh, experimental_opt_in: true,
    fetch: async (_url, options) => {
      if (new Headers(options?.headers).get('authorization') === `Bearer ${credential.access_token}`) {
        if (++firstAttempts === 2) release(); await both; return new Response('', { status: 401 });
      }
      return response();
    } });
  const events = await Promise.all([1, 2].map(() => collectModelEvents(connection.create(profile).run(request, { timeout_ms: 2000 }))));
  assert.equal(firstAttempts, 2); assert.equal(refreshes, 1); assert.ok(events.every(items => items.at(-1)?.type === 'completed'));
});

test('catalog capacity survives profile and serialized connection without treating maximum capacity as active', async () => {
  for (const contextWindow of [32768, undefined]) {
    const store = new MemoryCredentialStore(); await store.write(credential);
    let calls = 0;
    const subscription = new Subscription(store, () => {}, { fetch: async () => {
      calls++;
      return Response.json({ models: [{ slug: 'artificial-capacity', display_name: 'Artificial capacity',
        supported_reasoning_levels: [{ effort: 'low' }], visibility: 'list', max_context_window: 1_000_000,
        ...(contextWindow === undefined ? {} : { context_window: contextWindow }) }] });
    } });
    try {
      const selected = await subscription.profile('artificial-capacity', 'low');
      assert.equal(selected.context_window, contextWindow);
      const adapter = subscription.connection.create(selected);
      assert.equal(adapter.context_window, contextWindow);
      assert.equal(calls, 1);
      for (const invalid of [0, -1, 1.5, NaN, Infinity]) {
        assert.throws(() => subscription.connection.create({ ...selected, context_window: invalid }), /invalid/);
      }
    } finally { await subscription.close(); }
  }
});

test('independent subscription tasks run concurrently through the gateway gate and cancellation stays local', async () => {
  const store = new MemoryCredentialStore(); await store.write(credential);
  let calls = 0; let release!: () => void; let cancelStarted!: () => void;
  const started = new Promise<void>(resolve => { cancelStarted = resolve; });
  const connection = new CodexConnection({ credential_store: store, experimental_opt_in: true,
    fetch: async (_url, options) => {
      calls++;
      if (calls === 1) await new Promise<void>(resolve => { release = resolve; });
      else if (calls === 2) { cancelStarted(); await new Promise<void>((_resolve, reject) => options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true })); }
      return response(JSON.parse(String(options?.body)).input[0].content[0].text);
    },
  });
  const gate = new ConnectionGate();
  const firstAdapter = gate.wrap(connection.create(profile)); const secondAdapter = gate.wrap(connection.create(profile));
  assert.notEqual(firstAdapter, secondAdapter);
  const first = collectModelEvents(firstAdapter.run({ ...request, messages: [{ role: 'user', content: 'first-bot' }] }, { timeout_ms: 2000 }));
  await setImmediate();
  const abort = new AbortController();
  const cancelled = collectModelEvents(secondAdapter.run(request, { timeout_ms: 2000, signal: abort.signal }));
  await started;
  const third = collectModelEvents(gate.wrap(connection.create(profile)).run({ ...request, messages: [{ role: 'user', content: 'third-bot' }] }, { timeout_ms: 2000 }));
  abort.abort();
  assert.equal((await cancelled).at(-1)?.type, 'failed');
  const thirdEvents = await third; assert.equal(thirdEvents.at(-1)?.type, 'completed');
  assert.equal(thirdEvents.filter(event => event.type === 'text_delta').map(event => event.text).join(''), 'third-bot');
  assert.equal(calls, 3);
  release();
  const firstEvents = await first; assert.equal(firstEvents.at(-1)?.type, 'completed');
  assert.equal(firstEvents.filter(event => event.type === 'text_delta').map(event => event.text).join(''), 'first-bot');
});

test('one subscription request timing out does not block another task', async () => {
  const store = new MemoryCredentialStore(); await store.write(credential);
  let calls = 0;
  const connection = new CodexConnection({ credential_store: store, experimental_opt_in: true,
    fetch: async () => { calls++; if (calls === 1) return new Promise<Response>(() => {}); return response(); },
  });
  const first = collectModelEvents(connection.create(profile).run(request, { timeout_ms: 50 }));
  await setImmediate();
  // Keep the test process alive while AbortSignal.timeout's unreferenced timer is pending.
  const keepAlive = setTimeout(() => {}, 2000);
  try {
    const events = await collectModelEvents(connection.create(profile).run(request, { timeout_ms: 2000 }));
    assert.equal(events.at(-1)?.type, 'completed');
    assert.equal(calls, 2);
    assert.equal((await first).find(event => event.type === 'failed')?.error.code, 'TIMED_OUT');
    const next = await collectModelEvents(connection.create(profile).run(request, { timeout_ms: 2000 }));
    assert.equal(next.at(-1)?.type, 'completed');
    assert.equal(calls, 3);
  } finally { clearTimeout(keepAlive); }
});

test('an active subscription time limit is classified as timeout rather than user abort', async () => {
  const store = new MemoryCredentialStore(); await store.write(credential);
  const connection = new CodexConnection({ credential_store: store, experimental_opt_in: true,
    fetch: async (_url, options) => new Promise<Response>((_resolve, reject) => {
      const signal = options?.signal; signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  });
  const keepAlive = setTimeout(() => {}, 2000);
  try {
    const events = await collectModelEvents(connection.create(profile).run(request, { timeout_ms: 20 }));
    const failed = events.find(event => event.type === 'failed');
    assert.equal(failed?.error.code, 'TIMED_OUT');
  } finally { clearTimeout(keepAlive); }
});
