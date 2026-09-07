import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runtime } from '../src/runtime/runtime.ts';

test('account limits survive restart and stale probe success cannot erase a newer quota report', () => {
  const root = mkdtempSync(join(tmpdir(), 'niwa-limits-')); let runtime = new Runtime(root);
  try {
    let admin = runtime.administrator(); const leader = runtime.bootstrap(admin);
    const key = 'a'.repeat(64), other = 'b'.repeat(64), future = Date.now() + 20 * 60_000;
    assert.throws(() => runtime.providerLimits.exceeded(runtime.agentSession(leader.id), key), /Administrator/);
    runtime.providerLimits.exceeded(admin, key);
    assert.equal(runtime.providerLimits.blocked(admin, key), true);
    assert.equal(runtime.providerLimits.blocked(admin, other), false);
    runtime.close(); runtime = new Runtime(root); admin = runtime.administrator();
    assert.equal(runtime.providerLimits.blocked(admin, key), true);
    const version = runtime.providerLimits.begin(admin, key, future)!;
    assert.equal(runtime.providerLimits.begin(admin, key, future), undefined);
    runtime.providerLimits.exceeded(admin, key);
    runtime.providerLimits.recovered(admin, key, version);
    assert.equal(runtime.providerLimits.blocked(admin, key, future), true);
    const latest = runtime.providerLimits.begin(admin, key, future + 60_000)!;
    runtime.providerLimits.recovered(admin, key, latest);
    assert.equal(runtime.providerLimits.blocked(admin, key), false);
  } finally { runtime.close(); rmSync(root, { recursive: true, force: true }); }
});
