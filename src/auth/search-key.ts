import { constants, closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { assertDirectoryPath } from '../config/paths.ts';

/** Optional, explicit product-secret file. Never discover credentials from other apps or environment. */
export function readSearchKey(secrets: string): string | undefined {
  assertDirectoryPath(secrets);
  let descriptor: number;
  try {
    const file = join(secrets, 'brave-search-key');
    if (lstatSync(file).isSymbolicLink()) throw new Error('Unsafe search credential');
    descriptor = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw new Error('Search credential could not be read'); }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 514 || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) throw new Error('Unsafe search credential');
    const bytes = Buffer.alloc(515); const length = readSync(descriptor, bytes, 0, bytes.length, 0);
    const key = bytes.subarray(0, length).toString('utf8').trim();
    if (length > 514 || !/^[\x21-\x7e]{1,512}$/.test(key)) throw new Error('Invalid search credential');
    return key;
  } finally { closeSync(descriptor); }
}
