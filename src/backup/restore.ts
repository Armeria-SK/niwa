import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { Runtime } from '../runtime/runtime.ts';
import { assertDirectoryPath, initializeProduct, productPaths } from '../config/paths.ts';
import { initializeInstallation, readInstallation } from '../config/installation.ts';
import { acquireProcessLock } from '../runtime/process-lock.ts';
import type { BackupManifest } from './backups.ts';

/** Prepare a new state directory. The caller must hold the source service lock until activation. */
export async function prepareRestore(backup: string, target: string, deletions: ReturnType<Runtime['deletionRecords']>): Promise<BackupManifest> {
  assertDirectoryPath(backup); assertDirectoryPath(target);
  const manifestPath = join(backup, 'manifest.json'); const stat = await fs.lstat(manifestPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('Invalid backup manifest');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as BackupManifest;
  if (manifest.version !== 1 || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 1001) throw new Error('Invalid backup files');
  const names = new Set<string>();
  for (const file of manifest.files) {
    if (!/^(control\.db|agents\/[0-9a-f-]{36}\/memory\.db)\.gz$/.test(file.path) || names.has(file.path)
      || !Number.isSafeInteger(file.bytes) || file.bytes <= 0 || !/^[0-9a-f]{64}$/.test(file.sha256)) throw new Error('Invalid backup file');
    names.add(file.path);
  }
  if (!names.has('control.db.gz')) throw new Error('Missing control database');
  await fs.mkdir(target, { mode: 0o700 });
  try {
    for (const file of manifest.files) {
      const source = join(backup, file.path); assertDirectoryPath(dirname(source));
      const info = await fs.lstat(source);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size !== file.bytes) throw new Error('Invalid backup file');
      const hash = createHash('sha256'); let expanded = 0;
      const destination = join(target, file.path.slice(0, -3)); await fs.mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await pipeline(createReadStream(source), new Transform({ transform(chunk: Buffer, _encoding, done) { hash.update(chunk); done(null, chunk); } }), createGunzip(),
        new Transform({ transform(chunk: Buffer, _encoding, done) { expanded += chunk.length; done(expanded > 4 * 1024 ** 3 ? new Error('Backup database exceeds restore limit') : null, chunk); } }),
        createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
      if (hash.digest('hex') !== file.sha256) throw new Error('Backup checksum mismatch');
      const db = new DatabaseSync(destination, { readOnly: true });
      try {
        if (db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Invalid database');
      } finally { db.close(); }
    }
    const restored = new Runtime(target);
    try {
      const admin = restored.administrator();
      const expected = new Set(['control.db.gz', ...restored.agents(admin).map(agent => `agents/${agent.id}/memory.db.gz`)]);
      if (expected.size !== names.size || [...expected].some(name => !names.has(name))) throw new Error('Incomplete backup database set');
      restored.applyDeletions(admin, [...restored.deletionRecords(admin), ...deletions]);
      restored.updateSettings(admin, { paused: true });
    } finally { restored.close(); }
    return manifest;
  } catch (error) {
    assertDirectoryPath(target); await fs.rm(target, { recursive: true }); throw error;
  }
}

/** Restore into an explicitly named new installation; the existing installation stays intact. */
export async function restoreInstallation(root: string, id: string, destination: string) {
  const source = productPaths(root); const target = productPaths(destination);
  const relation = relative(source.root, target.root);
  if (!/^[0-9a-f-]{36}$/.test(id) || (!isAbsolute(relation) && relation !== '..' && !relation.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`))) throw new Error('Restore requires a new directory outside the source installation');
  readInstallation(root); assertDirectoryPath(source.state); assertDirectoryPath(target.root);
  const info = await fs.lstat(join(source.state, 'control.db'));
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Current deletion records are unavailable');
  const unlock = acquireProcessLock(join(source.runtime, 'sockets', 'service-lock.db'));
  let runtime: Runtime | undefined; let created = false;
  try {
    await fs.mkdir(target.root, { mode: 0o700 }); created = true;
    initializeProduct(target.root); runtime = new Runtime(source.state);
    const manifest = await prepareRestore(join(source.backups, id), join(target.runtime, 'restored-state'), runtime.deletionRecords(runtime.administrator()));
    initializeInstallation(target.root, manifest.installation);
    await fs.rmdir(target.state);
    await fs.rename(join(target.runtime, 'restored-state'), target.state);
    return target;
  } catch (error) {
    if (created) { assertDirectoryPath(target.root); await fs.rm(target.root, { recursive: true }); }
    throw error;
  } finally { runtime?.close(); unlock(); }
}
