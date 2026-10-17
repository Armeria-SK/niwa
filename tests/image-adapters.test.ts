import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { LocalLlmAdapter } from '../src/providers/local-llm/adapter.ts';
import { OpenAICompatibleAdapter } from '../src/providers/openai-compatible/adapter.ts';
import { collectModelEvents } from '../src/providers/shared/adapter.ts';
import type { ModelRequest } from '../src/contracts/model.ts';
import { request } from './fixtures/model.ts';

/** A local endpoint that records each request body and answers like Ollama or a Chat Completions server. */
async function endpoint() {
  const bodies: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url?.includes('chat/completions') ? { choices: [{ message: { role: 'assistant', content: '見ました' }, finish_reason: 'stop' }] } : { done: true, message: { role: 'assistant', content: '見ました' } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, bodies, close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }) };
}
const { reasoning_effort: _unused, ...base } = request;
const image = { media_type: 'image/jpeg' as const, data: Buffer.from('artificial-jpeg').toString('base64') };
const asked: ModelRequest = { ...base, tools: [], messages: [{ role: 'user', content: 'この写真は？', images: [image] }] };

test('a local model with vision gets images as base64 beside the text; one without vision refuses them before sending', async () => {
  const server = await endpoint();
  try {
    const seeing = new LocalLlmAdapter(server.url, { id: 'artificial', tools: false, thinking: false, vision: true }, fetch);
    assert.equal(seeing.capabilities.supports_image_input, true);
    const events = await collectModelEvents(seeing.run(asked, { timeout_ms: 5000 }));
    assert.equal(events.at(-1)?.type, 'completed');
    const sent = (server.bodies[0]!.messages as { role: string; content: string; images?: string[] }[]).find(message => message.role === 'user')!;
    assert.deepEqual([sent.content, sent.images], ['この写真は？', [image.data]]);
    const blind = new LocalLlmAdapter(server.url, { id: 'artificial', tools: false, thinking: false }, fetch);
    assert.equal(blind.capabilities.supports_image_input, false);
    const refused = await collectModelEvents(blind.run(asked, { timeout_ms: 5000 }));
    assert.equal(refused[0]?.type === 'failed' && refused[0].error.code, 'CAPABILITY_MISMATCH');
    assert.equal(server.bodies.length, 1);
  } finally { await server.close(); }
});

test('an OpenAI-compatible model is never sent images, because Niwa cannot tell whether it sees them', async () => {
  const server = await endpoint();
  try {
    const adapter = new OpenAICompatibleAdapter({ baseUrl: `${server.url}/v1`, fetch }, 'artificial');
    assert.notEqual(adapter.capabilities.supports_image_input, true);
    const refused = await collectModelEvents(adapter.run(asked, { timeout_ms: 5000 }));
    assert.equal(refused[0]?.type === 'failed' && refused[0].error.code, 'CAPABILITY_MISMATCH');
    assert.equal(server.bodies.length, 0);
    const text = await collectModelEvents(adapter.run({ ...asked, messages: [{ role: 'user', content: '文字だけ' }] }, { timeout_ms: 5000 }));
    assert.equal(text.at(-1)?.type, 'completed');
  } finally { await server.close(); }
});
