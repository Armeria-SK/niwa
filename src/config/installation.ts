import { constants, closeSync, fsyncSync, lstatSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { initializeProduct, productPaths, type ProductPaths } from './paths.ts';
import { WebAuth } from '../web/auth.ts';

const schema = Type.Object({ version: Type.Literal(1), origin: Type.String({ maxLength: 2048 }),
  port: Type.Integer({ minimum: 1, maximum: 65535 }), workspaceExecutorUid: Type.Optional(Type.Integer({ minimum: 1 })),
  programExecutorUid: Type.Optional(Type.Integer({ minimum: 1 })) }, { additionalProperties: false });
export type Installation = Static<typeof schema>;
function validate(value: unknown): Installation {
  if (!Value.Check(schema, value)) throw new Error('Invalid config/niwa.json');
  const config = value as Installation;
  new WebAuth(config.origin, 'a'.repeat(43)); // Same origin rules as the HTTP service.
  return config;
}
export function initializeInstallation(root: string, config: Installation): ProductPaths {
  validate(config);
  const paths = initializeProduct(root);
  writeFileSync(join(paths.config, 'niwa.json'), JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return paths;
}
export function readInstallation(root: string): Installation {
  const file = join(productPaths(root).config, 'niwa.json');
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) throw new Error('Invalid config/niwa.json');
  return validate(JSON.parse(readFileSync(file, 'utf8')) as unknown);
}
/** Invoke under the product process lock. No key is sent to logs or model context. */
export function adminKey(paths: ProductPaths): string {
  const file = join(paths.secrets, 'admin-key');
  try {
    const descriptor = openSync(file, 'wx', 0o600);
    try { writeFileSync(descriptor, randomBytes(32).toString('base64url')); fsyncSync(descriptor); }
    finally { closeSync(descriptor); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== 43
    || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) throw new Error('Unsafe admin key file');
  const descriptor = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const key = readFileSync(descriptor, 'utf8');
    if (!/^[A-Za-z0-9_-]{43}$/.test(key)) throw new Error('Invalid admin key file');
    return key;
  } finally { closeSync(descriptor); }
}
