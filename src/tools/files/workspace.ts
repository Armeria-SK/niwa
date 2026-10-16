import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, opendirSync, readSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { assertDirectoryPath } from '../../config/paths.ts';

const MAX_BYTES = 64 * 1024;
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export type RejectionRule = 'too_many_entries' | 'cross_device' | 'symlink' | 'not_regular_file' | 'hardlink' | 'file_too_large' | 'total_too_large' | 'changed_during_read';
export interface RejectionDetail { rule: RejectionRule; path: string; output?: { code: number; stdout: string; stderr: string } }
export class WorkspaceError extends Error {
  constructor(readonly code: 'invalid_path' | 'not_found' | 'conflict' | 'unsupported' | 'output_rejected', readonly detail?: RejectionDetail) { super(code); }
}
const advice: Record<RejectionRule, string> = {
  too_many_entries: 'ファイルとフォルダの合計は1000個までです。不要なものを削除してください',
  cross_device: '別のマウントにまたがるエントリは戻せません',
  symlink: 'シンボリックリンクは戻せません。削除するか実体にしてください(例: npm install --no-bin-links、python -m venv --copies)',
  not_regular_file: '通常ファイルとフォルダ以外(FIFOやソケット等)は戻せません。削除してください',
  hardlink: 'ハードリンクされたファイルは戻せません。コピーして実体にしてください',
  file_too_large: '1ファイルは8MiBまでです。小さくするか削除してください',
  total_too_large: '合計は64MiBまでです。不要なファイルや依存物を削除してください',
  changed_during_read: '読取り中にファイルが変化しました。実行後に何も残さないようにしてください',
};
/** Untrusted programs choose names, so the offending path is made printable and bounded. */
export const outputRejection = (rule: RejectionRule, path: string, output?: RejectionDetail['output']) =>
  new WorkspaceError('output_rejected', { rule, path: path.replace(/[\x00-\x1f\x7f]/g, '?').slice(0, 200), ...(output ? { output } : {}) });
export const rejectionMessage = (rule: RejectionRule) => `実行は終了しましたが、出力が作業場の安全規則に違反したため結果を反映しませんでした(ルール ${rule})。${advice[rule]}`;

/** Trusted file broker only. Run under the isolated niwa-exec identity, never inside the application service. */
/**
 * lstat checks on parents are racy: containers write this tree as the same user and may swap a directory for a symlink between check and use.
 * Every opened descriptor is therefore resolved through /proc and must be exactly the expected path inside the real root; otherwise fail closed.
 */
export function assertOpenedAt(descriptor: number, expected: string): void {
  if (process.platform !== 'linux') return;
  let actual: string;
  try { actual = realpathSync(`/proc/self/fd/${descriptor}`); } catch { throw new WorkspaceError('invalid_path'); }
  if (actual !== expected) throw new WorkspaceError('invalid_path');
}
const flags = constants.O_NOFOLLOW ?? 0;
export class Workspace {
  #root: string; #real: string;
  /** `afterCheck` exists only so tests can swap a directory inside the check-to-use window. */
  constructor(root: string, private afterCheck?: () => void) {
    if (!isAbsolute(root) || dirname(resolve(root)) === resolve(root)) throw new WorkspaceError('invalid_path');
    assertDirectoryPath(root); this.#root = resolve(root); this.#real = realpathSync(root);
  }
  #expected(path: string) { return join(this.#real, relative(this.#root, path)); }
  /** Opens a directory without following the last component and proves it is the intended directory. Linux paths through the descriptor cannot be redirected afterwards. */
  #directory(path: string): number {
    this.afterCheck?.();
    let descriptor: number;
    try { descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | flags); }
    catch (error) { if (['ELOOP', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw new WorkspaceError('invalid_path'); throw error; }
    try { assertOpenedAt(descriptor, this.#expected(path)); return descriptor; } catch (error) { closeSync(descriptor); throw error; }
  }
  #at(directory: number, parent: string, leaf: string) { return process.platform === 'linux' ? `/proc/self/fd/${directory}/${leaf}` : join(parent, leaf); }
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
  #bytes(path: string, limit = MAX_BYTES, canonical = path): Buffer {
    this.afterCheck?.();
    const entry = lstatSync(path);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) throw new WorkspaceError('invalid_path');
    const descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | flags);
    try {
      assertOpenedAt(descriptor, this.#expected(canonical));
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
    const parent = this.#path(name, true), anchor = this.#directory(parent);
    let directory: ReturnType<typeof opendirSync>;
    try { directory = opendirSync(this.#at(anchor, parent, '.')); } finally { closeSync(anchor); }
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
  write(name: string, content: string, expected: string | null, encoding: 'utf8' | 'base64' = 'utf8') {
    if (typeof content !== 'string' || !['utf8','base64'].includes(encoding) || (encoding === 'utf8' && (content.includes('\0') || Buffer.byteLength(content) > MAX_BYTES)) ||
      (expected !== null && !/^[a-f0-9]{64}$/.test(expected))) throw new WorkspaceError('unsupported');
    const path = this.#path(name, false, true);
    const bytes = Buffer.from(content, encoding);
    if (bytes.length > 8 * 1024 * 1024 || (encoding === 'base64' && bytes.toString('base64') !== content)) throw new WorkspaceError('unsupported');
    const revision = digest(bytes);
    let current: string | null = null;
    const parent = dirname(path), leaf = basename(path), anchor = this.#directory(parent), at = (name: string) => this.#at(anchor, parent, name);
    const temporary = `.niwa-write-${randomUUID()}`;
    try {
      try { current = digest(this.#bytes(at(leaf), 8 * 1024 * 1024, path)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      // A lost response after atomic replacement is safe to replay only while the desired content remains current.
      if (current === revision) return { path: name, revision, shared: true as const };
      if (current !== expected) throw new WorkspaceError('conflict');
      // The temporary file and the rename both go through the verified directory, so a later swap of any parent cannot redirect them.
      const descriptor = openSync(at(temporary), 'wx', 0o660);
      try { writeFileSync(descriptor, bytes); fsyncSync(descriptor); } finally { closeSync(descriptor); }
      assertOpenedAt(anchor, this.#expected(parent));
      renameSync(at(temporary), at(leaf));
      if (process.platform === 'linux') fsyncSync(anchor);
      return { path: name, revision, shared: true as const };
    } finally { try { rmSync(at(temporary), { force: true }); } finally { closeSync(anchor); } }
  }
}
