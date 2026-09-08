import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, opendirSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { assertDirectoryPath } from '../../config/paths.ts';

const MAX_BYTES = 64 * 1024;
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export class WorkspaceError extends Error {
  constructor(readonly code: 'invalid_path' | 'not_found' | 'conflict' | 'unsupported') { super(code); }
}

/** Trusted file broker only. Run under the isolated niwa-exec identity, never inside the application service. */
export class Workspace {
  #root: string;
  constructor(root: string) {
    if (!isAbsolute(root) || dirname(resolve(root)) === resolve(root)) throw new WorkspaceError('invalid_path');
    assertDirectoryPath(root); this.#root = resolve(root);
  }
  #path(name: string, directory = false, createParents = false): string {
    if (typeof name !== 'string' || name.length > 512) throw new WorkspaceError('invalid_path');
    const parts = name === '' && directory ? [] : name.split('/');
    if (parts[0] === 'lost+found' || parts.length > 16 || parts.some(part => !part || part === '.' || part === '..' ||
      /[<>:"\\|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) || /^\.niwa-/i.test(part) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new WorkspaceError('invalid_path');
    assertDirectoryPath(this.#root);
    let target = this.#root;
    for (const [index, part] of parts.entries()) {
      target = join(target, part);
      if (index < parts.length - 1 || directory) {
        if (createParents) { try { mkdirSync(target, { mode: 0o770 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; } }
        const info = lstatSync(target);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new WorkspaceError('invalid_path');
      }
    }
    return target;
  }
  #bytes(path: string, limit = MAX_BYTES): Buffer {
    const entry = lstatSync(path);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) throw new WorkspaceError('invalid_path');
    const descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = fstatSync(descriptor);
      if (!info.isFile() || info.nlink !== 1 || info.ino !== entry.ino || info.dev !== entry.dev) throw new WorkspaceError('invalid_path');
      if (info.size > limit) throw new WorkspaceError('unsupported');
      const buffer = Buffer.alloc(limit + 1); let length = 0;
      while (length < buffer.length) {
        const count = readSync(descriptor, buffer, length, buffer.length - length, null);
        if (!count) break; length += count;
      }
      if (length > limit) throw new WorkspaceError('unsupported');
      return buffer.subarray(0, length);
    } finally { closeSync(descriptor); }
  }
  list(name = '') {
    const directory = opendirSync(this.#path(name, true));
    const entries: { name: string; kind: string }[] = []; let truncated = false; let scanned = 0;
    try {
      for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
        if (entries.length === 200 || ++scanned > 1000) { truncated = true; break; }
        if (!(name === '' && entry.name === 'lost+found') && !/^\.niwa-/i.test(entry.name) && !entry.isSymbolicLink() && (entry.isFile() || entry.isDirectory())) {
          entries.push({ name: entry.name, kind: entry.isDirectory() ? 'directory' : 'file' });
        }
      }
    } finally { directory.closeSync(); }
    return { path: name, entries, truncated };
  }
  download(name: string) {
    const bytes = this.#bytes(this.#path(name), 8 * 1024 * 1024);
    return { path: name, data: bytes.toString('base64'), revision: digest(bytes), shared: true };
  }
  read(name: string) {
    const bytes = this.#bytes(this.#path(name));
    let content: string;
    try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw new WorkspaceError('unsupported'); }
    if (content.includes('\0')) throw new WorkspaceError('unsupported');
    return { path: name, content, revision: digest(bytes), shared: true, untrusted: true };
  }
  write(name: string, content: string, expected: string | null) {
    if (typeof content !== 'string' || content.includes('\0') || Buffer.byteLength(content) > MAX_BYTES ||
      (expected !== null && !/^[a-f0-9]{64}$/.test(expected))) throw new WorkspaceError('unsupported');
    const path = this.#path(name, false, true);
    const bytes = Buffer.from(content); const revision = digest(bytes);
    let current: string | null = null;
    try { current = digest(this.#bytes(path)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    // A lost response after atomic replacement is safe to replay only while the desired content remains current.
    if (current === revision) return { path: name, revision, shared: true as const };
    if (current !== expected) throw new WorkspaceError('conflict');
    const temporary = join(dirname(path), `.niwa-write-${randomUUID()}`);
    try {
      const descriptor = openSync(temporary, 'wx', 0o660);
      try { writeFileSync(descriptor, bytes); fsyncSync(descriptor); } finally { closeSync(descriptor); }
      renameSync(temporary, path);
      if (process.platform === 'linux') {
        const directory = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
        try { fsyncSync(directory); } finally { closeSync(directory); }
      }
      return { path: name, revision, shared: true as const };
    } finally { rmSync(temporary, { force: true }); }
  }
}
