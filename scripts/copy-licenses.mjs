import { copyFileSync } from 'node:fs';
for (const directory of ['dist', 'dist/client']) {
  for (const file of ['LICENSE', 'LICENSES.md']) {
    copyFileSync(file, `${directory}/${file}`);
  }
}
