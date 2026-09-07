import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicIPv4, readPublicPage, type PageNetwork } from '../src/tools/web/public-page.ts';

test('public page destination policy rejects private, reserved and alternate IP forms', async () => {
  for (const ip of ['0.1.2.3', '10.0.0.1', '100.64.0.1', '127.1.2.3', '169.254.169.254', '172.16.0.1',
    '192.168.1.1', '192.0.0.8', '192.0.2.1', '192.88.99.1', '198.18.0.1', '198.51.100.3', '203.0.113.3',
    '224.0.0.1', '255.255.255.255', '::1', '::ffff:8.8.8.8', '0177.0.0.1']) assert.equal(publicIPv4(ip), false, ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '100.128.0.1', '172.32.0.1']) assert.equal(publicIPv4(ip), true, ip);
  let gets = 0;
  const transport: PageNetwork = { resolve: async host => [host], get: async () => { gets++; throw new Error('Must not connect'); } };
  for (const url of ['file:///etc/passwd', 'ftp://example.com/a', 'http://user:password@example.com/', 'http://example.com:11434/',
    'http://localhost/', 'http://service.local/', 'http://[::1]/', 'http://2130706433/', 'http://0x7f000001/',
    'http://127.1/', 'http://169.254.169.254/latest/']) await assert.rejects(readPublicPage(url, undefined, transport));
  assert.equal(gets, 0);
});

test('public page checks every DNS answer and every redirect and pins the selected address', async () => {
  const requests: string[] = [];
  const transport: PageNetwork = {
    resolve: async host => host === 'mixed.example.com' ? ['8.8.8.8', '10.0.0.1'] : host === 'private.example.com' ? ['127.0.0.1'] : ['8.8.8.8'],
    get: async (url, address) => {
      requests.push(url.href); assert.equal(address, '8.8.8.8');
      return { status: 302, location: 'https://private.example.com/', contentType: '', body: '' };
    },
  };
  await assert.rejects(readPublicPage('https://mixed.example.com', undefined, transport));
  assert.equal(requests.length, 0);
  await assert.rejects(readPublicPage('https://public.example.com', undefined, transport));
  assert.deepEqual(requests, ['https://public.example.com/']);
  transport.get = async () => ({ status: 302, location: 'http://public.example.com/', contentType: '', body: '' });
  await assert.rejects(readPublicPage('https://public.example.com', undefined, transport), /downgrade/);
});

test('public page returns source and bounded untrusted text, caps redirects and aborts DNS waits', async () => {
  const transport: PageNetwork = {
    resolve: async () => ['8.8.8.8'],
    get: async () => ({ status: 200, contentType: 'text/plain', body: 'あ'.repeat(25_000) }),
  };
  const page = await readPublicPage('https://public.example.com/a#ignored', undefined, transport);
  assert.equal(page.url, 'https://public.example.com/a');
  assert.equal(page.text.length, 20_000); assert.equal(page.truncated, true); assert.equal(page.untrusted, true);
  transport.get = async () => ({ status: 200, contentType: 'text/plain', body: 'あ'.repeat(100_000) });
  await assert.rejects(readPublicPage('https://public.example.com/', undefined, transport), /could not be read/);
  let requests = 0;
  transport.get = async () => { requests++; return { status: 302, contentType: '', body: '', location: '/again' }; };
  await assert.rejects(readPublicPage('https://public.example.com/', undefined, transport), /redirects/);
  assert.equal(requests, 6);
  transport.resolve = () => new Promise(() => {});
  const abort = new AbortController();
  const pending = readPublicPage('https://public.example.com/', abort.signal, transport);
  abort.abort(); await assert.rejects(pending, /cancelled/);
});
