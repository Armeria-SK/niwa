import { constants, closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { assertDirectoryPath } from '../config/paths.ts';
import type { XClient } from './x-oauth.ts';

/** Explicit administrator-provided client configuration, separate from OAuth tokens. */
export function readXClient(secrets: string): XClient | undefined {
  assertDirectoryPath(secrets); let descriptor: number;
  try {
    const file = join(secrets, 'x-client.json'); if (lstatSync(file).isSymbolicLink()) throw new Error('Unsafe X client');
    descriptor = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw new Error('X client configuration unavailable'); }
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.nlink !== 1 || info.size > 8192 || (process.platform !== 'win32' && (info.mode & 0o077))) throw new Error('Unsafe X client');
    const bytes = Buffer.alloc(8193); const size = readSync(descriptor, bytes, 0, bytes.length, 0);
    if (size > 8192) throw new Error('X client configuration too large');
    const value = JSON.parse(bytes.subarray(0, size).toString('utf8')) as XClient;
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.client_id !== 'string' ||
      !/^[\x21-\x7e]{1,512}$/.test(value.client_id) || (value.client_secret !== undefined &&
      (typeof value.client_secret !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(value.client_secret))) ||
      Object.keys(value).some(key => !['client_id', 'client_secret'].includes(key))) throw new Error('Invalid X client configuration');
    return value;
  } catch { throw new Error('X client configuration is invalid'); }
  finally { closeSync(descriptor); }
}
