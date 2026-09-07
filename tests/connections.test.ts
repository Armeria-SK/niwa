import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { CodexConnection } from '../src/providers/codex/connection.ts';
import { MemoryCredentialStore } from '../src/auth/credential-store.ts';
import { collectModelEvents } from '../src/providers/shared/adapter.ts';
import { credential, profile, request, response } from './fixtures/model.ts';
import { Subscription } from '../src/auth/subscription.ts';

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

test('separate task adapters share one subscription gate and cancelled waiters cannot bypass it', async () => {
  const store = new MemoryCredentialStore(); await store.write(credential);
  let calls = 0; let release!: () => void;
  const connection = new CodexConnection({ credential_store: store, experimental_opt_in: true,
    fetch: async () => {
      calls++;
      if (calls === 1) await new Promise<void>(resolve => { release = resolve; });
      return response();
    },
  });
  const firstAdapter = connection.create(profile); const secondAdapter = connection.create(profile);
  assert.notEqual(firstAdapter, secondAdapter);
  const first = collectModelEvents(firstAdapter.run(request, { timeout_ms: 2000 }));
  await setImmediate();
  const abort = new AbortController();
  const cancelled = collectModelEvents(secondAdapter.run(request, { timeout_ms: 2000, signal: abort.signal }));
  const third = collectModelEvents(connection.create(profile).run(request, { timeout_ms: 2000 }));
  abort.abort();
  assert.equal((await cancelled).at(-1)?.type, 'failed');
  await setImmediate(); assert.equal(calls, 1);
  release();
  assert.equal((await first).at(-1)?.type, 'completed');
  assert.equal((await third).at(-1)?.type, 'completed');
  assert.equal(calls, 2);
});

test('subscription queue timeout does not submit a request or wedge later work', async () => {
  const store = new MemoryCredentialStore(); await store.write(credential);
  let calls = 0; let release!: () => void;
  const connection = new CodexConnection({ credential_store: store, experimental_opt_in: true,
    fetch: async () => { calls++; if (calls === 1) await new Promise<void>(resolve => { release = resolve; }); return response(); },
  });
  const first = collectModelEvents(connection.create(profile).run(request, { timeout_ms: 2000 }));
  await setImmediate();
  // Keep the test process alive while AbortSignal.timeout's unreferenced timer is pending.
  const keepAlive = setTimeout(() => {}, 2000);
  try {
    const events = await collectModelEvents(connection.create(profile).run(request, { timeout_ms: 20 }));
    assert.equal(events.at(-1)?.type, 'failed');
    assert.equal(calls, 1);
    release(); await first;
    const next = await collectModelEvents(connection.create(profile).run(request, { timeout_ms: 2000 }));
    assert.equal(next.at(-1)?.type, 'completed');
    assert.equal(calls, 2);
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
