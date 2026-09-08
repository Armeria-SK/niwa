import type { PodmanCall } from '../../sandbox/program.ts';
import type { ApprovedPackage } from './catalog.ts';

export type PackageResult = { image: string; installed: { name: string; version: string }[] } | { error: 'installation_failed' };
export const packageVerificationName = (name: string): string => `${name.slice(0, -1)}${name.endsWith('a') ? 'b' : 'a'}`;

/** Fixed offline apt invocation, container root only, no workspace or private-state mount. */
export function packageArguments(image: string, stage: string, name: string, count: number): string[] {
  if (!/^sha256:[a-f0-9]{64}$/.test(image) || !/^\/[^,:\x00-\x1f]+$/.test(stage) ||
    stage.split('/').some(part => part === '.' || part === '..') || !/^niwa-package-[a-f0-9-]{36}$/.test(name) ||
    !Number.isInteger(count) || count < 1 || count > 32) throw new Error('Invalid package environment');
  return ['run', '--name', name, '--pull=never', '--network=none', '--http-proxy=false', '--user=0:0',
    '--security-opt=no-new-privileges', '--cap-drop=NET_RAW,NET_BIND_SERVICE,SETFCAP,SETPCAP,KILL',
    '--pid=private', '--ipc=private', '--uts=private', '--pids-limit=128', '--memory=1g', '--memory-swap=1g', '--cpus=1',
    '--ulimit=nofile=256:256', '--ulimit=core=0:0', '--log-driver=none', '--systemd=false', '--health-cmd=none',
    '--image-volume=ignore', '--timeout=300', '--stop-timeout=1', '--workdir=/', '--env=DEBIAN_FRONTEND=noninteractive',
    '--mount', `type=bind,source=${stage},destination=/packages,ro`, '--entrypoint=/usr/bin/apt-get', image,
    // --no-download also skips apt's local-file acquisition and breaks .deb installs.
    // Disable repository inputs instead; the container also has no network.
    '-y', '--no-remove', '-o', 'Dir::Etc::sourcelist=/dev/null', '-o', 'Dir::Etc::sourceparts=-',
    'install', ...Array.from({ length: count }, (_, index) => `/packages/${index}.deb`)];
}

export async function installPackages(image: string, stage: string, name: string, entries: ApprovedPackage[], call: PodmanCall, signal?: AbortSignal): Promise<PackageResult> {
  const args = packageArguments(image, stage, name, entries.length);
  signal?.throwIfAborted();
  try {
    if ((await call(args, 310, signal)).code !== 0) return { error: 'installation_failed' };
    signal?.throwIfAborted();
    const committed = await call(['commit', '--quiet', '--include-volumes=false', name], 120, signal);
    const id = committed.stdout.trim().replace(/^sha256:/, '');
    if (committed.code !== 0 || !/^[a-f0-9]{64}$/.test(id)) throw new Error('Package image outcome unknown');
    const nextImage = `sha256:${id}`;
    // Verification uses the committed filesystem, after all install scripts have stopped.
    const verifyArgs = packageArguments(nextImage, stage, packageVerificationName(name), entries.length);
    const verifyName = verifyArgs[2]!;
    const mount = verifyArgs.indexOf('--mount'); verifyArgs.splice(mount, 2);
    const command = verifyArgs.indexOf('--entrypoint=/usr/bin/apt-get');
    verifyArgs.splice(command, verifyArgs.length - command, '--read-only', '--cap-drop=ALL', '--entrypoint=/usr/bin/dpkg-query', nextImage,
      '-W', '-f=${Package}\t${Version}\t${db:Status-Status}\n', ...entries.map(entry => entry.name));
    try {
      const result = await call(verifyArgs, 310, signal);
      const actual = result.stdout.trim().split('\n').map(line => line.trim()).sort();
      const expected = entries.map(entry => `${entry.name}\t${entry.version}\tinstalled`).sort();
      if (result.code !== 0 || JSON.stringify(actual) !== JSON.stringify(expected)) return { error: 'installation_failed' };
    } finally {
      if ((await call(['rm', '--force', '--ignore', verifyName], 15)).code !== 0) throw new Error('Package verification cleanup failed');
    }
    signal?.throwIfAborted();
    return { image: nextImage, installed: entries.map(({ name, version }) => ({ name, version })) };
  } finally {
    if ((await call(['rm', '--force', '--ignore', name], 15)).code !== 0) throw new Error('Package container cleanup failed');
  }
}
