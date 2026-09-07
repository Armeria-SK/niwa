import { parseArgs } from 'node:util';
import { restoreInstallation } from '../backup/restore.ts';

try {
  const { values } = parseArgs({ options: { root: { type: 'string' }, backup: { type: 'string' }, to: { type: 'string' } } });
  if (!values.root || !values.backup || !values.to) throw new Error('Missing restore arguments');
  await restoreInstallation(values.root, values.backup, values.to);
  process.stdout.write('Restore completed in the new product root. Activities are paused; sign in with its new administrator key after starting it.\n');
} catch {
  process.stderr.write('Restore failed. Stop the source service and check --root, --backup, --to, permissions, and backup integrity. The destination must not exist.\n');
  process.exitCode = 1;
}
