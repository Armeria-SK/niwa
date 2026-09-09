import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import { assertDirectoryPath } from '../config/paths.ts';
import { validatePodmanInfo } from './preflight.ts';

export interface ProgramEnvironment { workspace: string; image: string; uid: number; gid: number; home: string; runtime: string }
export interface ProgramRequest { command: string[]; seconds: number }
export interface ProgramOutput { code: number; stdout: string; stderr: string }
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
  try { return await call(args, request.seconds + 10, signal); }
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
  const call: PodmanCall = (args, seconds, signal, maxBytes = 65536) => new Promise((resolve, reject) => {
    if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>96*1024*1024){reject(new Error('Invalid output limit'));return;}
    execFile('/usr/bin/podman', args, { cwd: environment.home, encoding: 'utf8', timeout: seconds * 1000, maxBuffer: maxBytes,
      killSignal: 'SIGKILL', signal, env: { PATH: '/usr/bin:/bin', HOME: environment.home, XDG_RUNTIME_DIR: environment.runtime } },
    (error, stdout, stderr) => {
      if (error && (typeof error.code !== 'number' || error.killed || error.signal)) reject(new Error('Isolated program interrupted; outcome unknown'));
      else resolve({ code: error?.code as number ?? 0, stdout, stderr });
    });
  });
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
