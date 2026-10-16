import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { XApi, validateXPost, xWeightedLength } from '../src/tools/x/api.ts';
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

test('X length follows X weighting: CJK and emoji count twice, links count 23, Latin text once', () => {
  assert.equal(xWeightedLength('a'.repeat(280)), 280); assert.equal(xWeightedLength('a'.repeat(281)), 281);
  assert.equal(xWeightedLength('あ'.repeat(140)), 280); assert.equal(xWeightedLength('あ'.repeat(141)), 282);
  assert.equal(xWeightedLength('héllo ünïcode — “quoted” ’'), [...'héllo ünïcode — “quoted” ’'].length);
  assert.equal(xWeightedLength('https://example.com/' + 'x'.repeat(300)), 23);
  assert.equal(xWeightedLength('見て https://example.com/a?b=c.'), 2 * 2 + 1 + 23 + 1);
  assert.equal(xWeightedLength('ok 😀'), 3 + 2); assert.equal(xWeightedLength('👨‍👩‍👧‍👦'), 2);
  assert.equal(xWeightedLength('ｱ'), 2); assert.equal(xWeightedLength('‐′'), 2);
  const api = new XApi({ accountId: '1', access: async () => 'artificial' }, async () => json({ data: { id: '123' } }, 201));
  validateXPost({ text: 'あ'.repeat(140) }); validateXPost({ text: 'link https://example.com/' + 'p'.repeat(500) + ' ' + 'a'.repeat(250) });
  assert.throws(() => validateXPost({ text: 'あ'.repeat(141) }), /Invalid X post/);
  assert.throws(() => validateXPost({ text: 'a'.repeat(4001) }), /Invalid X post/);
  return assert.rejects(api.post({ text: '日本語'.repeat(50) }));
});

test('X rejections keep a bounded title and detail so the cause can be fixed', async () => {
  const reply = (body: unknown, status = 403) => new XApi({ accountId: '1', access: async () => 'artificial' }, async () => json(body, status));
  assert.deepEqual(await reply({ title: 'Forbidden', detail: 'You are not allowed to create a Tweet with duplicate content.', type: 'about:blank' }).post({ text: 'x' }),
    { error: 'x_rejected', status: 403, title: 'Forbidden', detail: 'You are not allowed to create a Tweet with duplicate content.' });
  const long = await reply({ title: 'T\u0000itle', detail: 'd'.repeat(1000) }, 400).post({ text: 'x' }) as { title: string; detail: string };
  assert.equal(long.title, 'T itle'); assert.equal(long.detail.length, 200);
  assert.deepEqual(await reply({ errors: [{ message: 'Over the limit' }] }, 429).post({ text: 'x' }), { error: 'x_rejected', status: 429, detail: 'Over the limit' });
  assert.deepEqual(await reply({ title: 5, detail: { nested: true } }, 422).post({ text: 'x' }), { error: 'x_rejected', status: 422 });
});

test('equal text is a duplicate only within a day; operation receipts and unknown outcomes still never replay', async () => {
  const root = mkdtempSync(join(tmpdir(), 'niwa-x-window-')); let sends = 0, now = Date.UTC(2026, 0, 1); const hour = 3_600_000;
  const results = [{ id: '1', url: 'https://x.com/i/web/status/1' }, { id: '2', url: 'https://x.com/i/web/status/2' }, { id: '3', url: 'https://x.com/i/web/status/3' }];
  let log = new XPostLog(join(root, 'posts.db'), '1', async () => results[sends++]!, () => now);
  try {
    assert.deepEqual(await log.execute({ ...operation, operation_id: 'first' }), results[0]);
    now += 23 * hour; assert.deepEqual(await log.execute({ ...operation, operation_id: 'copy' }), results[0]); assert.equal(sends, 1);
    // The copied receipt does not renew the window of the post it copied.
    now += 2 * hour; assert.deepEqual(await log.execute({ ...operation, operation_id: 'later' }), results[1]); assert.equal(sends, 2);
    assert.deepEqual(await log.execute({ ...operation, operation_id: 'first', allow_start: false }), results[0]);
    assert.deepEqual(await log.execute({ ...operation, operation_id: 'later', allow_start: false }), results[1]);
    now += hour; assert.deepEqual(await log.execute({ ...operation, operation_id: 'immediate' }), results[1]); assert.equal(sends, 2);
    await log.close();
    // An unknown outcome is protected for the same window and its operation id is never sent again.
    log = new XPostLog(join(root, 'posts.db'), '1', async () => { sends++; throw Error('connection lost'); }, () => now);
    const other = { ...operation, post: { text: 'different text' } };
    assert.deepEqual(await log.execute({ ...other, operation_id: 'lost' }), { error: 'outcome_unknown' }); assert.equal(sends, 3);
    now += hour; assert.deepEqual(await log.execute({ ...other, operation_id: 'blocked' }), { error: 'outcome_unknown' }); assert.equal(sends, 3);
    now += 24 * hour; assert.deepEqual(await log.execute({ ...other, operation_id: 'lost', allow_start: true }), { error: 'outcome_unknown' }); assert.equal(sends, 3);
    assert.deepEqual(await log.execute({ ...other, operation_id: 'fresh' }), { error: 'outcome_unknown' }); assert.equal(sends, 4);
  } finally { await log.close(); rmSync(root, { recursive: true, force: true }); }
});
