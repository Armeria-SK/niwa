// OAuth types, memory store and validation adapted from Carried
// c695f855419ffc69d1e62b04f1de8de36c7c162d, core/auth/src/credential-store.ts (Apache-2.0).
// Niwa replaces automatic device-store discovery with an explicit server-owned file.
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface OAuthCredential {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly expires_at: number;
  readonly account_id?: string;
  readonly token_type?: string;
}
export interface CredentialStore {
  read(): Promise<OAuthCredential | undefined>;
  write(credential: OAuthCredential): Promise<void>;
  clear(): Promise<void>;
}
export class CredentialStoreUnavailableError extends Error {
  override readonly name = 'CredentialStoreUnavailableError';
}
function safeString(value: unknown, max = 64 * 1024): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/u.test(value);
}
export function validateCredential(value: unknown): asserts value is OAuthCredential {
  const credential = value as OAuthCredential | undefined;
  if (!credential || typeof credential !== 'object' || Array.isArray(credential)
    || !safeString(credential.access_token) || !safeString(credential.refresh_token)
    || !Number.isSafeInteger(credential.expires_at) || credential.expires_at < 0
    || (credential.account_id !== undefined && !safeString(credential.account_id, 256))
    || (credential.token_type !== undefined && !safeString(credential.token_type, 64))) {
    throw new CredentialStoreUnavailableError('The OAuth credential is invalid.');
  }
}
function copyCredential(value: OAuthCredential): OAuthCredential {
  validateCredential(value);
  return {
    access_token: value.access_token, refresh_token: value.refresh_token, expires_at: value.expires_at,
    ...(value.account_id === undefined ? {} : { account_id: value.account_id }),
    ...(value.token_type === undefined ? {} : { token_type: value.token_type }),
  };
}
export class MemoryCredentialStore implements CredentialStore {
  #credential: OAuthCredential | undefined;
  async read(): Promise<OAuthCredential | undefined> {
    return this.#credential === undefined ? undefined : copyCredential(this.#credential);
  }
  async write(value: OAuthCredential): Promise<void> { this.#credential = copyCredential(value); }
  async clear(): Promise<void> { this.#credential = undefined; }
}

const MAX_CREDENTIAL_BYTES = 256 * 1024;
/** Only the trusted composition root supplies this path. No environment/keychain fallback. */
export class FileCredentialStore implements CredentialStore {
  readonly #path: string;
  #writes: Promise<void> = Promise.resolve();
  constructor(filePath: string) {
    if (!isAbsolute(filePath)) throw new CredentialStoreUnavailableError('An absolute credential path is required.');
    this.#path = resolve(filePath);
  }
  async read(): Promise<OAuthCredential | undefined> {
    await this.#writes;
    return this.#read();
  }
  async #read(): Promise<OAuthCredential | undefined> {
    try {
      await assertNoLinks(this.#path);
      const handle = await open(this.#path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_CREDENTIAL_BYTES) throw new Error('unsafe file');
        if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) throw new Error('unsafe permissions');
        const buffer = Buffer.alloc(MAX_CREDENTIAL_BYTES + 1);
        let length = 0;
        while (length < buffer.length) {
          const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
          if (bytesRead === 0) break;
          length += bytesRead;
        }
        if (length > MAX_CREDENTIAL_BYTES) throw new Error('oversized file');
        const parsed: unknown = JSON.parse(buffer.subarray(0, length).toString('utf8'));
        validateCredential(parsed);
        return copyCredential(parsed);
      } finally { await handle.close(); }
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw new CredentialStoreUnavailableError('The credential file could not be read safely.');
    }
  }
  write(value: OAuthCredential): Promise<void> {
    const credential = copyCredential(value);
    return this.#exclusive(async () => {
      const temporary = `${this.#path}.${randomUUID()}.tmp`;
      try {
        await assertNoLinks(this.#path);
        await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
        await assertNoLinks(this.#path);
        if (process.platform !== 'win32') await chmod(dirname(this.#path), 0o700);
        const handle = await open(temporary, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify(credential)); await handle.sync(); }
        finally { await handle.close(); }
        await rename(temporary, this.#path);
        const saved = await this.#read();
        if (JSON.stringify(saved) !== JSON.stringify(credential)) throw new Error('verification failed');
      } catch {
        throw new CredentialStoreUnavailableError('The credential file could not be saved safely.');
      } finally { await rm(temporary, { force: true }).catch(() => undefined); }
    });
  }
  clear(): Promise<void> {
    return this.#exclusive(async () => {
      try { await assertNoLinks(this.#path); await rm(this.#path, { force: true }); }
      catch { throw new CredentialStoreUnavailableError('The credential file could not be cleared safely.'); }
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
    catch (error) { if (!isMissing(error)) throw error; }
    if (dirname(current) === current) return;
  }
}
function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
