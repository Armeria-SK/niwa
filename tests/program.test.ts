import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configuredProgramRunner, executeProgram, programArguments, type PodmanCall } from '../src/sandbox/program.ts';

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
