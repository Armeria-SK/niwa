import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePodmanInfo } from '../src/sandbox/preflight.ts';

const environment = { home: '/product/runtime/executor/home', runtime: '/run/user/1001' };
const valid = () => ({ host: { security: { rootless: true, seccompEnabled: true }, serviceIsRemote: false, cgroupVersion: 'v2', cgroupControllers: ['cpu', 'memory', 'pids'] },
  store: { graphRoot: environment.home + '/.local/share/containers/storage', runRoot: environment.runtime + '/containers' } });
test('executor preflight rejects rootful, remote, unconfined, uncontrolled and foreign-storage runtimes', () => {
  validatePodmanInfo(valid(), environment);
  for (const value of [null, {}, { host: {} }, { ...valid(), store: {} }]) assert.throws(() => validatePodmanInfo(value, environment));
  for (const change of [{ serviceIsRemote: true }, { cgroupVersion: 'v1' }, { cgroupControllers: ['cpu', 'pids'] },
    { security: { rootless: false, seccompEnabled: true } }, { security: { rootless: true, seccompEnabled: false } }])
    assert.throws(() => validatePodmanInfo({ ...valid(), host: { ...valid().host, ...change } }, environment));
  for (const graphRoot of ['/var/lib/containers', '/product/runtime/executor/home-elsewhere/store', environment.home + '/../private', environment.home])
    assert.throws(() => validatePodmanInfo({ ...valid(), store: { ...valid().store, graphRoot } }, environment));
  assert.throws(() => validatePodmanInfo({ ...valid(), store: { ...valid().store, runRoot: '/run/user/1002/containers' } }, environment));
});
