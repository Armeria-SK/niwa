import { createHash, randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { assertDirectoryPath } from '../config/paths.ts';
import { openDatabase } from '../storage/database.ts';
import type { ProgramOutput, ProgramRequest } from './program.ts';

export interface ProgramOperation extends ProgramRequest { operation_id: string; agent_id: string; room_id: string; task_id: string }
export type ProgramResult = ProgramOutput | { error: 'outcome_unknown' };
type Runner = (request: ProgramRequest, signal?: AbortSignal, name?: string) => Promise<ProgramOutput>;
interface Receipt { input_hash: string; container: string; output: string | null }
const identifier = /^[A-Za-z0-9:_-]{1,160}$/;

/** Lives in executor-private state. Intent is durable before execution; ambiguous attempts are never replayed. */
export class ProgramLog {
  #db: DatabaseSync;
  constructor(file: string, private environmentKey: string, private run: Runner) {
    if (!isAbsolute(file) || !environmentKey) throw new Error('Explicit program state and environment required');
    assertDirectoryPath(dirname(file));
    try { const info = lstatSync(file); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('Unsafe program state'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    this.#db = openDatabase(file, 'CREATE TABLE programs (operation_id TEXT PRIMARY KEY,input_hash TEXT NOT NULL,container TEXT NOT NULL UNIQUE,output TEXT,created_at INTEGER NOT NULL) STRICT;');
    this.#db.exec('PRAGMA synchronous=FULL;');
  }
  close(): void { this.#db.close(); }
  pending(): { operation_id: string; container: string }[] {
    return this.#db.prepare('SELECT operation_id,container FROM programs WHERE output IS NULL ORDER BY created_at').all()
      .map(row => ({ operation_id: row.operation_id as string, container: row.container as string }));
  }
  async execute(input: ProgramOperation, signal?: AbortSignal): Promise<ProgramResult> {
    if (![input.operation_id, input.agent_id, input.room_id, input.task_id].every(value => typeof value === 'string' && identifier.test(value)) ||
        !Number.isInteger(input.seconds) || input.seconds < 1 || input.seconds > 300 || !Array.isArray(input.command) ||
        !input.command.length || input.command.length > 128 || input.command.some(value => typeof value !== 'string' || value.includes('\0')) ||
        !input.command[0] || Buffer.byteLength(JSON.stringify(input.command)) > 65536) throw new Error('Invalid program operation');
    // Snapshot before awaiting: a caller must not mutate the command after its hash was committed.
    const request = { command: [...input.command], seconds: input.seconds };
    const id = input.operation_id;
    const inputHash = createHash('sha256').update(JSON.stringify([this.environmentKey, input.agent_id, input.room_id, input.task_id, request])).digest('hex');
    signal?.throwIfAborted();
    const container = `niwa-program-${randomUUID()}`;
    const inserted = this.#db.prepare('INSERT INTO programs VALUES (?,?,?,NULL,?) ON CONFLICT(operation_id) DO NOTHING').run(id, inputHash, container, Date.now());
    if (!inserted.changes) {
      const prior = this.#db.prepare('SELECT input_hash,container,output FROM programs WHERE operation_id=?').get(id) as unknown as Receipt;
      if (prior.input_hash !== inputHash) throw new Error('Program operation conflicts with saved request');
      return prior.output === null ? { error: 'outcome_unknown' } : JSON.parse(prior.output) as ProgramOutput;
    }
    try {
      const output = await this.run(request, signal, container);
      if (!Number.isInteger(output.code) || typeof output.stdout !== 'string' || typeof output.stderr !== 'string' ||
          Buffer.byteLength(output.stdout) > 65536 || Buffer.byteLength(output.stderr) > 65536) throw new Error('Invalid program output');
      this.#db.prepare('UPDATE programs SET output=? WHERE operation_id=?').run(JSON.stringify(output), id);
      return output;
    } catch { return { error: 'outcome_unknown' }; }
  }
}
