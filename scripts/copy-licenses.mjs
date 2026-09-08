import { copyFileSync } from 'node:fs';
for (const directory of ['dist', 'dist/client']) {
  for (const file of ['LICENSE', 'NOTICE']) {
    copyFileSync(file, `${directory}/${file}`);
  }
}
