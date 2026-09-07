// Behavioral cases adapted from Carried's subscription adapter/parser/catalog tests (Apache-2.0).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryCredentialStore } from '../src/auth/credential-store.ts';
import { OpenAISubscriptionAdapter } from '../src/providers/codex/adapter.ts';
import { parseCodexResponses, CodexResponsesParseError } from '../src/providers/codex/responses-parser.ts';
import { collectModelEvents } from '../src/providers/shared/adapter.ts';
import { parseOpenAISubscriptionModelCatalog, OpenAISubscriptionModelCatalogAdapter } from '../src/providers/codex/model-catalog.ts';
import { credential, profile, request, response, frame } from './fixtures/model.ts';

test('subscription distinguishes structured quota exhaustion from transient or ambiguous failures', async () => {
  const store = new MemoryCredentialStore(); await store.write(credential);
  for (const [status, error, expected] of [
    [429, { type: 'usage_limit_reached', resets_at: 1_900_000_000 }, 'QUOTA_EXCEEDED'],
    [429, { code: 'rate_limit_exceeded', message: 'usage_limit_reached' }, 'RATE_LIMITED'],
    [429, { type: 'usage_limit_reached!', resets_at: 1_900_000_000 }, 'RATE_LIMITED'],
    [403, { type: 'usage_limit_reached' }, 'PERMISSION_DENIED'],
    [503, { type: 'usage_limit_reached' }, 'PROVIDER_UNAVAILABLE'],
  ] as const) {
    const adapter = new OpenAISubscriptionAdapter({ model_profile: profile, experimental_opt_in: true,
      credential_store: store, fetch: async () => Response.json({ error }, { status }) });
    const events = await collectModelEvents(adapter.run(request, { timeout_ms: 1000 }));
    const failure = events.find(event => event.type === 'failed')!;
    assert.equal(failure.error.code, expected);
    assert.equal(failure.error.reset_at, expected === 'QUOTA_EXCEEDED' ? 1_900_000_000 : undefined);
    assert.equal(failure.error.provider_request_sent, true);
    if (expected === 'QUOTA_EXCEEDED') assert.equal(failure.error.retryable, false);
  }
});

test('stream quota failures preserve partial output but only retain valid reset estimates', async () => {
  const store = new MemoryCredentialStore(); await store.write(credential);
  for (const reset of [1_900_000_000, null, '1900000000', -1, 1.5, 1e100]) {
    const adapter = new OpenAISubscriptionAdapter({ model_profile: profile, experimental_opt_in: true,
      credential_store: store, fetch: async () => new Response(
        frame({ type: 'response.output_text.delta', delta: 'partial' })
        + frame({ type: 'response.failed', response: { error: { code: 'usage_limit_reached', resets_at: reset,
          message: 'Artificial usage limit' } } }), { headers: { 'content-type': 'text/event-stream' } }) });
    const events = await collectModelEvents(adapter.run(request, { timeout_ms: 1000 }));
    assert.equal(events[0]?.type, 'text_delta');
    const failure = events.find(event => event.type === 'failed')!;
    assert.equal(failure.error.code, 'QUOTA_EXCEEDED');
    assert.equal(failure.error.reset_at, reset === 1_900_000_000 ? reset : undefined);
    assert.equal(JSON.stringify(events).includes(credential.access_token), false);
    assert.equal(events.some(event => event.type === 'completed'), false);
  }
});

test('subscription preserves fragmented UTF-8, bounds identity, and keeps parallel sessions disabled', async () => {
  const store = new MemoryCredentialStore();
  await store.write(credential);
  const adapter = new OpenAISubscriptionAdapter({ model_profile: profile, experimental_opt_in: true, credential_store: store,
    fetch: async (url, init) => {
      assert.equal(String(url), 'https://chatgpt.com/backend-api/codex/responses');
      assert.equal(init?.redirect, 'error');
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, profile.provider_model_id);
      assert.equal(body.store, false);
      assert.equal(body.parallel_tool_calls, false);
      assert.equal(JSON.stringify(body).includes(credential.access_token), false);
      return response();
    },
  });
  const events = await collectModelEvents(adapter.run(request, { timeout_ms: 1000 }));
  assert.equal(events.filter(e => e.type === 'text_delta').map(e => e.text).join(''), 'こんにちは');
  assert.equal(events.at(-1)?.type, 'completed');
  assert.equal(adapter.capabilities.supports_parallel_sessions, false);
});

test('parser assembles split tool calls and rejects an unfinished stream', () => {
  const body = frame({ type: 'response.output_item.added', output_index: 0,
    item: { type: 'function_call', id: 'fc1', call_id: 'call1', name: 'remember', arguments: '' } })
    + frame({ type: 'response.function_call_arguments.delta', item_id: 'fc1', output_index: 0, delta: '{"body":' })
    + frame({ type: 'response.function_call_arguments.delta', item_id: 'fc1', output_index: 0, delta: '"人工データ"}' })
    + frame({ type: 'response.output_item.done', output_index: 0,
      item: { type: 'function_call', id: 'fc1', call_id: 'call1', name: 'remember', arguments: '{"body":"人工データ"}' } })
    + frame({ type: 'response.completed', response: {} });
  const parsed = parseCodexResponses(body, 'text/event-stream');
  assert.deepEqual(parsed.events.find(e => e.type === 'tool_call'), {
    type: 'tool_call', tool_call_id: 'call1', name: 'remember', arguments: { body: '人工データ' },
  });
  assert.throws(() => parseCodexResponses(frame({ type: 'response.output_text.delta', delta: 'partial' }), 'text/event-stream'), CodexResponsesParseError);
});

test('auth renewal occurs once on 401; exact secrets and unsupported tools are rejected before network', async () => {
  const store = new MemoryCredentialStore();
  await store.write(credential);
  let calls = 0;
  let refreshes = 0;
  const adapter = new OpenAISubscriptionAdapter({ model_profile: { ...profile, supports_tool_calls: false }, purpose: 'conversation',
    experimental_opt_in: true, credential_store: store,
    refresh: async () => { refreshes++; return { ...credential, access_token: 'artificial-new-access' }; },
    fetch: async () => { calls++; return calls === 1 ? new Response('', { status: 401 }) : response(); },
  });
  const bad = await collectModelEvents(adapter.run({ ...request, messages: [{ role: 'user', content: credential.access_token }] }, { timeout_ms: 1000 }));
  assert.equal(bad.at(-1)?.type, 'failed');
  const unsupported = await collectModelEvents(adapter.run({ ...request, tools: [{ name: 'test', description: 'test', input_schema: {} }] }, { timeout_ms: 1000 }));
  assert.equal(unsupported.at(-1)?.type, 'failed');
  assert.equal(calls, 0);
  const good = await collectModelEvents(adapter.run(request, { timeout_ms: 1000 }));
  assert.equal(good.at(-1)?.type, 'completed');
  assert.equal(refreshes, 1);
  assert.equal(calls, 2);
});

test('transport cancellation and timeouts finish even if an injected fetch never settles', async () => {
  const store = new MemoryCredentialStore(); await store.write(credential);
  const adapter = new OpenAISubscriptionAdapter({ model_profile: profile, experimental_opt_in: true,
    credential_store: store, fetch: async () => new Promise(() => undefined) });
  const timeout = await collectModelEvents(adapter.run(request, { timeout_ms: 20 }));
  assert.equal(timeout.at(-1)?.type, 'failed');
  assert.equal(timeout.find(e => e.type === 'failed')?.error.code, 'TIMED_OUT');
  const controller = new AbortController();
  const pending = collectModelEvents(adapter.run(request, { timeout_ms: 1000, signal: controller.signal }));
  controller.abort();
  const cancelled = await pending;
  assert.equal(cancelled.find(e => e.type === 'failed')?.error.code, 'ABORTED');
});

test('catalog retains unknown efforts without treating them as supported model settings', async () => {
  const body = { models: [{ slug: 'artificial-model', display_name: 'Artificial model',
    supported_reasoning_levels: [{ effort: 'low' }, { effort: 'ultra' }], visibility: 'list', priority: 1 }] };
  const models = parseOpenAISubscriptionModelCatalog(body);
  assert.deepEqual(models[0]?.supported_efforts, ['low']);
  assert.deepEqual(models[0]?.unsupported_or_unknown_efforts, ['ultra']);
  const store = new MemoryCredentialStore(); await store.write(credential);
  const catalog = new OpenAISubscriptionModelCatalogAdapter({ experimental_opt_in: true, credential_store: store,
    client_version: '0.149.0', fetch: async (url, init) => {
      assert.equal(new URL(String(url)).pathname, '/backend-api/codex/models');
      assert.equal(init?.redirect, 'error');
      return Response.json(body);
    } });
  const result = await catalog.discover({ account_scope: 'default', refresh_mode: 'online' });
  assert.equal(result.kind, 'snapshot');
  assert.throws(() => parseOpenAISubscriptionModelCatalog({ models: [{ slug: 'x'.repeat(257) }] }));
});
