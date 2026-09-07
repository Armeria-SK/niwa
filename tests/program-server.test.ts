import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { ProgramLog } from '../src/sandbox/program-log.ts';
import { createProgramServer } from '../src/sandbox/server.ts';
import { configuredProgramExecutor, programExecutor } from '../src/sandbox/client.ts';

const input = { operation_id: 'operation', agent_id: 'bot', room_id: 'room', task_id: 'task', command: ['python3', 'work.py'], seconds: 10, allow_start: true };
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
  return { send, broker, log, execute: programExecutor(path, () => {}) };
}

test('program socket delivers bounded requests and returns stored results without a second execution', async t => {
  let runs = 0; const output = { code: 2, stdout: 'partial', stderr: 'failure' };
  const f = await fixture(t, async () => { runs++; return output; });
  assert.deepEqual(await f.send(input), { status: 200, body: JSON.stringify({ operation_id: input.operation_id, result: output }) });
  assert.deepEqual(await f.send(input), { status: 200, body: JSON.stringify({ operation_id: input.operation_id, result: output }) }); assert.equal(runs, 1);
  for (const body of [null, [], {}, { ...input, mount: '/secrets' }, { ...input, task_id: 'different' }, { ...input, seconds: 999 }])
    assert.equal((await f.send(body)).status, 400);
  assert.equal((await f.send(input, '/files')).status, 400); assert.equal(runs, 1);
  assert.equal((await f.send({ extra: 'x'.repeat(140000) })).status, 413);
  assert.deepEqual(await f.execute(input), output); assert.equal(runs, 1);
});

test('disconnect aborts execution and keeps an unknown receipt instead of replaying', async t => {
  let started!: () => void; const start = new Promise<void>(resolve => { started = resolve; });
  let aborted!: () => void; const abort = new Promise<void>(resolve => { aborted = resolve; }); let runs = 0;
  const f = await fixture(t, async (_request, signal) => { runs++; started(); await once(signal!, 'abort'); aborted(); throw Error('secret internal error'); });
  const controller = new AbortController(); const response = f.execute(input, controller.signal); const rejected = assert.rejects(response);
  await start; controller.abort(); await rejected; await abort;
  const retry = await f.send(input); assert.equal(retry.status, 200); assert.deepEqual(JSON.parse(retry.body).result, { error: 'outcome_unknown' }); assert.equal(runs, 1);
});

test('program IPC client checks the endpoint each time and rejects substituted or oversized responses', async t => {
  const root = mkdtempSync(join(tmpdir(), 'niwa-program-client-'));
  const path = process.platform === 'win32' ? `\\\\.\\pipe\\niwa-program-${randomUUID()}` : join(root, 'socket');
  let result: unknown = { operation_id: input.operation_id, result: { code: 0, stdout: '\0'.repeat(65536), stderr: '' } }; let received = 0;
  const server = createServer((req, res) => { received++; req.resume(); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result)); });
  server.listen(path); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); });
  let verified = 0; let allowed = true;
  const execute = programExecutor(path, () => { verified++; if (!allowed) throw Error('untrusted socket'); });
  assert.deepEqual(await execute(input), (result as { result: unknown }).result);
  for (const bad of [null, { operation_id: 'different', result: { code: 0, stdout: '', stderr: '' } },
    { operation_id: input.operation_id, result: { code: 0, stdout: 'a'.repeat(65537), stderr: '' } },
    { operation_id: input.operation_id, result: { code: 0, stdout: '', stderr: '', extra: 'untrusted' } },
    { operation_id: input.operation_id, result: { error: 'different_error' } }, 'x'.repeat(1024 * 1024)]) {
    result = bad; await assert.rejects(execute(input));
  }
  result = { operation_id: input.operation_id, result: { error: 'outcome_unknown' } };
  assert.deepEqual(await execute(input), { error: 'outcome_unknown' }); assert.equal(verified, received);
  const before = received; allowed = false; await assert.rejects(execute(input), /untrusted socket/); assert.equal(received, before);
  if (process.platform !== 'linux') assert.throws(() => configuredProgramExecutor(path, 1001), /Linux/);
});

test('service stop cancels active executions and waits before its receipt store can close', async t => {
  let started!: () => void; const start = new Promise<void>(resolve => { started = resolve; }); let finished = false;
  const f = await fixture(t, async (_request, signal) => { started(); await once(signal!, 'abort'); finished = true; throw Error('stopped'); });
  const response = f.send(input); const rejected = assert.rejects(response); await start;
  await f.broker.stop(); await rejected; assert.equal(finished, true); assert.equal(f.log.pending().length, 1);
});
