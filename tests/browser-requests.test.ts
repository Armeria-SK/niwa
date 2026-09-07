import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserRequests, BrowserRequestBlocked } from '../src/tools/browser/requests.ts';

const result = (url: string, bytes = Buffer.from('synthetic')) => ({ url, content_type: 'text/html', body_base64: bytes.toString('base64'), fetched_at: new Date().toISOString(), untrusted: true });

test('browser broker allows only the chosen document and static GET resources, with checked redirects', async () => {
  const fetched: string[] = [];
  const requests = new BrowserRequests('https://example.com/start#part', async url => {
    fetched.push(url); return result(url.endsWith('/start') ? 'https://example.com/final' : url);
  });
  await requests.get({ url: 'https://example.com/start', method: 'GET', resourceType: 'Document' });
  await requests.get({ url: 'https://example.com/final', method: 'GET', resourceType: 'Document' });
  await requests.get({ url: 'https://cdn.example.com/app.js', method: 'GET', resourceType: 'Script' });
  for (const request of [
    { url: 'https://example.com/submit', method: 'POST', resourceType: 'Document' },
    { url: 'https://example.com/write', method: 'GET', resourceType: 'Fetch' },
    { url: 'https://example.com/iframe', method: 'GET', resourceType: 'Document' },
    { url: 'https://example.com/upload', method: 'PUT', resourceType: 'XHR' },
  ]) await assert.rejects(requests.get(request), error => error instanceof BrowserRequestBlocked && error.reason === 'approval_required');
  assert.deepEqual(fetched, ['https://example.com/start', 'https://example.com/final', 'https://cdn.example.com/app.js']);
  for (const url of ['file:///etc/passwd', 'https://name:secret@example.com/', 'http://example.com:3210/']) assert.throws(() => new BrowserRequests(url));
});

test('browser fetch budgets cap fan-out and bytes and discard responses after cancellation', async () => {
  let gets = 0;
  const requests = new BrowserRequests('https://example.com/', async url => { gets++; return result(url); });
  const input = { url: 'https://example.com/style.css', method: 'GET', resourceType: 'Stylesheet' };
  for (let index = 0; index < 64; index++) await requests.get(input);
  await assert.rejects(requests.get(input), /request_limit/); assert.equal(gets, 64);
  const large = new BrowserRequests('https://example.com/', async url => result(url, Buffer.alloc(256 * 1024)));
  for (let index = 0; index < 32; index++) await large.get(input);
  await assert.rejects(large.get(input), /response_limit/);
  const controller = new AbortController();
  const stopped = new BrowserRequests('https://example.com/', async url => { controller.abort(); return result(url); });
  await assert.rejects(stopped.get(input, controller.signal));
});
