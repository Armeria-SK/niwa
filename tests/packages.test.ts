import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PackageCatalog } from '../src/tools/packages/catalog.ts';
import { installPackages, packageArguments } from '../src/tools/packages/install.ts';
import type { PodmanCall } from '../src/sandbox/program.ts';
import { PackageLog } from '../src/tools/packages/log.ts';
import { once } from 'node:events';
import { createProgramServer } from '../src/sandbox/server.ts';
import { packageExecutor } from '../src/tools/packages/client.ts';
import { Runtime } from '../src/runtime/runtime.ts';
import { executeAsyncTurnTool, turnTools } from '../src/runtime/turn-tools.ts';

const image = `sha256:${'a'.repeat(64)}`;
const name = 'niwa-package-12345678-1234-1234-1234-123456789abc';
const entry = { name: 'hello', version: '2.10-1', file: 'hello.deb', sha256: createHash('sha256').update('fixture').digest('hex') };

test('package catalog exposes names only and snapshots exclusively from verified private files', () => {
  const root = mkdtempSync(join(tmpdir(), 'niwa-package-'));
  try {
    const catalogPath = join(root, 'catalog'); mkdirSync(catalogPath, { mode: 0o700 });
    writeFileSync(join(catalogPath, 'catalog.json'), JSON.stringify([entry]), { mode: 0o600 });
    writeFileSync(join(catalogPath, entry.file), 'fixture', { mode: 0o600 });
    const catalog = new PackageCatalog(catalogPath);
    assert.deepEqual(catalog.list(), [{ name: 'hello', version: '2.10-1' }]);
    assert.throws(() => catalog.select(['--privileged'])); assert.throws(() => catalog.select(['missing']));
    assert.throws(() => catalog.select(['hello', 'hello']));
    catalog.stage(['hello'], join(root, 'stage'));
    assert.equal(readFileSync(join(root, 'stage', '0.deb'), 'utf8'), 'fixture');
    assert.throws(() => catalog.stage(['hello'], join(root, 'stage')));
    writeFileSync(join(catalogPath, entry.file), 'changed');
    assert.throws(() => catalog.stage(['hello'], join(root, 'changed')), /digest/);
    writeFileSync(join(catalogPath, 'catalog.json'), JSON.stringify([{ ...entry, file: '../secret.deb' }]));
    assert.throws(() => new PackageCatalog(catalogPath));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('offline installation has one readonly package mount and selects only a verified committed image', async () => {
  const calls: string[][] = [];
  const call: PodmanCall = async args => {
    calls.push(args);
    return { code: 0, stdout: args[0] === 'commit' ? 'b'.repeat(64) : args.includes('--entrypoint=/usr/bin/dpkg-query') ? 'hello\t2.10-1\tinstalled\n' : '', stderr: '' };
  };
  assert.deepEqual(await installPackages(image, '/executor/stage', name, [entry], call), {
    image: `sha256:${'b'.repeat(64)}`, installed: [{ name: 'hello', version: '2.10-1' }],
  });
  const args = calls[0]!;
  for (const flag of ['--network=none', '--http-proxy=false', '--user=0:0', '--security-opt=no-new-privileges', '--no-download', '--no-remove', '--pids-limit=128']) assert.ok(args.includes(flag));
  assert.deepEqual(args.filter(arg => arg.startsWith('type=bind,')), ['type=bind,source=/executor/stage,destination=/packages,ro']);
  assert.deepEqual(calls[1], ['commit', '--quiet', '--include-volumes=false', name]);
  assert.ok(calls[2]!.includes('--read-only')); assert.ok(!calls[2]!.includes('--mount'));
  assert.equal(calls.filter(args => args[0] === 'rm').length, 2);
  for (const path of ['/', '/a/../b', '/a,b', '/a:b']) assert.throws(() => packageArguments(image, path, name, 1));
});

test('failed installation, incorrect installed versions and cancellation never return a selected image', async () => {
  let commits = 0; let removals = 0;
  const failed: PodmanCall = async args => { commits += Number(args[0] === 'commit'); removals += Number(args[0] === 'rm'); return { code: args[0] === 'run' ? 1 : 0, stdout: '', stderr: '' }; };
  assert.deepEqual(await installPackages(image, '/executor/stage', name, [entry], failed), { error: 'installation_failed' });
  assert.equal(commits, 0); assert.equal(removals, 1);
  const wrong: PodmanCall = async args => ({ code: 0, stdout: args[0] === 'commit' ? 'b'.repeat(64) : 'hello\twrong\tinstalled\n', stderr: '' });
  assert.deepEqual(await installPackages(image, '/executor/stage', name, [entry], wrong), { error: 'installation_failed' });
  const controller = new AbortController();
  const interrupted: PodmanCall = async args => { if (args[0] === 'run') { controller.abort(); throw new Error('interrupted'); } return { code: 0, stdout: '', stderr: '' }; };
  await assert.rejects(installPackages(image, '/executor/stage', name, [entry], interrupted, controller.signal), /interrupted/);
});

test('package journal serializes images, preserves receipts across restart and never retries an unknown attempt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'niwa-package-log-'));
  writeFileSync(join(root, 'catalog.json'), JSON.stringify([entry]), { mode: 0o600 });
  const catalog = new PackageCatalog(root); const file = join(root, 'packages.db');
  const input = { operation_id: 'one', agent_id: 'bot', room_id: 'shared', task_id: 'task', allow_start: true, names: ['hello'] };
  const images: string[] = []; let log: PackageLog | undefined;
  try {
    log = new PackageLog(file, image, catalog, async current => {
      images.push(current); await new Promise(resolve => setTimeout(resolve, 5));
      return { image: `sha256:${String(images.length).repeat(64)}`, installed: catalog.list() };
    });
    const [first, second] = await Promise.all([log.execute(input), log.execute({ ...input, operation_id: 'two' })]);
    assert.deepEqual(images, [image, `sha256:${'1'.repeat(64)}`]);
    assert.equal(log.currentImage(), `sha256:${'2'.repeat(64)}`);
    assert.deepEqual(await log.execute(input), first); assert.equal(images.length, 2);
    await assert.rejects(log.execute({ ...input, agent_id: 'other' }), /conflicts/);
    await log.close(); log = new PackageLog(file, image, catalog, async () => { throw new Error('interrupted'); });
    assert.deepEqual(await log.execute({ ...input, operation_id: 'two', allow_start: false }), second);
    assert.deepEqual(await log.execute({ ...input, operation_id: 'missing', allow_start: false }), { error: 'outcome_unknown' });
    assert.deepEqual(await log.execute({ ...input, operation_id: 'unknown' }), { error: 'outcome_unknown' });
    assert.equal(log.pending().length, 1); assert.equal(log.currentImage(), `sha256:${'2'.repeat(64)}`);
    await log.close(); let reruns = 0;
    log = new PackageLog(file, image, catalog, async () => { reruns++; return { error: 'installation_failed' }; });
    assert.deepEqual(await log.execute({ ...input, operation_id: 'unknown' }), { error: 'outcome_unknown' }); assert.equal(reruns, 0);
    assert.deepEqual(await log.execute({ ...input, operation_id: 'failed' }), { error: 'installation_failed' });
    assert.equal(log.currentImage(), `sha256:${'2'.repeat(64)}`);
  } finally { await log?.close(); rmSync(root, { recursive: true, force: true }); }
});

test('package IPC and common tools enforce shared scope and durable single execution', async () => {
  const root = mkdtempSync(join(tmpdir(), 'niwa-package-turn-'));
  writeFileSync(join(root, 'catalog.json'), JSON.stringify([entry]), { mode: 0o600 });
  const runtime = new Runtime(join(root, 'state')); const admin = runtime.administrator();
  const leader = runtime.bootstrap(admin); const actor = runtime.agentSession(leader.id); let runs = 0;
  const catalog = new PackageCatalog(root);
  const log = new PackageLog(join(root, 'packages.db'), image, catalog, async () => { runs++; return { image, installed: catalog.list() }; });
  const broker = createProgramServer({ execute: async () => { throw new Error('Unexpected program'); } }, log);
  const socket = process.platform === 'win32' ? `\\\\.\\pipe\\niwa-packages-${randomUUID()}` : join(root, 'socket');
  broker.server.listen(socket); await once(broker.server, 'listening');
  const external = { packages: packageExecutor(socket, () => {}) };
  const call = { name: 'packages_install', arguments: { names: ['hello'] }, tool_call_id: 'install' };
  try {
    assert.equal(turnTools(false, external, true).some(tool => tool.name === call.name), true);
    assert.equal(turnTools(false, external, false).some(tool => tool.name === call.name), false);
    const privateRoom = runtime.createRoom(admin, '個別', [leader.id]);
    runtime.tasks.create(admin, leader.id, privateRoom.id, 'private'); const privateLease = runtime.tasks.claim(admin)!;
    assert.ok((await executeAsyncTurnTool(runtime, actor, privateLease, call, '0', undefined, external)).error); assert.equal(runs, 0);
    runtime.tasks.finish(actor, privateLease, 'done');
    const room = runtime.createRoom(admin, '共有'); runtime.tasks.create(admin, leader.id, room.id, 'install'); const lease = runtime.tasks.claim(admin)!;
    assert.deepEqual(await external.packages.list(), { available: catalog.list(), installed: [] });
    const result = await executeAsyncTurnTool(runtime, actor, lease, call, '0', undefined, external);
    assert.deepEqual(await executeAsyncTurnTool(runtime, actor, lease, call, '0', undefined, external), result); assert.equal(runs, 1);
    assert.deepEqual((await external.packages.list()).installed, catalog.list());
    await assert.rejects(external.packages.execute({ operation_id: 'injected', agent_id: leader.id, room_id: room.id, task_id: lease.task.id, names: ['missing'], allow_start: true }));
    assert.equal(runs, 1);
  } finally { await broker.stop(); await log.close(); runtime.close(); rmSync(root, { recursive: true, force: true }); }
});
