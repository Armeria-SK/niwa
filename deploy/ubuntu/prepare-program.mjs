import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePodmanInfo } from '../../dist/sandbox/preflight.js';
import { diskProbe } from './program-probes.mjs';

assert.deepEqual(process.argv.slice(2), ['--apply']);
const root = '/home/niwa/niwa';
const home = join(root, 'runtime/executor/home');
const workspace = join(root, 'workspace');
const uid = Number(execFileSync('/usr/bin/id', ['-u', 'niwa-exec'], { encoding: 'utf8' }).trim());
assert.ok(uid > 0 && process.getuid() === uid, 'Run as niwa-exec');
const runtime = `/run/user/${uid}`;
assert.equal(process.env.HOME, home); assert.equal(process.env.XDG_RUNTIME_DIR, runtime);
for (const [path, gib] of [[workspace, 8], [join(root, 'runtime/executor'), 16]]) {
  assert.ok(!lstatSync(path).isSymbolicLink());
  execFileSync('/usr/bin/mountpoint', ['-q', path]);
  const fs = statfsSync(path);
  assert.ok(fs.blocks * fs.bsize <= gib * 1024 ** 3, 'Bounded storage required');
}
assert.ok(readdirSync(workspace).every(name => name === 'lost+found' && lstatSync(join(workspace, name)).uid === 0),
  'Use the initial empty workspace for capacity tests; existing Bot files require separate acceptance');
const imageLock = JSON.parse(readFileSync(new URL('./program-image.json', import.meta.url), 'utf8'));
assert.match(imageLock.reference, /^docker\.io\/library\/python@sha256:[a-f0-9]{64}$/);
assert.equal(imageLock.platform, 'linux/amd64');

const temporary = mkdtempSync(join(home, 'program-preparation-'));
let verificationWorkspace;
const podman = (...args) => execFileSync('/usr/bin/podman', args, { cwd: home, encoding: 'utf8', timeout: 300_000,
  maxBuffer: 4 * 1024 * 1024, env: { PATH: '/usr/bin:/bin', HOME: home, XDG_RUNTIME_DIR: runtime, TMPDIR: temporary,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/bus` } });
try {
  validatePodmanInfo(JSON.parse(podman('info', '--format=json')), { home, runtime });
  assert.equal(podman('ps', '-aq').trim(), '', 'Existing containers require review');
  console.log('Checking executor-volume ENOSPC with an artificial temporary file');
  execFileSync('/usr/bin/python3', ['-c', diskProbe(temporary)], { stdio: 'inherit', timeout: 60_000 });
  console.log(`Pulling verified platform manifest: ${imageLock.reference}`);
  podman('pull', '--quiet', imageLock.reference);
  const image = JSON.parse(podman('image', 'inspect', imageLock.reference))[0];
  assert.equal(image.Digest, imageLock.reference.split('@')[1], 'Pulled manifest differs from lock');
  assert.equal(image.Os, 'linux'); assert.equal(image.Architecture, 'amd64');
  const id = image.Id.startsWith('sha256:') ? image.Id : `sha256:${image.Id}`;
  assert.match(id, /^sha256:[a-f0-9]{64}$/);
  verificationWorkspace = mkdtempSync(join(workspace, '.program-verification-'));
  execFileSync(process.execPath, [fileURLToPath(new URL('./verify-program.mjs', import.meta.url)), '--apply', '--resources',
    '--workspace', verificationWorkspace, '--home', home, '--runtime', runtime, '--image', id],
  { cwd: home, stdio: 'inherit', timeout: 180_000 });
  const receipt = { image: id, reference: imageLock.reference, verified_at: new Date().toISOString(),
    checks: ['program-boundaries', 'workspace-enospc', 'executor-enospc', 'memory-limit', 'pid-limit', 'timeout', 'cancellation'] };
  const staged = join(temporary, 'program-acceptance.json');
  writeFileSync(staged, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  renameSync(staged, join(root, 'runtime/executor/state/program-acceptance.json'));
  console.log('PASS: program image and container acceptance; receipt saved in executor state');
  console.log('Application configuration and Niwa services have not been enabled.');
} finally {
  if (verificationWorkspace) rmSync(verificationWorkspace, { recursive: true, force: true });
  rmSync(temporary, { recursive: true, force: true });
}
