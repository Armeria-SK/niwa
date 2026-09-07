import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { ProgramLog } from '../src/sandbox/program-log.ts';
import { createProgramServer } from '../src/sandbox/server.ts';

const input = { operation_id: 'operation', agent_id: 'bot', room_id: 'room', task_id: 'task', command: ['python3', 'work.py'], seconds: 10 };
async function fixture(t: { after: (fn: () => Promise<void>) => void }, run: ConstructorParameters<typeof ProgramLog>[2]) {
  const root = mkdtempSync(join(tmpdir(), 'niwa-program-ipc-'));
  const path = process.platform === 'win32' ? `\\\\.\\pipe\\niwa-program-${randomUUID()}` : join(root, 'socket');
  const log = new ProgramLog(join(root, 'log.db'), 'test-environment', run); const broker = createProgramServer(log);
  broker.server.listen(path); await once(broker.server, 'listening');
  t.after(async () => { await broker.stop(); log.close(); rmSync(root, { recursive: true, force: true }); });
  function send(body: unknown, route = '/programs', signal?: AbortSignal) {
    return new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request({ socketPath: path, method: 'POST', path: route, signal, headers: { 'content-type': 'application/json' } }, response => {
        let content = ''; response.setEncoding('utf8'); response.on('data', chunk => { content += chunk; });
        response.on('end', () => resolve({ status: response.statusCode!, body: content })); response.on('error', reject);
      }); req.on('error', reject); req.end(JSON.stringify(body));
    });
  }
  return { send, broker, log };
}

test('program socket delivers bounded requests and returns stored results without a second execution', async t => {
  let runs = 0; const output = { code: 2, stdout: 'partial', stderr: 'failure' };
  const f = await fixture(t, async () => { runs++; return output; });
  assert.deepEqual(await f.send(input), { status: 200, body: JSON.stringify(output) });
  assert.deepEqual(await f.send(input), { status: 200, body: JSON.stringify(output) }); assert.equal(runs, 1);
  for (const body of [null, [], {}, { ...input, mount: '/secrets' }, { ...input, task_id: 'different' }, { ...input, seconds: 999 }])
    assert.equal((await f.send(body)).status, 400);
  assert.equal((await f.send(input, '/files')).status, 400); assert.equal(runs, 1);
  assert.equal((await f.send({ extra: 'x'.repeat(140000) })).status, 413);
});

test('disconnect aborts execution and keeps an unknown receipt instead of replaying', async t => {
  let started!: () => void; const start = new Promise<void>(resolve => { started = resolve; });
  let aborted!: () => void; const abort = new Promise<void>(resolve => { aborted = resolve; }); let runs = 0;
  const f = await fixture(t, async (_request, signal) => { runs++; started(); await once(signal!, 'abort'); aborted(); throw Error('secret internal error'); });
  const controller = new AbortController(); const response = f.send(input, '/programs', controller.signal); const rejected = assert.rejects(response);
  await start; controller.abort(); await rejected; await abort;
  const retry = await f.send(input); assert.equal(retry.status, 200); assert.deepEqual(JSON.parse(retry.body), { error: 'outcome_unknown' }); assert.equal(runs, 1);
});

test('service stop cancels active executions and waits before its receipt store can close', async t => {
  let started!: () => void; const start = new Promise<void>(resolve => { started = resolve; }); let finished = false;
  const f = await fixture(t, async (_request, signal) => { started(); await once(signal!, 'abort'); finished = true; throw Error('stopped'); });
  const response = f.send(input); const rejected = assert.rejects(response); await start;
  await f.broker.stop(); await rejected; assert.equal(finished, true); assert.equal(f.log.pending().length, 1);
});
