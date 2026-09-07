import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OllamaAdapter, inspectOllamaModel, listOllamaModels } from '../src/providers/ollama/adapter.ts';
import { collectModelEvents } from '../src/providers/shared/adapter.ts';
import { request } from './fixtures/model.ts';

test('local catalog reads installed models and per-model tool capability', async () => {
  const fake: typeof fetch = async url => new URL(String(url)).pathname === '/api/tags'
    ? Response.json({ models: [{ name: 'artificial:small' }] })
    : Response.json({ capabilities: ['completion', 'tools', 'thinking'] });
  assert.deepEqual(await listOllamaModels('http://192.0.2.1:11434', fake), ['artificial:small']);
  assert.deepEqual(await inspectOllamaModel('http://192.0.2.1:11434', 'artificial:small', fake), { id: 'artificial:small', tools: true, thinking: true });
  await assert.rejects(inspectOllamaModel('http://localhost:11434', 'remote', async () => Response.json({ capabilities: ['completion'], remote_host: 'cloud.example' })), /local/);
});

test('Ollama translates history and tool results without forwarding Codex reasoning settings', async () => {
  const { reasoning_effort: _effort, ...local } = request;
  const adapter = new OllamaAdapter('http://192.0.2.1:11434', { id: 'artificial', tools: true, thinking: false }, async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(init?.redirect, 'error');
    assert.equal(body.reasoning, undefined);
    assert.equal(body.think, undefined);
    assert.equal(body.messages[0].role, 'system');
    assert.equal(body.messages.at(-1).tool_name, 'remember');
    return Response.json({ done: true, message: { role: 'assistant', content: '覚えました' }, prompt_eval_count: 4, eval_count: 2 });
  });
  const events = await collectModelEvents(adapter.run({ ...local, messages: [...local.messages,
    { role: 'tool', name: 'remember', tool_call_id: 'call1', content: '{"id":"memory1"}' }] }, { timeout_ms: 1000 }));
  assert.equal(events.at(-1)?.type, 'completed');
  const unsupported = await collectModelEvents(adapter.run(request, { timeout_ms: 1000 }));
  assert.equal(unsupported.find(e => e.type === 'failed')?.error.code, 'CAPABILITY_MISMATCH');
});

test('Ollama malformed responses and hanging transport yield bounded failures', async () => {
  const { reasoning_effort: _effort, ...local } = request;
  const invalid = new OllamaAdapter('http://localhost:11434', { id: 'artificial', tools: false, thinking: false }, async () => Response.json({ done: false, message: {} }));
  const bad = await collectModelEvents(invalid.run(local, { timeout_ms: 1000 }));
  assert.equal(bad.find(e => e.type === 'failed')?.error.code, 'INVALID_RESPONSE');
  const hanging = new OllamaAdapter('http://localhost:11434', { id: 'artificial', tools: false, thinking: false }, async () => new Promise(() => undefined));
  const timeout = await collectModelEvents(hanging.run(local, { timeout_ms: 20 }));
  assert.equal(timeout.find(e => e.type === 'failed')?.error.code, 'TIMED_OUT');
});
