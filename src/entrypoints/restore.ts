import { parseArgs } from 'node:util';
import { restoreInstallation } from '../backup/restore.ts';
import { readInstallation } from '../config/installation.ts';

try {
  const { values } = parseArgs({ options: { root: { type: 'string' }, backup: { type: 'string' }, to: { type: 'string' }, origin: { type: 'string' }, port: { type: 'string' } } });
  if (!values.root || !values.backup || !values.to) throw new Error('Missing restore arguments');
  if (values.port !== undefined && !/^[0-9]{1,5}$/.test(values.port)) throw new Error('Invalid port');
  const target = await restoreInstallation(values.root, values.backup, values.to, { ...(values.origin !== undefined ? { origin: values.origin } : {}), ...(values.port !== undefined ? { port: Number(values.port) } : {}) });
  const { origin, port } = readInstallation(target.root);
  process.stdout.write(`Restore completed in ${target.root}. Activities are paused. Installation: origin ${origin}, port ${port}.
Next steps:
  1. Stop the source service, or restore with --port/--origin so both can run (the copied origin and port are those of the source).
  2. Start it: npm start -- --root ${target.root}
  3. Sign in with the new administrator key in ${target.root}/secrets/admin-key, then resume activities from the UI.
  4. Reconnect model and X accounts; credentials, workspace files and container images are not part of a backup.
`);
} catch {
  process.stderr.write('Restore failed. Stop the source service and check --root, --backup, --to, --origin, --port, permissions, and backup integrity. The destination must not exist.\n');
  process.exitCode = 1;
}
