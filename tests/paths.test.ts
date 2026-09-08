import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
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
    assert.deepEqual(readdirSync(root).sort(), ['backups', 'config', 'runtime', 'secrets', 'state', 'workspace']);
    const runtime = new Runtime(paths.state);
    try { runtime.bootstrap(runtime.administrator()); } finally { runtime.close(); }
    assert.equal(existsSync(join(paths.state, 'control.db')), true);
    for (const path of [paths.secrets, paths.workspace]) assert.deepEqual(readdirSync(path), []);
    assert.deepEqual(initializeProduct(root), paths);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test('initializing a direct checkout preserves source files and existing directory permissions', () => {
  const root = mkdtempSync(join(tmpdir(), 'niwa-checkout-'));
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'keep.ts'), 'existing source');
    mkdirSync(join(root, 'workspace'), { mode: 0o750 });
    const mode = statSync(join(root, 'workspace')).mode;
    initializeProduct(root);
    assert.equal(existsSync(join(root, 'app')), false);
    assert.equal(readFileSync(join(root, 'src', 'keep.ts'), 'utf8'), 'existing source');
    assert.equal(statSync(join(root, 'workspace')).mode, mode);
    // A legacy app directory is left intact when reopening older installations.
    mkdirSync(join(root, 'app'));
    writeFileSync(join(root, 'app', 'keep'), 'legacy file');
    initializeProduct(root);
    assert.equal(readFileSync(join(root, 'app', 'keep'), 'utf8'), 'legacy file');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
