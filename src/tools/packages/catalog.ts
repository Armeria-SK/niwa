import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { assertDirectoryPath } from '../../config/paths.ts';

export interface ApprovedPackage { name: string; version: string; file: string; sha256: string }
const packageName = /^[a-z0-9][a-z0-9+.-]{1,127}$/;

/** Executor-private catalog: package paths and bytes are never supplied by a Bot. */
export class PackageCatalog {
  #entries: ApprovedPackage[];
  readonly revision: string;
  constructor(private directory: string) {
    if (!isAbsolute(directory)) throw new Error('Absolute package catalog required');
    assertDirectoryPath(directory);
    const info = lstatSync(directory);
    if (process.platform === 'linux' && (info.uid !== process.getuid?.() || (info.mode & 0o077))) throw new Error('Private package catalog required');
    const bytes = this.read('catalog.json', 65536);
    const entries: unknown = JSON.parse(bytes.toString('utf8'));
    if (!Array.isArray(entries) || entries.length > 256 || entries.some(entry => !entry || typeof entry !== 'object' ||
      Object.keys(entry).sort().join(',') !== 'file,name,sha256,version' || typeof entry.name !== 'string' || !packageName.test(entry.name) ||
      typeof entry.version !== 'string' || !/^[A-Za-z0-9.+:~_-]{1,128}$/.test(entry.version) ||
      typeof entry.file !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,180}\.deb$/.test(entry.file) ||
      typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)) ||
      new Set(entries.map(entry => entry.name)).size !== entries.length) throw new Error('Invalid package catalog');
    this.#entries = entries as ApprovedPackage[];
    this.revision = createHash('sha256').update(bytes).digest('hex');
  }
  list(): { name: string; version: string }[] { return this.#entries.map(({ name, version }) => ({ name, version })); }
  select(names: string[]): ApprovedPackage[] {
    if (!Array.isArray(names) || !names.length || names.length > 64 || new Set(names).size !== names.length ||
      names.some(name => typeof name !== 'string' || !packageName.test(name))) throw new Error('Invalid package selection');
    return [...names].sort().map(name => {
      const entry = this.#entries.find(item => item.name === name);
      if (!entry) throw new Error('Package is not approved');
      return { ...entry };
    });
  }
  stage(names: string[], destination: string): ApprovedPackage[] {
    const entries = this.select(names);
    assertDirectoryPath(destination);
    // Exclusive creation prevents accidentally reusing a previous attempt's inputs.
    mkdirSync(destination, { mode: 0o700 });
    for (const [index, entry] of entries.entries()) {
      const bytes = this.read(entry.file, 128 * 1024 * 1024);
      if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error('Package digest mismatch');
      writeFileSync(join(destination, `${index}.deb`), bytes, { flag: 'wx', mode: 0o444 });
    }
    return entries;
  }
  private read(file: string, limit: number): Buffer {
    assertDirectoryPath(this.directory);
    const path = join(this.directory, file); const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new Error('Unsafe package file');
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.nlink !== 1 || info.size > limit || info.ino !== before.ino || info.dev !== before.dev ||
        (process.platform === 'linux' && (info.uid !== process.getuid?.() || (info.mode & 0o022)))) throw new Error('Unsafe package file');
      const bytes = readFileSync(fd);
      if (bytes.length > limit) throw new Error('Package file too large');
      return bytes;
    } finally { closeSync(fd); }
  }
}
