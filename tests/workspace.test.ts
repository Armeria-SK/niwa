import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, symlinkSync, linkSync } from 'node:fs';
import { join, parse } from 'node:path';
import { tmpdir } from 'node:os';
import { Workspace } from '../src/tools/files/workspace.ts';
import { createWorkspaceServer } from '../src/tools/files/server.ts';
import { workspaceReader, workspaceWriter, configuredWorkspaceReader } from '../src/tools/files/client.ts';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { WorkspaceWriteLog } from '../src/tools/files/write-log.ts';

function fixture(t: { after: (fn: () => void | Promise<void>) => void }) {
  const root = mkdtempSync(join(tmpdir(), 'niwa-workspace-'));
  const shared = join(root, 'workspace'); mkdirSync(shared);
  const cleanup: (() => void)[] = [];
  t.after(() => { for (const close of cleanup) close(); rmSync(root, { recursive: true, force: true }); });
  return { root, shared, files: new Workspace(shared), cleanup };
}

test('workspace writes nested text atomically, detects stale edits and safely repeats a lost response', t => {
  const f = fixture(t);
  const first = f.files.write('調査/報告.md', '初回\n出典: https://example.com/', null);
  const read = f.files.read('調査/報告.md');
  assert.equal(first.revision, read.revision); assert.equal(read.untrusted, true);
  const second = f.files.write('調査/報告.md', '翌日の更新', first.revision);
  assert.deepEqual(f.files.write('調査/報告.md', '翌日の更新', first.revision), second);
  assert.throws(() => f.files.write('調査/報告.md', '古い版から別の更新', first.revision), /conflict/);
  assert.equal(readFileSync(join(f.shared, '調査', '報告.md'), 'utf8'), '翌日の更新');
  assert.deepEqual(f.files.list().entries, [{ name: '調査', kind: 'directory' }]);
  assert.deepEqual(f.files.list('調査').entries, [{ name: '報告.md', kind: 'file' }]);
  const reopened = new Workspace(f.shared);
  assert.deepEqual(reopened.write('調査/報告.md', '翌日の更新', first.revision), second);
});

test('workspace rejects traversal, platform path tricks, directory links and hardlinks to outside files', t => {
  const f = fixture(t);
  const outside = join(f.root, 'private'); mkdirSync(outside);
  writeFileSync(join(outside, 'secret.txt'), '人工の非共有ファイル');
  for (const path of ['../private/secret.txt', '/private/secret.txt', 'D:/private/secret.txt', 'a/../secret', 'a\\secret',
    'report.txt:stream', 'NUL.txt', 'COM1', 'a./b', 'a /b', '.niwa-write-controlled', 'a//b', '.', 'a\0b']) {
    assert.throws(() => f.files.read(path), /invalid_path/, path);
    assert.throws(() => f.files.write(path, '変更', null), /invalid_path/, path);
  }
  symlinkSync(outside, join(f.shared, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => f.files.read('escape/secret.txt'), /invalid_path/);
  assert.throws(() => f.files.write('escape/new.txt', '変更', null), /invalid_path/);
  linkSync(join(outside, 'secret.txt'), join(f.shared, 'linked.txt'));
  assert.throws(() => f.files.read('linked.txt'), /invalid_path/);
  assert.throws(() => f.files.write('linked.txt', '変更', null), /invalid_path/);
  assert.equal(readFileSync(join(outside, 'secret.txt'), 'utf8'), '人工の非共有ファイル');
  assert.throws(() => new Workspace(parse(f.root).root), /invalid_path/);
});

test('workspace bounds binary/text inputs and directory output', t => {
  const f = fixture(t);
  writeFileSync(join(f.shared, 'binary'), Buffer.from([0xff, 0xfe]));
  writeFileSync(join(f.shared, 'oversize'), 'x'.repeat(65537));
  for (const path of ['binary', 'oversize']) assert.throws(() => f.files.read(path), /unsupported/);
  assert.throws(() => f.files.write('a', 'x'.repeat(65537), null), /unsupported/);
  assert.throws(() => f.files.write('a', 'nul\0byte', null), /unsupported/);
  assert.throws(() => f.files.write('a', 'text', 'invalid revision'), /unsupported/);
  for (let i = 0; i < 210; i++) writeFileSync(join(f.shared, `file-${i}`), 'x');
  const list = f.files.list(); assert.equal(list.entries.length, 200); assert.equal(list.truncated, true);
});

test('file broker handles bounded requests without accepting a client-selected root or exposing host paths', async t => {
  const f = fixture(t);
  const writes = new WorkspaceWriteLog(join(f.root, 'writes.db'), f.files);
  f.cleanup.push(() => writes.close());
  const server = createWorkspaceServer(f.files, writes);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/files`;
  const request = (body: unknown) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const created = await request({ operation: 'write', operation_id: 'create', path: 'report.md', content: '人工の共有資料', expected_revision: null });
  assert.equal(created.status, 200);
  const read = await request({ operation: 'read', path: 'report.md' });
  assert.equal((await read.json() as { content: string }).content, '人工の共有資料');
  const conflict = await request({ operation: 'write', operation_id: 'conflict', path: 'report.md', content: '別編集', expected_revision: null });
  assert.equal((await conflict.json() as { error: string }).error, 'conflict');
  const escape = await request({ operation: 'read', path: '../private.txt' });
  assert.equal(escape.status, 400); assert.equal((await escape.text()).includes(f.root), false);
  assert.equal((await request({ operation: 'read', path: 'report.md', root: f.root })).status, 400);
  assert.equal((await fetch(url)).status, 400);
});

test('workspace client reads through a local IPC endpoint, verifies revisions and preserves UTF-8 BOM bytes', async t => {
  const f = fixture(t);
  f.files.write('source.txt', '\uFEFF人工の共有資料', null);
  const server = createWorkspaceServer(f.files);
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\niwa-${randomUUID()}` : join(f.root, 'files.sock');
  await new Promise<void>(resolve => server.listen(endpoint, resolve));
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  let verifications = 0;
  const reader = workspaceReader(endpoint, () => { verifications++; });
  const read = await reader('read', 'source.txt');
  assert.equal(read.content, '\uFEFF人工の共有資料');
  assert.deepEqual((await reader('list', '')).entries, [{ name: 'source.txt', kind: 'file' }]);
  assert.equal(verifications, 2);
  await assert.rejects(reader('read', '../private.txt'));
  await assert.rejects(workspaceReader(endpoint, () => { throw new Error('Untrusted socket'); })('read', 'source.txt'), /Untrusted socket/);
  assert.throws(() => configuredWorkspaceReader(endpoint, process.getuid?.() ?? 0), /separate Linux/);
});

test('workspace client refuses foreign paths, altered revisions, extra fields and oversized IPC responses', async t => {
  const f = fixture(t);
  const good = f.files.write('source.txt', '人工資料', null);
  const base = { ...good, content: '人工資料', untrusted: true };
  let output: unknown = base;
  const server = createServer((request, response) => {
    request.resume(); response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(output));
  });
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\niwa-${randomUUID()}` : join(f.root, 'files.sock');
  await new Promise<void>(resolve => server.listen(endpoint, resolve));
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const reader = workspaceReader(endpoint, () => {});
  for (const bad of [{ ...base, path: 'elsewhere.txt' }, { ...base, content: '改変された資料' },
    { ...base, private: 'extra' }, { ...base, content: 'x'.repeat(600_000) }]) {
    output = bad; await assert.rejects(reader('read', 'source.txt'));
  }
  output = { path: '', entries: [{ name: '../outside', kind: 'file' }], truncated: false };
  await assert.rejects(reader('list', ''));
});

test('workspace IPC is cancellable while waiting for a response', async t => {
  const f = fixture(t);
  let arrived!: () => void;
  const received = new Promise<void>(resolve => { arrived = resolve; });
  const server = createServer(request => { request.resume(); arrived(); });
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\niwa-${randomUUID()}` : join(f.root, 'files.sock');
  await new Promise<void>(resolve => server.listen(endpoint, resolve));
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const abort = new AbortController();
  const pending = workspaceReader(endpoint, () => {})('read', 'source.txt', abort.signal);
  const rejected = assert.rejects(pending);
  await received; abort.abort(); await rejected;
});

test('write client uses durable operation ids over IPC and verifies the resulting revision', async t => {
  const f = fixture(t);
  const log = new WorkspaceWriteLog(join(f.root, 'write-log.db'), f.files); f.cleanup.push(() => log.close());
  const server = createWorkspaceServer(f.files, log);
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\niwa-${randomUUID()}` : join(f.root, 'files.sock');
  await new Promise<void>(resolve => server.listen(endpoint, resolve));
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const write = workspaceWriter(endpoint, () => {});
  const input = { operation_id: 'same-operation', path: 'report.md', content: '人工の共有資料', expected_revision: null };
  const first = await write(input);
  assert.equal(first.revision, f.files.read('report.md').revision);
  f.files.write('report.md', 'その後の更新', first.revision as string);
  assert.deepEqual(await write(input), first);
  assert.equal(f.files.read('report.md').content, 'その後の更新');
  assert.equal((await write({ ...input, operation_id: 'new-operation' })).error, 'conflict');
});

test('durable write receipts survive restart and never overwrite later edits on replay', t => {
  const f = fixture(t); const database = join(f.root, 'write-log.db');
  const input = { operation_id: 'task:1:0', path: 'report.md', content: '最初の資料', expected_revision: null };
  let log = new WorkspaceWriteLog(database, f.files);
  const result = log.write(input); log.close();
  assert.ok('revision' in result);
  f.files.write('report.md', '後から追加した編集', result.revision);
  log = new WorkspaceWriteLog(database, f.files);
  try {
    assert.deepEqual(log.write(input), result);
    assert.equal(f.files.read('report.md').content, '後から追加した編集');
    assert.throws(() => log.write({ ...input, content: '別の内容' }), /conflict/);
  } finally { log.close(); }
});

test('an interrupted write is reconciled against the file after restart without executing again', t => {
  const f = fixture(t); const database = join(f.root, 'write-log.db');
  const input = { operation_id: 'task:1:0', path: 'report.md', content: '応答だけ失われた資料', expected_revision: null };
  let executions = 0;
  let log = new WorkspaceWriteLog(database, {
    read: name => f.files.read(name), write: (name, content, expected) => {
      executions++; f.files.write(name, content, expected); throw new Error('Artificial connection loss after write');
    },
  });
  assert.deepEqual(log.write(input), { error: 'outcome_unknown' }); log.close();
  log = new WorkspaceWriteLog(database, {
    read: name => f.files.read(name), write: () => { executions++; throw new Error('Must not execute again'); },
  });
  try {
    assert.equal((log.write(input) as { revision: string }).revision, f.files.read(input.path).revision);
    assert.equal(executions, 1);
  } finally { log.close(); }
});

test('unknown or failed writes are not retried and a closed receipt store never starts a write', t => {
  const f = fixture(t); const database = join(f.root, 'write-log.db');
  const input = { operation_id: 'unknown', path: 'report.md', content: '未確認の資料', expected_revision: null };
  let executions = 0;
  const log = new WorkspaceWriteLog(database, {
    read: name => f.files.read(name), write: () => { executions++; throw new Error('Artificial failure before write'); },
  });
  try {
    assert.deepEqual(log.write(input), { error: 'outcome_unknown' });
    assert.deepEqual(log.write(input), { error: 'outcome_unknown' });
    assert.equal(executions, 1);
  } finally { log.close(); }
  assert.throws(() => log.write({ ...input, operation_id: 'closed-store' }));
  assert.equal(executions, 1);
  const reopened = new WorkspaceWriteLog(database, f.files);
  try {
    assert.deepEqual(reopened.write(input), { error: 'outcome_unknown' });
    assert.equal(f.files.list().entries.length, 0);
    const current = f.files.write('report.md', '既存資料', null);
    const conflict = { ...input, operation_id: 'conflict' };
    assert.deepEqual(reopened.write(conflict), { error: 'conflict' });
    f.files.write('report.md', '別編集', current.revision);
    assert.deepEqual(reopened.write(conflict), { error: 'conflict' });
    assert.equal(f.files.read('report.md').content, '別編集');
  } finally { reopened.close(); }
});
