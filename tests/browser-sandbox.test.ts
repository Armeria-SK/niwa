import test from 'node:test';
import assert from 'node:assert/strict';
import { browserArguments } from '../src/sandbox/browser.ts';

test('browser container has no host mount, network, secrets, writable OS or image-controlled entrypoint', () => {
  const environment = { image: `sha256:${'a'.repeat(64)}`, uid: 1001, gid: 1002 };
  const name = 'niwa-browser-00000000-0000-4000-8000-000000000000';
  const args = browserArguments(environment, name);
  for (const flag of ['--network=none', '--http-proxy=false', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
    '--user=1001:1002', '--image-volume=ignore', '--pull=never', '--timeout=900']) assert.ok(args.includes(flag));
  assert.deepEqual(args.slice(-2), [environment.image, '/app/dist/entrypoints/browser-worker.js']);
  assert.ok(!args.some(arg => /--mount|--volume|--privileged|--network=host|--env-file|--no-sandbox/.test(arg)));
  assert.throws(() => browserArguments({ ...environment, uid: 0 }, name));
  assert.throws(() => browserArguments({ ...environment, image: 'latest' }, name));
  assert.throws(() => browserArguments(environment, '--privileged'));
});
