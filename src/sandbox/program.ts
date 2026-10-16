import { randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import { assertDirectoryPath } from '../config/paths.ts';
import { validatePodmanInfo } from './preflight.ts';
import { capture, tailText } from './capture.ts';

export interface ProgramEnvironment { workspace: string; image: string; uid: number; gid: number; home: string; runtime: string }
export interface ProgramRequest { command: string[]; seconds: number }
/** `timed_out` and `output_truncated` are only present when true; truncated/timed-out output keeps just its last 32 KiB. */
export interface ProgramOutput { code: number; stdout: string; stderr: string; timed_out?: true; output_truncated?: true }
export type PodmanCall = (args: string[], seconds: number, signal?: AbortSignal, maxBytes?: number) => Promise<ProgramOutput>;

/** Only trusted executor configuration chooses mounts, identity and an already installed image. */
export function programArguments(environment: ProgramEnvironment, request: ProgramRequest, name: string): string[] {
  const { workspace, image, uid, gid } = environment;
  if (!/^\/[^,:\x00-\x1f]+$/.test(workspace) || workspace.split('/').some(part => part === '.' || part === '..') ||
      !/^sha256:[a-f0-9]{64}$/.test(image) || ![uid, gid].every(value => Number.isSafeInteger(value) && value > 0) ||
      !/^niwa-program-[a-f0-9-]{36}$/.test(name) || !Number.isInteger(request.seconds) || request.seconds < 1 || request.seconds > 300 ||
      !Array.isArray(request.command) || !request.command.length || request.command.length > 128 ||
      request.command.some(value => typeof value !== 'string' || value.includes('\0')) || !request.command[0] ||
      Buffer.byteLength(JSON.stringify(request.command)) > 65536) throw new Error('Invalid isolated program request');
  return ['run', '--name', name, '--pull=never', '--network=none', '--http-proxy=false', '--read-only', '--read-only-tmpfs=false',
    '--tmpfs=/tmp:rw,nosuid,nodev,size=64m', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--userns=keep-id',
    `--user=${uid}:${gid}`, '--pid=private', '--ipc=private', '--uts=private', '--pids-limit=64', '--memory=512m', '--memory-swap=512m',
    '--cpus=1', '--ulimit=nofile=256:256', '--ulimit=core=0:0', '--log-driver=none', '--systemd=false', '--health-cmd=none', '--image-volume=ignore',
    `--timeout=${request.seconds}`, '--stop-timeout=1', '--workdir=/workspace', '--env=HOME=/tmp',
    '--mount', `type=bind,source=${workspace},destination=/workspace,rw`, '--entrypoint', request.command[0]!, image, ...request.command.slice(1)];
}

/** A failed/interrupted attempt has an unknown write outcome; callers must never automatically replay it. */
export async function executeProgram(environment: ProgramEnvironment, request: ProgramRequest, call: PodmanCall, signal?: AbortSignal, name = `niwa-program-${randomUUID()}`): Promise<ProgramOutput> {
  const args = programArguments(environment, request, name);
  signal?.throwIfAborted();
  try {
    const started = Date.now(), output = await call(args, request.seconds + 10, signal);
    // Podman's own --timeout kills the container first (exit 124/137); the client kill after +10s is flagged by the caller.
    const timedOut = output.timed_out === true || ([124, 137].includes(output.code) && Date.now() - started >= request.seconds * 1000);
    if (!timedOut && !output.output_truncated) return output;
    const tail = (value: string) => tailText(Buffer.from(value), 32768);
    return { code: output.code, stdout: tail(output.stdout), stderr: tail(output.stderr), ...(timedOut ? { timed_out: true as const } : {}), ...(output.output_truncated ? { output_truncated: true as const } : {}) };
  }
  finally {
    // Kill the container, not only the attached Podman client; cancellation must not cancel cleanup.
    const removed = await call(['rm', '--force', '--ignore', name], 15);
    if (removed.code !== 0) throw new Error('Isolated program cleanup failed; outcome unknown');
  }
}

/** Construction is restricted to the dedicated Linux executor, never the web/model process. */
export function configuredProgramRunner(environment: ProgramEnvironment, currentImage: () => string = () => environment.image) {
  if (process.platform !== 'linux' || process.getuid?.() !== environment.uid || !environment.uid || process.getgid?.() !== environment.gid)
    throw new Error('Dedicated non-root Linux identity required');
  for (const directory of [environment.workspace, environment.home, environment.runtime]) {
    if (!isAbsolute(directory)) throw new Error('Absolute executor directory required');
    assertDirectoryPath(directory);
    if (!lstatSync(directory).isDirectory()) throw new Error('Missing executor directory');
  }
  for (const directory of [environment.home, environment.runtime]) {
    const relation = relative(environment.workspace, directory);
    const info = lstatSync(directory);
    if (!relation || (!relation.startsWith('../') && relation !== '..') || info.uid !== environment.uid || (info.mode & 0o077))
      throw new Error('Executor state must be private and outside the shared mount');
  }
  // Output keeps only the last 64 KiB per stream so noisy programs finish; an explicit maxBytes is a strict limit for machine-read output.
  const call: PodmanCall = async (args, seconds, signal, maxBytes) => {
    if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 96 * 1024 * 1024)) throw new Error('Invalid output limit');
    const result = await capture('/usr/bin/podman', args, { cwd: environment.home, timeoutMs: seconds * 1000, signal, ...(maxBytes === undefined ? {} : { strict: maxBytes }),
      env: { PATH: '/usr/bin:/bin', HOME: environment.home, XDG_RUNTIME_DIR: environment.runtime } });
    return { code: result.code, stdout: result.stdout, stderr: result.stderr, ...(result.timedOut ? { timed_out: true as const } : {}), ...(result.truncated ? { output_truncated: true as const } : {}) };
  };
  const run = (request: ProgramRequest, signal?: AbortSignal, name?: string) => {
    assertDirectoryPath(environment.workspace);
    return executeProgram({ ...environment, image: currentImage() }, request, call, signal, name);
  };
  return Object.assign(run, { call, verify: async () => {
    const info = await call(['info', '--format=json'], 15);
    if (info.code !== 0) throw new Error('Podman information unavailable');
    validatePodmanInfo(JSON.parse(info.stdout), environment);
    if (!/^sha256:[a-f0-9]{64}$/.test(currentImage()) || (await call(['image', 'exists', currentImage()], 15)).code !== 0)
      throw new Error('Configured execution image must already be installed');
  }, cleanup: async (name: string) => {
    if (!/^niwa-program-[a-f0-9-]{36}$/.test(name)) throw new Error('Invalid saved container');
    if ((await call(['rm', '--force', '--ignore', name], 15)).code !== 0) throw new Error('Container recovery failed');
  } });
}
