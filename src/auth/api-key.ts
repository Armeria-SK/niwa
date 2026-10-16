import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CredentialStoreUnavailableError } from './credential-store.ts';

/** An API key and the origin it was entered for. A key is never sent to a different origin. */
export interface ApiKeyRecord { readonly origin: string; readonly key: string }
export interface ApiKeyStore {
  /** Changes on every save or removal so discovery can detect a concurrent change. */
  readonly revision: number;
  read(): Promise<ApiKeyRecord | undefined>;
  write(record: ApiKeyRecord): Promise<void>;
  clear(): Promise<void>;
}
export function validApiKey(value: unknown): value is string {
  return typeof value === 'string' && /^[\x21-\x7e]{1,512}$/u.test(value);
}
function validRecord(value: unknown): value is ApiKeyRecord {
  const record = value as ApiKeyRecord | undefined;
  return !!record && typeof record === 'object' && !Array.isArray(record) && Object.keys(record).length === 2
    && validApiKey(record.key) && typeof record.origin === 'string' && record.origin.length <= 512 && /^https?:\/\/[^/?#\s]+$/u.test(record.origin);
}
export class MemoryApiKeyStore implements ApiKeyStore {
  #record: ApiKeyRecord | undefined; revision = 0;
  async read() { return this.#record && { ...this.#record }; }
  async write(record: ApiKeyRecord) {
    if (!validRecord(record)) throw new CredentialStoreUnavailableError('The API key is invalid.');
    this.#record = { origin: record.origin, key: record.key }; this.revision++;
  }
  async clear() { this.#record = undefined; this.revision++; }
}

const MAX_BYTES = 2048;
/** 0600 file in the product secrets directory. Only the composition root chooses the path. */
export class FileApiKeyStore implements ApiKeyStore {
  readonly #path: string;
  #writes: Promise<void> = Promise.resolve();
  revision = 0;
  constructor(filePath: string) {
    if (!isAbsolute(filePath)) throw new CredentialStoreUnavailableError('An absolute credential path is required.');
    this.#path = resolve(filePath);
  }
  async read(): Promise<ApiKeyRecord | undefined> { await this.#writes; return this.#read(); }
  async #read(): Promise<ApiKeyRecord | undefined> {
    try {
      await assertNoLinks(this.#path);
      const handle = await open(this.#path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES) throw new Error('unsafe file');
        if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) throw new Error('unsafe permissions');
        const buffer = Buffer.alloc(MAX_BYTES + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > MAX_BYTES) throw new Error('oversized file');
        const parsed: unknown = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
        if (!validRecord(parsed)) throw new Error('invalid');
        return { origin: parsed.origin, key: parsed.key };
      } finally { await handle.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;
      throw new CredentialStoreUnavailableError('The API key file could not be read safely.');
    }
  }
  write(record: ApiKeyRecord): Promise<void> {
    if (!validRecord(record)) return Promise.reject(new CredentialStoreUnavailableError('The API key is invalid.'));
    const value = { origin: record.origin, key: record.key };
    return this.#exclusive(async () => {
      const temporary = `${this.#path}.${randomUUID()}.tmp`;
      try {
        await assertNoLinks(this.#path);
        await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
        if (process.platform !== 'win32') await chmod(dirname(this.#path), 0o700);
        const handle = await open(temporary, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
        finally { await handle.close(); }
        await rename(temporary, this.#path);
        const saved = await this.#read();
        if (saved?.key !== value.key || saved.origin !== value.origin) throw new Error('verification failed');
      } catch {
        throw new CredentialStoreUnavailableError('The API key file could not be saved safely.');
      } finally { this.revision++; await rm(temporary, { force: true }).catch(() => undefined); }
    });
  }
  clear(): Promise<void> {
    return this.#exclusive(async () => {
      try { await assertNoLinks(this.#path); await rm(this.#path, { force: true }); }
      catch { throw new CredentialStoreUnavailableError('The API key file could not be removed safely.'); }
      finally { this.revision++; }
    });
  }
  #exclusive(work: () => Promise<void>): Promise<void> {
    const pending = this.#writes.then(work);
    this.#writes = pending.catch(() => undefined);
    return pending;
  }
}
async function assertNoLinks(path: string): Promise<void> {
  for (let current = path; ; current = dirname(current)) {
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error('symlink'); }
    catch (error) { if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error; }
    if (dirname(current) === current) return;
  }
}
