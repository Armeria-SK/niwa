import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { configuredProgramRunner, type ProgramEnvironment } from './program.ts';
import { BrowserSession } from '../tools/browser/session.ts';

// Includes Chromium threads as well as processes; bounded independently of CPU/memory.
export const BROWSER_PID_LIMIT = 256;

export function browserArguments(environment: Pick<ProgramEnvironment, 'image' | 'uid' | 'gid'>, name: string): string[] {
  if (!/^sha256:[a-f0-9]{64}$/.test(environment.image) || ![environment.uid, environment.gid].every(id => Number.isSafeInteger(id) && id > 0) ||
      !/^niwa-browser-[a-f0-9-]{36}$/.test(name)) throw new Error('Invalid browser container configuration');
  return ['run', '--rm', '--interactive', '--name', name, '--pull=never', '--network=none', '--http-proxy=false',
    '--read-only', '--read-only-tmpfs=false', '--tmpfs=/tmp:rw,nosuid,nodev,size=256m', '--shm-size=64m',
    '--cap-drop=ALL', '--security-opt=seccomp=/home/niwa/niwa/config/browser-seccomp.json', '--security-opt=no-new-privileges', '--userns=keep-id', `--user=${environment.uid}:${environment.gid}`,
    '--pid=private', '--ipc=private', '--uts=private', `--pids-limit=${BROWSER_PID_LIMIT}`, '--memory=1g', '--memory-swap=1g', '--cpus=1',
    '--ulimit=nofile=512:512', '--ulimit=core=0:0', '--log-driver=none', '--systemd=false', '--health-cmd=none', '--image-volume=ignore',
    '--timeout=900', '--stop-timeout=1', '--workdir=/app', '--env=HOME=/tmp', '--entrypoint=/usr/local/bin/node',
    environment.image, '/app/dist/entrypoints/browser-worker.js'];
}

/** The dedicated Linux service owns Podman; the application only receives bounded page observations. */
export function configuredBrowserRunner(environment: ProgramEnvironment) {
  const prerequisite = configuredProgramRunner(environment);
  const env = { PATH: '/usr/bin:/bin', HOME: environment.home, XDG_RUNTIME_DIR: environment.runtime };
  const cleanup = (name: string) => new Promise<void>((resolve, reject) => {
    if (!/^niwa-browser-[a-f0-9-]{36}$/.test(name)) { reject(new Error('Invalid browser container')); return; }
    execFile('/usr/bin/podman', ['rm', '--force', '--ignore', name], { cwd: environment.home, env, timeout: 15_000, maxBuffer: 65536 },
      error => error ? reject(new Error('Browser container cleanup failed')) : resolve());
  });
  const create = () => {
    const name = `niwa-browser-${randomUUID()}`;
    const child = spawn('/usr/bin/podman', browserArguments(environment, name), { cwd: environment.home, env, stdio: ['pipe', 'pipe', 'ignore'] });
    const session = new BrowserSession(child.stdout, child.stdin, async () => {
      try { await cleanup(name); } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
    });
    child.once('error', () => { void session.close().catch(() => {}); });
    child.once('exit', () => { void session.close().catch(() => {}); });
    return session;
  };
  return { create, verify: prerequisite.verify };
}
