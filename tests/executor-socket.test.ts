import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recoverExecutorSocket } from '../src/runtime/executor-socket.ts';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { existsSync, chmodSync } from 'node:fs';
import { acquireProcessLock } from '../src/runtime/process-lock.ts';

test('socket recovery removes only an unchanged owned socket after a refused connection', async () => {
  const root = mkdtempSync(join(tmpdir(), 'niwa-socket-')); const path = join(root, 'executor.sock'); let removed = 0;
  const original = { uid: 1001, mode: 0o660, ino: 10, dev: 2, nlink: 1, isSocket: () => true, isSymbolicLink: () => false };
  const io = { stat: () => original, alive: async () => false, remove: (target: string) => { assert.equal(target, path); removed++; } };
  try {
    await recoverExecutorSocket(path, 1001, io); assert.equal(removed, 1);
    for (const change of [{ uid: 2000 }, { mode: 0o666 }, { nlink: 2 }, { isSocket: () => false }, { isSymbolicLink: () => true }])
      await assert.rejects(recoverExecutorSocket(path, 1001, { ...io, stat: () => ({ ...original, ...change }) }), /Unsafe/);
    await assert.rejects(recoverExecutorSocket(path, 1001, { ...io, alive: async () => true }), /still in use/);
    await assert.rejects(recoverExecutorSocket(path, 1001, { ...io, alive: async () => { throw Error('permission denied'); } }), /permission denied/);
    let stats = 0; await assert.rejects(recoverExecutorSocket(path, 1001, { ...io, stat: () => ({ ...original, ino: ++stats === 1 ? 10 : 11 }) }), /changed/);
    await recoverExecutorSocket(path, 1001, { ...io, stat: () => { throw Object.assign(Error('absent'), { code: 'ENOENT' }); } });
    assert.equal(removed, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Linux process crash leaves a stale socket that can be recovered without replacing a live listener',
  { skip: process.platform !== 'linux' || !process.getuid?.(), timeout: 10000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'niwa-socket-crash-')); const path = join(root, 'executor.sock');
    const unlock = acquireProcessLock(join(root, 'lock.db'));
    const child = spawn(process.execPath, ['-e', "require('node:net').createServer().listen(process.argv[1],()=>process.stdout.write('ready'));", path], { stdio: ['ignore', 'pipe', 'ignore'] });
    const exited = once(child, 'exit'); const server = createServer();
    try {
      await once(child.stdout!, 'data');
      chmodSync(path, 0o660);
      await assert.rejects(recoverExecutorSocket(path, process.getuid!()), /still in use/);
      child.kill('SIGKILL'); await exited; assert.equal(existsSync(path), true);
      await recoverExecutorSocket(path, process.getuid!()); assert.equal(existsSync(path), false);
      server.listen(path); await once(server, 'listening');
      chmodSync(path, 0o660);
      await assert.rejects(recoverExecutorSocket(path, process.getuid!()), /still in use/);
    } finally {
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
      unlock(); rmSync(root, { recursive: true, force: true });
    }
  });
