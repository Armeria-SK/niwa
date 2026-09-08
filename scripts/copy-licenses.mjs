import { copyFileSync } from 'node:fs';
for (const target of ['dist/LICENSES.md', 'dist/client/LICENSES.md']) {
  copyFileSync('LICENSES.md', target);
}
