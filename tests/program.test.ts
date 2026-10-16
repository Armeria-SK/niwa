import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configuredProgramRunner, executeProgram, programArguments, type PodmanCall, type ProgramOutput } from '../src/sandbox/program.ts';
import { capture, tailText } from '../src/sandbox/capture.ts';
import { tmpdir } from 'node:os';

const environment = { workspace: '/srv/niwa/workspace', image: 'sha256:' + 'a'.repeat(64), uid: 1001, gid: 1001,
  home: '/srv/executor', runtime: '/run/user/1001' };
const request = { command: ['python3', '-c', 'print("hello; $(host-command)")'], seconds: 30 };
const name = 'niwa-program-12345678-1234-1234-1234-123456789abc';

test('program boundary fixes the image and namespace policy and keeps code out of host shell arguments', () => {
  const args = programArguments(environment, request, name);
  assert.deepEqual(args.slice(args.indexOf('--entrypoint')), ['--entrypoint', 'python3', environment.image, ...request.command.slice(1)]);
  assert.deepEqual(args.filter(value => value.startsWith('type=bind,')), ['type=bind,source=/srv/niwa/workspace,destination=/workspace,rw']);
  for (const flag of ['--network=none', '--http-proxy=false', '--pull=never', '--cap-drop=ALL', '--security-opt=no-new-privileges',
    '--read-only', '--read-only-tmpfs=false', '--user=1001:1001', '--userns=keep-id', '--pid=private', '--pids-limit=64',
    '--memory=512m', '--memory-swap=512m', '--cpus=1', '--timeout=30', '--log-driver=none', '--image-volume=ignore']) assert.ok(args.includes(flag), flag);
  for (const workspace of ['/', '/srv/../home', '/srv/a,b', '/srv/a:b', '/srv/\nsecret']) assert.throws(() => programArguments({ ...environment, workspace }, request, name));
  for (const image of ['latest', '--privileged', 'docker.io/library/python:latest']) assert.throws(() => programArguments({ ...environment, image }, request, name));
  for (const command of [[], [''], ['node', '\0'], Array(129).fill('a'), ['a'.repeat(65537)]]) assert.throws(() => programArguments(environment, { ...request, command }, name));
  for (const seconds of [0, 301, NaN, 1.5]) assert.throws(() => programArguments(environment, { ...request, seconds }, name));
  assert.throws(() => programArguments({ ...environment, uid: 0 }, request, name));
  if (process.platform !== 'linux') assert.throws(() => configuredProgramRunner(environment), /Linux/);
});

test('program cleanup preserves exit output, uses the exact allocated container and has its own deadline', async () => {
  const calls: { args: string[]; seconds: number; signal?: AbortSignal }[] = [];
  const controller = new AbortController();
  const call: PodmanCall = async (args, seconds, signal) => { calls.push({ args, seconds, ...(signal ? { signal } : {}) });
    return args[0] === 'run' ? { code: 7, stdout: 'partial output', stderr: 'script error' } : { code: 0, stdout: '', stderr: '' }; };
  assert.deepEqual(await executeProgram(environment, request, call, controller.signal), { code: 7, stdout: 'partial output', stderr: 'script error' });
  assert.equal(calls[0]!.seconds, 40); assert.equal(calls[0]!.signal, controller.signal);
  assert.deepEqual(calls[1], { args: ['rm', '--force', '--ignore', calls[0]!.args[2]!], seconds: 15 });
});

test('interruption and cleanup failures cannot become successful or replayed program attempts', async () => {
  const controller = new AbortController(); let runs = 0; let removals = 0;
  const call: PodmanCall = async (args, _seconds, signal) => {
    if (args[0] === 'run') { runs++; controller.abort(); throw new Error('interrupted'); }
    removals++; assert.equal(signal, undefined); return { code: 0, stdout: '', stderr: '' };
  };
  await assert.rejects(executeProgram(environment, request, call, controller.signal), /interrupted/);
  assert.equal(runs, 1); assert.equal(removals, 1);
  await assert.rejects(executeProgram(environment, request, call, controller.signal)); assert.equal(runs, 1);
  await assert.rejects(executeProgram(environment, request, async args => ({ code: args[0] === 'rm' ? 1 : 0, stdout: '', stderr: '' })), /cleanup failed/);
});

const probe = { cwd: tmpdir(), env: { PATH: process.env.PATH ?? '' } };

test('noisy programs run to completion and keep only the last bytes of each stream', async () => {
  const noisy = await capture(process.execPath, ['-e', "process.stdout.write('a'.repeat(300000)+'END');process.stderr.write('e'.repeat(70000)+'ERR');process.exitCode=3"], { ...probe, timeoutMs: 20000 });
  assert.equal(noisy.code, 3); assert.equal(noisy.truncated, true); assert.equal(noisy.timedOut, false);
  assert.equal(Buffer.byteLength(noisy.stdout), 65536); assert.ok(noisy.stdout.endsWith('aEND')); assert.ok(noisy.stderr.endsWith('eERR'));
  const small = await capture(process.execPath, ['-e', "process.stdout.write('ok');process.stderr.write('warn')"], { ...probe, timeoutMs: 20000 });
  assert.deepEqual(small, { code: 0, stdout: 'ok', stderr: 'warn', truncated: false, timedOut: false });
});

test('our own time limit is a reported result while abort, spawn failure and strict overflow stay unknown outcomes', async () => {
  const slow = await capture(process.execPath, ['-e', "process.stdout.write('started');setInterval(()=>{},1000)"], { ...probe, timeoutMs: 400 });
  assert.equal(slow.timedOut, true); assert.equal(slow.code, 124); assert.equal(slow.stdout, 'started');
  const controller = new AbortController(); const aborted = assert.rejects(capture(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { ...probe, timeoutMs: 20000, signal: controller.signal }), /outcome unknown/);
  setTimeout(() => controller.abort(), 100); await aborted;
  await assert.rejects(capture(process.execPath, ['-e', ''], { ...probe, timeoutMs: 20000, signal: AbortSignal.abort() }), /outcome unknown/);
  await assert.rejects(capture('/nonexistent/podman', [], { ...probe, timeoutMs: 1000 }), /outcome unknown/);
  await assert.rejects(capture(process.execPath, ['-e', "process.stdout.write('x'.repeat(5000))"], { ...probe, timeoutMs: 20000, strict: 1000 }), /outcome unknown/);
  assert.equal((await capture(process.execPath, ['-e', "process.stdout.write('x'.repeat(900))"], { ...probe, timeoutMs: 20000, strict: 1000 })).stdout.length, 900);
});

test('tail text never splits a character or exceeds its byte limit', () => {
  const text = tailText(Buffer.from('あ'.repeat(100)), 100);
  assert.equal(Buffer.byteLength(text), 99); assert.match(text, /^あ+$/);
  assert.ok(Buffer.byteLength(tailText(Buffer.alloc(100, 0xff), 50)) <= 50);
  assert.equal(tailText(Buffer.from('short'), 100), 'short');
});

test('truncated and timed-out program output is flagged and reduced to its last 32 KiB', async () => {
  const run = (output: Partial<ProgramOutput>): PodmanCall => async args => args[0] === 'run' ? { code: 0, stdout: '', stderr: '', ...output } : { code: 0, stdout: '', stderr: '' };
  const noisy = await executeProgram(environment, request, run({ stdout: 'x'.repeat(60000) + 'LAST', stderr: 'e', output_truncated: true }));
  assert.equal(noisy.output_truncated, true); assert.equal(noisy.timed_out, undefined); assert.equal(noisy.stdout.length, 32768); assert.ok(noisy.stdout.endsWith('LAST')); assert.equal(noisy.stderr, 'e');
  const timedOut = await executeProgram(environment, request, run({ code: 124, stdout: 'partial', timed_out: true }));
  assert.deepEqual(timedOut, { code: 124, stdout: 'partial', stderr: '', timed_out: true });
  // Podman's own --timeout kills the container first, which only shows as an exit code after the full time.
  const killed = await executeProgram(environment, { ...request, seconds: 1 }, async args => { if (args[0] !== 'run') return { code: 0, stdout: '', stderr: '' }; await new Promise(resolve => setTimeout(resolve, 1050)); return { code: 137, stdout: 'x', stderr: '' }; });
  assert.equal(killed.timed_out, true);
  assert.deepEqual(await executeProgram(environment, request, run({ code: 137, stdout: 'oom' })), { code: 137, stdout: 'oom', stderr: '' });
});
