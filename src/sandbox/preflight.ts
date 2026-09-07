import { posix } from 'node:path';
import type { ProgramEnvironment } from './program.ts';

/** Startup metadata is a prerequisite, not a substitute for container escape/resource tests. */
export function validatePodmanInfo(value: unknown, environment: Pick<ProgramEnvironment, 'home' | 'runtime'>): void {
  const info = value as { host?: { security?: { rootless?: boolean; seccompEnabled?: boolean }; serviceIsRemote?: boolean;
    cgroupVersion?: string; cgroupControllers?: string[] }; store?: { graphRoot?: string; runRoot?: string } } | null;
  const host = info?.host;
  const inside = (root: string, path: unknown) => {
    if (typeof path !== 'string' || !posix.isAbsolute(path)) return false;
    const rel = posix.relative(root, path); return !!rel && rel !== '..' && !rel.startsWith('../');
  };
  if (host?.security?.rootless !== true || host.security.seccompEnabled !== true || host.serviceIsRemote !== false ||
      host.cgroupVersion !== 'v2' || !Array.isArray(host.cgroupControllers) || !['cpu', 'memory', 'pids'].every(name => host.cgroupControllers!.includes(name)) ||
      !inside(environment.home, info?.store?.graphRoot) || !inside(environment.runtime, info?.store?.runRoot))
    throw new Error('Podman isolation prerequisites are not satisfied');
}
