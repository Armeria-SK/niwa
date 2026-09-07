import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { validatePodmanInfo } from '../../dist/sandbox/preflight.js';

assert.equal(process.platform, 'linux');
assert.ok(process.getuid() > 0, 'Run as niwa-exec, never root');
const home = '/home/niwa/niwa/runtime/executor/home';
const runtime = `/run/user/${process.getuid()}`;
assert.equal(process.env.HOME, home);
assert.equal(process.env.XDG_RUNTIME_DIR, runtime);
const info = JSON.parse(execFileSync('/usr/bin/podman', ['info', '--format=json'], {
  cwd: home, timeout: 30_000, maxBuffer: 1024 * 1024, encoding: 'utf8',
}));
validatePodmanInfo(info, { home, runtime });
console.log('PASS: rootless, local Podman; seccomp; cgroup v2 cpu/memory/pids; private storage paths');
console.log(JSON.stringify({ graphRoot: info.store.graphRoot, runRoot: info.store.runRoot }));
console.log('Disk limits, verified images and container isolation acceptance remain required.');
