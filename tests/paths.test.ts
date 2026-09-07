import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initializeProduct, productPaths } from '../src/config/paths.ts';
import { Runtime } from '../src/runtime/runtime.ts';

test('product layout separates source, state, secrets and shared workspace under one explicit root', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'niwa-layout-'));
  try {
    const root = join(temporary, 'niwa');
    assert.throws(() => productPaths('relative'), /absolute/);
    assert.equal(existsSync(root), false);
    const paths = initializeProduct(root);
    assert.deepEqual(readdirSync(root).sort(), ['app', 'backups', 'config', 'logs', 'runtime', 'secrets', 'state', 'workspace']);
    const runtime = new Runtime(paths.state);
    try { runtime.bootstrap(runtime.administrator()); } finally { runtime.close(); }
    assert.equal(existsSync(join(paths.state, 'control.db')), true);
    for (const path of [paths.app, paths.secrets, paths.workspace]) assert.deepEqual(readdirSync(path), []);
    assert.deepEqual(initializeProduct(root), paths);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
