import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { assertDirectoryPath } from '../../config/paths.ts';
import { openDatabase } from '../../storage/database.ts';
import { normalizeForm, type PublicForm, type FormResponse } from './form.ts';

export interface FormOperation { operation_id: string; agent_id: string; room_id: string; task_id: string; allow_start: boolean; form: PublicForm }
export type FormResult = FormResponse | { error: 'outcome_unknown' };

/** Runtime-private journal outside normal backups. An unresolved intent is never automatically sent again. */
export class FormLog {
  #db; #closed = false; #active = new Set<Promise<FormResult>>();
  constructor(file: string, private send: (form: PublicForm, signal?: AbortSignal) => Promise<FormResponse>) {
    if (!isAbsolute(file)) throw new Error('Explicit form journal required'); assertDirectoryPath(dirname(file));
    try { const info = lstatSync(file); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('Unsafe form journal'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    this.#db = openDatabase(file, 'CREATE TABLE forms (operation_id TEXT PRIMARY KEY,input_hash TEXT NOT NULL,output TEXT) STRICT;');
    this.#db.exec('PRAGMA synchronous=FULL;');
  }
  execute(input: FormOperation, signal?: AbortSignal): Promise<FormResult> {
    if (this.#closed || typeof input.allow_start !== 'boolean' ||
      ![input.operation_id, input.agent_id, input.room_id, input.task_id].every(id => typeof id === 'string' && /^[A-Za-z0-9:_-]{1,160}$/.test(id))) throw new Error('Invalid form operation');
    const form = normalizeForm(input.form); const id = input.operation_id;
    const hash = createHash('sha256').update(JSON.stringify([input.agent_id, input.room_id, input.task_id, form])).digest('hex');
    const prior = this.#db.prepare('SELECT input_hash,output FROM forms WHERE operation_id=?').get(id);
    if (prior) {
      if (prior.input_hash !== hash) throw new Error('Form operation changed');
      return Promise.resolve(prior.output === null ? { error: 'outcome_unknown' } : JSON.parse(String(prior.output)) as FormResponse);
    }
    if (!input.allow_start || signal?.aborted) return Promise.resolve({ error: 'outcome_unknown' });
    this.#db.prepare('INSERT INTO forms VALUES (?,?,NULL)').run(id, hash);
    const work = (async (): Promise<FormResult> => {
      try {
        const result = await this.send(form, signal);
        if (!Number.isInteger(result.status) || result.status < 100 || result.status > 599 || result.untrusted !== true ||
          typeof result.url !== 'string' || result.url.length > 4096 || typeof result.text !== 'string' || result.text.length > 20000 || typeof result.truncated !== 'boolean') throw new Error('Invalid form response');
        this.#db.prepare('UPDATE forms SET output=? WHERE operation_id=?').run(JSON.stringify(result), id); return result;
      } catch { return { error: 'outcome_unknown' }; }
    })();
    this.#active.add(work); void work.finally(() => this.#active.delete(work)); return work;
  }
  async close() { if (this.#closed) return; this.#closed = true; await Promise.all(this.#active); this.#db.close(); }
}
