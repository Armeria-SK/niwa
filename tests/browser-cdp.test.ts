import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { CdpPipe } from '../src/tools/browser/cdp.ts';

test('browser pipe correlates out-of-order replies and isolated target events across split frames', async () => {
  const incoming = new PassThrough(), outgoing = new PassThrough(), cdp = new CdpPipe(incoming, outgoing);
  const commands: Record<string, unknown>[] = [], events: unknown[] = [];
  outgoing.on('data', chunk => commands.push(JSON.parse(String(chunk).slice(0, -1))));
  const off = cdp.onEvent(event => events.push(event));
  try {
    const first = cdp.send('Page.enable', {}, { sessionId: 'private-target-A' });
    const second = cdp.send('DOM.getDocument', {}, { sessionId: 'private-target-B' });
    assert.equal(commands[0]!.sessionId, 'private-target-A'); assert.equal(commands[1]!.sessionId, 'private-target-B');
    incoming.write('{"id":2,"sessionId":"private-target-B","result":{"root":2}}\0{"method":"Page.load');
    incoming.write('EventFired","params":{},"sessionId":"private-target-B"}\0{"id":1,"sessionId":"private-target-A","result":{}}\0');
    assert.deepEqual(await second, { root: 2 }); assert.deepEqual(await first, {});
    assert.deepEqual(events, [{ method: 'Page.loadEventFired', params: {}, sessionId: 'private-target-B' }]);
    off(); incoming.write('{"method":"Page.loadEventFired","params":{}}\0'); assert.equal(events.length, 1);
  } finally { cdp.close(); incoming.destroy(); outgoing.destroy(); }
});

test('browser interruption, timeout, malformed transport and disconnect settle pending commands without retry', async () => {
  const incoming = new PassThrough(), outgoing = new PassThrough(), cdp = new CdpPipe(incoming, outgoing);
  let writes = 0; outgoing.on('data', () => writes++);
  try {
    const stopped = new AbortController(); stopped.abort();
    await assert.rejects(cdp.send('Page.navigate', {}, { signal: stopped.signal })); assert.equal(writes, 0);
    const controller = new AbortController();
    const pending = cdp.send('Page.navigate', {}, { signal: controller.signal }); controller.abort();
    await assert.rejects(pending, /outcome unknown/);
    incoming.write('{"id":1,"result":{}}\0'); // Late response cannot revive an interrupted request.
    await assert.rejects(cdp.send('DOM.getDocument', {}, { timeoutMs: 5 }), /timed out/);
    const malformed = cdp.send('Page.enable'); incoming.write('not-json\0');
    await assert.rejects(malformed, /closed/); await assert.rejects(cdp.send('Page.enable'), /unavailable/);
    assert.equal(writes, 3);
  } finally { cdp.close(); incoming.destroy(); outgoing.destroy(); }
});

test('a wrong target reply or closed transport rejects pending browser work', async () => {
  for (const wrongTarget of [true, false]) {
    const incoming = new PassThrough(), outgoing = new PassThrough(), cdp = new CdpPipe(incoming, outgoing);
    try {
      const pending = cdp.send('Page.enable', {}, { sessionId: 'target-A' });
      if (wrongTarget) incoming.write('{"id":1,"sessionId":"target-B","result":{}}\0');
      else incoming.destroy();
      await assert.rejects(pending, /closed/);
    } finally { cdp.close(); incoming.destroy(); outgoing.destroy(); }
  }
});
