import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { braveSearch } from '../src/tools/web/search.ts';
import { readSearchKey } from '../src/auth/search-key.ts';
import { turnTools } from '../src/runtime/turn-tools.ts';

test('search uses one fixed authenticated endpoint and returns bounded source records', async () => {
  const key = 'artificial-search-key'; let calls = 0;
  const search = braveSearch(key, async (url, init) => {
    calls++; const target = new URL(String(url));
    assert.equal(target.origin, 'https://api.search.brave.com');
    assert.equal(target.pathname, '/res/v1/web/search');
    assert.equal(target.searchParams.get('q'), '調査 & 日本語');
    assert.equal(target.searchParams.get('count'), '5'); assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).get('X-Subscription-Token'), key);
    assert.ok(init?.signal);
    return Response.json({ web: { results: [
      { title: '原文', url: 'https://example.com/source', description: '人工資料'.repeat(2000) },
      { title: 'bad', url: 'javascript:alert(1)' }, { url: 'https://user:secret@example.com/' },
    ] } });
  });
  const output = await search('調査 & 日本語');
  const results = output.results as { description: string; url: string }[];
  assert.equal(results.length, 1); assert.equal(results[0]?.description.length, 1500);
  assert.equal(results[0]?.url, 'https://example.com/source');
  assert.equal(output.untrusted, true); assert.doesNotMatch(JSON.stringify(output), /artificial-search-key/);
  assert.ok((await search(' ')).error); assert.ok((await search('x'.repeat(401))).error); assert.equal(calls, 1);
  assert.equal(turnTools(true).some(tool => tool.name === 'web_search'), false);
  assert.equal(turnTools(false, { search }).some(tool => tool.name === 'web_search'), true);
});

test('search never returns credentials echoed in success, failures or malformed responses', async () => {
  const key = 'artificial-sensitive-key';
  for (const response of [
    () => Response.json({ web: { results: [{ title: key, url: 'https://example.com/' }] } }),
    () => new Response(key, { status: 401 }), () => new Response(key),
    () => Response.json({ web: { results: 'malformed' } }),
  ]) {
    const output = await braveSearch(key, async () => response())('test');
    assert.ok(output.error); assert.equal(JSON.stringify(output).includes(key), false);
  }
  const controller = new AbortController(); controller.abort();
  let requests = 0;
  assert.ok((await braveSearch(key, async () => { requests++; throw new Error(key); })('test', controller.signal)).error);
  assert.equal(requests, 0);
});

test('search credential is optional and read only from a bounded private product file', t => {
  const secrets = mkdtempSync(join(tmpdir(), 'niwa-search-'));
  t.after(() => rmSync(secrets, { recursive: true, force: true }));
  assert.equal(readSearchKey(secrets), undefined);
  const file = join(secrets, 'brave-search-key');
  writeFileSync(file, 'artificial-key\n', { mode: 0o600 }); assert.equal(readSearchKey(secrets), 'artificial-key');
  writeFileSync(file, 'x'.repeat(515)); assert.throws(() => readSearchKey(secrets));
  writeFileSync(file, 'invalid\nkey'); assert.throws(() => readSearchKey(secrets));
  writeFileSync(file, 'artificial-key'); linkSync(file, join(secrets, 'hardlink'));
  assert.throws(() => readSearchKey(secrets));
});
