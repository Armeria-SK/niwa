import { mkdirSync, lstatSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const directories = ['config', 'state', 'secrets', 'workspace', 'runtime', 'backups'] as const;
export type ProductPaths = { root: string } & Record<typeof directories[number], string>;

/** Explicit installation root, never inferred from cwd or the source checkout. */
export function productPaths(root: string): ProductPaths {
  if (!isAbsolute(root)) throw new Error('Niwa requires an absolute product root');
  const absolute = resolve(root);
  if (dirname(absolute) === absolute) throw new Error('The filesystem root is not a product directory');
  return { root: absolute, ...Object.fromEntries(directories.map(name => [name, join(absolute, name)])) } as ProductPaths;
}

/** Local directory scaffold only; Linux service ownership is configured by deployment tooling. */
export function initializeProduct(root: string): ProductPaths {
  const paths = productPaths(root);
  for (const path of Object.values(paths)) assertDirectoryPath(path);
  for (const path of Object.values(paths)) mkdirSync(path, { recursive: true, mode: 0o700 });
  return paths;
}

export function assertDirectoryPath(path: string): void {
  for (let current = path; ; current = dirname(current)) {
    try {
      const info = lstatSync(current);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Product paths must be real directories');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (dirname(current) === current) break;
  }
}
