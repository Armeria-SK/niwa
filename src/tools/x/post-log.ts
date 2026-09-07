import { createHash } from 'node:crypto';
import { isAbsolute, dirname } from 'node:path';
import { lstatSync } from 'node:fs';
import { openDatabase, transaction } from '../../storage/database.ts';
import { assertDirectoryPath } from '../../config/paths.ts';
import { validateXPost, type XPost, type XPostResult } from './api.ts';

export interface XPostOperation { operation_id: string; agent_id: string; room_id: string; task_id: string; post: XPost; allow_start: boolean }
type Sender = (post: XPost, signal?: AbortSignal) => Promise<XPostResult>;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Single shared account queue; only hashes and confirmed IDs are journaled, never credentials or post bodies. */
export class XPostLog {
  #db; #tail: Promise<unknown> = Promise.resolve(); #closed = false;
  constructor(file: string, private accountId: string, private send: Sender) {
    if (!isAbsolute(file) || !/^[0-9]{1,19}$/.test(accountId)) throw new Error('Invalid X journal configuration');
    assertDirectoryPath(dirname(file));
    try { const info = lstatSync(file); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('Unsafe X journal'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    this.#db = openDatabase(file, 'CREATE TABLE x_posts (operation_id TEXT PRIMARY KEY,input_hash TEXT NOT NULL,content_hash TEXT NOT NULL,output TEXT,created_at INTEGER NOT NULL) STRICT; CREATE INDEX x_post_content ON x_posts(content_hash);');
    this.#db.exec('PRAGMA synchronous=FULL;');
  }
  execute(input: XPostOperation, signal?: AbortSignal): Promise<XPostResult> {
    if (this.#closed || !input || typeof input.allow_start !== 'boolean' ||
      ![input.operation_id, input.agent_id, input.room_id, input.task_id].every(value => typeof value === 'string' && /^[A-Za-z0-9:_-]{1,160}$/.test(value)))
      return Promise.reject(new Error('Invalid X post operation'));
    validateXPost(input.post); const request = { ...input, post: { text: input.post.text, ...(input.post.reply_to === undefined ? {} : { reply_to: input.post.reply_to }) } };
    const pending = this.#tail.then(() => this.#execute(request, signal)); this.#tail = pending.catch(() => {}); return pending;
  }
  async #execute(input: XPostOperation, signal?: AbortSignal): Promise<XPostResult> {
    const saved = transaction(this.#db, (): XPostResult | undefined => {
    const inputHash = hash([this.accountId, input.agent_id, input.room_id, input.task_id, input.post]);
    const prior = this.#db.prepare('SELECT input_hash,output FROM x_posts WHERE operation_id=?').get(input.operation_id);
    if (prior) {
      if (prior.input_hash !== inputHash) throw new Error('X operation changed');
      return prior.output === null ? { error: 'outcome_unknown' } : JSON.parse(String(prior.output)) as XPostResult;
    }
    if (!input.allow_start) return { error: 'outcome_unknown' };
    if (signal?.aborted) return { error: 'cancelled' };
    const contentHash = hash([this.accountId, input.post]);
    const duplicate = this.#db.prepare("SELECT output FROM x_posts WHERE content_hash=? AND (output IS NULL OR json_extract(output,'$.id') IS NOT NULL) ORDER BY created_at LIMIT 1").get(contentHash);
    const encoded = duplicate?.output ?? null;
    this.#db.prepare('INSERT INTO x_posts VALUES (?,?,?,?,?)').run(input.operation_id, inputHash, contentHash, encoded, Date.now());
    if (duplicate) return encoded === null ? { error: 'outcome_unknown' } : JSON.parse(String(encoded)) as XPostResult;
    return undefined;
    });
    if (saved) return saved;
    let result: XPostResult;
    try { result = await this.send(input.post, signal); } catch { result = { error: 'outcome_unknown' }; }
    if (!('error' in result) && (!/^[0-9]{1,19}$/.test(result.id) || result.url !== `https://x.com/i/web/status/${result.id}`)) result = { error: 'outcome_unknown' };
    if (!('error' in result) || result.error !== 'outcome_unknown') this.#db.prepare('UPDATE x_posts SET output=? WHERE operation_id=?').run(JSON.stringify(result), input.operation_id);
    return result;
  }
  async close() { if (this.#closed) return; this.#closed = true; await this.#tail; this.#db.close(); }
}
