import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { assertDirectoryPath } from '../../config/paths.ts';
import { openDatabase } from '../../storage/database.ts';
import { WorkspaceError, type Workspace } from './workspace.ts';

interface Receipt { input_hash: string; output: string | null }
export interface WorkspaceWrite { operation_id: string; path: string; content: string; expected_revision: string | null; encoding?: 'utf8' | 'base64' }
export type WriteResult = { path: string; revision: string; shared: true } | { error: string };
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

/** Executor-owned receipts, outside the shared mount. Pending operations are reconciled, never blindly repeated. */
export class WorkspaceWriteLog {
  #db: DatabaseSync;
  #files: Pick<Workspace, 'write' | 'read' | 'download'>;
  constructor(file: string, files: Pick<Workspace, 'write' | 'read' | 'download'>) {
    if (!isAbsolute(file)) throw new Error('Absolute execution state path required');
    assertDirectoryPath(dirname(file));
    try {
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Unsafe execution state');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    this.#files = files;
    this.#db = openDatabase(file, `CREATE TABLE workspace_writes (
      operation_id TEXT PRIMARY KEY, input_hash TEXT NOT NULL, output TEXT, created_at INTEGER NOT NULL
    ) STRICT;`);
    this.#db.exec('PRAGMA synchronous = FULL;');
  }
  close(): void { this.#db.close(); }
  write(input: WorkspaceWrite): WriteResult {
    if (!/^[A-Za-z0-9:_-]{1,160}$/.test(input.operation_id) || typeof input.path !== 'string' || input.path.length > 512 ||
      typeof input.content !== 'string' || Buffer.byteLength(input.content) > (input.encoding === 'base64' ? 11_184_812 : 65536) ||
      (input.encoding !== undefined && !['utf8','base64'].includes(input.encoding)) ||
      (input.expected_revision !== null && !/^[a-f0-9]{64}$/.test(input.expected_revision))) throw new WorkspaceError('unsupported');
    const bytes = Buffer.from(input.content, input.encoding ?? 'utf8');
    if (bytes.length > 8 * 1024 * 1024 || (input.encoding === 'base64' && bytes.toString('base64') !== input.content)) throw new WorkspaceError('unsupported');
    const inputHash = hash(JSON.stringify([input.path, input.content, input.expected_revision, ...(input.encoding === 'base64' ? ['base64'] : [])]));
    const prior = this.#db.prepare('SELECT input_hash,output FROM workspace_writes WHERE operation_id=?').get(input.operation_id) as Receipt | undefined;
    if (prior) {
      if (prior.input_hash !== inputHash) throw new WorkspaceError('conflict');
      if (prior.output !== null) return JSON.parse(prior.output) as WriteResult;
      try {
        if ((input.encoding === 'base64' ? this.#files.download(input.path) : this.#files.read(input.path)).revision === hash(bytes)) {
          return this.#finish(input.operation_id, { path: input.path, revision: hash(bytes), shared: true });
        }
      } catch { /* Missing or changed files cannot prove whether the interrupted write happened. */ }
      return { error: 'outcome_unknown' };
    }
    // Commit intent before touching files. No private content or file path is duplicated in the receipt.
    this.#db.prepare('INSERT INTO workspace_writes VALUES (?,?,NULL,?)').run(input.operation_id, inputHash, Date.now());
    let result: WriteResult;
    try { result = this.#files.write(input.path, input.content, input.expected_revision, input.encoding); }
    catch (error) {
      if (!(error instanceof WorkspaceError)) return { error: 'outcome_unknown' };
      result = { error: error.code };
    }
    return this.#finish(input.operation_id, result);
  }
  #finish(id: string, result: WriteResult): WriteResult {
    this.#db.prepare('UPDATE workspace_writes SET output=? WHERE operation_id=?').run(JSON.stringify(result), id);
    return result;
  }
}
