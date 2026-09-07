import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { BrowserWire } from '../src/tools/browser/wire.ts';

test('browser worker pipe supports nested resource replies and closes pending requests on malformed input', async () => {
  const toWorker = new PassThrough(), toHost = new PassThrough();
  const host = new BrowserWire(toHost, toWorker, async (method, input) => { assert.equal(method, 'resource.read'); return { body: input }; });
  const worker: BrowserWire = new BrowserWire(toWorker, toHost, async (method, input) => {
    assert.equal(method, 'browser.navigate'); return worker.request('resource.read', input);
  });
  assert.deepEqual(await Promise.all([host.request('browser.navigate', 'one'), host.request('browser.navigate', 'two')]), [{ body: 'one' }, { body: 'two' }]);
  const interrupted = host.request('browser.navigate', 'three');
  toHost.write('invalid json\n'); await assert.rejects(interrupted, /disconnected/);
  await assert.rejects(host.request('browser.navigate', 'four'), /unavailable/);
  worker.close(); host.close();
});

test('browser worker pipe bounds frames and cancellation rejects without automatically replaying', async () => {
  const input = new PassThrough(), output = new PassThrough();
  output.resume();
  const channel = new BrowserWire(input, output, async () => null);
  await assert.rejects(channel.request('browser.navigate', 'a'.repeat(512 * 1024)), /send failed/);
  const controller = new AbortController();
  const pending = channel.request('browser.navigate', {}, controller.signal); controller.abort();
  await assert.rejects(pending, /interrupted/);
  const next = channel.request('browser.snapshot', {});
  input.write(Buffer.alloc(512 * 1024 + 1)); await assert.rejects(next, /disconnected/);
  channel.close();
});
