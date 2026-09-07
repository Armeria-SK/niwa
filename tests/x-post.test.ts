import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { XApi } from '../src/tools/x/api.ts';
import { XPostLog } from '../src/tools/x/post-log.ts';

const operation = { operation_id: 'op', agent_id: 'bot', room_id: 'room', task_id: 'task', post: { text: 'synthetic' }, allow_start: true };
const success = { id: '123', url: 'https://x.com/i/web/status/123' };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

test('X API sends only the bound post/reply, distinguishes definite rejection and never retries uncertain writes', async () => {
  let calls = 0;
  const api = new XApi({ accountId: '1', access: async () => 'artificial' }, async (url, init) => {
    calls++; assert.equal(String(url), 'https://api.x.com/2/tweets'); assert.equal(init?.redirect, 'error');
    assert.deepEqual(JSON.parse(init!.body as string), { text: 'reply', reply: { in_reply_to_tweet_id: '456' } });
    return json({ data: { id: '123', text: 'reply' } }, 201);
  });
  assert.deepEqual(await api.post({ text: 'reply', reply_to: '456' }), success); assert.equal(calls, 1);
  await assert.rejects(api.post({ text: 'a'.repeat(281) })); assert.equal(calls, 1);
  for (const status of [400, 401, 403, 429, 500]) {
    let attempts = 0;
    const failing = new XApi({ accountId: '1', access: async () => 'artificial' }, async () => { attempts++; return json({}, status); });
    const result = await failing.post({ text: 'test' }); assert.deepEqual(result, status === 500 ? { error: 'outcome_unknown' } : { error: 'x_rejected', status });
    assert.equal(attempts, 1);
  }
  const absent = new XApi({ accountId: '1', access: async () => { throw Error('not connected'); } }, async () => { throw Error('must not send'); });
  assert.deepEqual(await absent.post({ text: 'test' }), { error: 'not_connected' });
});

test('shared X journal serializes sends, deduplicates equal content and keeps confirmed outcomes across restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'niwa-x-post-')); let sends = 0, active = 0;
  let log = new XPostLog(join(root, 'posts.db'), '1', async () => {
    assert.equal(active++, 0); sends++; await Promise.resolve(); active--; return success;
  });
  try {
    const outputs = await Promise.all([log.execute(operation), log.execute({ ...operation, operation_id: 'duplicate', agent_id: 'another' }),
      log.execute({ ...operation, operation_id: 'different', post: { text: 'different' } })]);
    assert.deepEqual(outputs, [success, success, success]); assert.equal(sends, 2);
    await log.close();
    log = new XPostLog(join(root, 'posts.db'), '1', async () => { throw Error('must not resend'); });
    assert.deepEqual(await log.execute({ ...operation, allow_start: false }), success);
    await assert.rejects(log.execute({ ...operation, post: { text: 'changed' } }), /changed/);
  } finally { await log.close(); rmSync(root, { recursive: true, force: true }); }
});

test('unknown X outcomes and missing journals never cause replay, including another operation with the same content', async () => {
  const root = mkdtempSync(join(tmpdir(), 'niwa-x-unknown-')); let sends = 0;
  let log = new XPostLog(join(root, 'posts.db'), '1', async () => { sends++; throw Error('connection lost'); });
  try {
    assert.deepEqual(await log.execute(operation), { error: 'outcome_unknown' }); await log.close();
    log = new XPostLog(join(root, 'posts.db'), '1', async () => { sends++; return success; });
    assert.deepEqual(await log.execute({ ...operation, allow_start: false }), { error: 'outcome_unknown' });
    assert.deepEqual(await log.execute({ ...operation, operation_id: 'new' }), { error: 'outcome_unknown' });
    assert.deepEqual(await log.execute({ ...operation, operation_id: 'missing', allow_start: false }), { error: 'outcome_unknown' });
    assert.equal(sends, 1);
  } finally { await log.close(); rmSync(root, { recursive: true, force: true }); }
});
