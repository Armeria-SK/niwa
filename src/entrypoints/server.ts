import { parseArgs } from 'node:util';
import { initializeInstallation } from '../config/installation.ts';
import { startService } from '../runtime/service.ts';

try {
  const { values } = parseArgs({ options: { root: { type: 'string' }, init: { type: 'boolean' }, origin: { type: 'string' }, port: { type: 'string' } } });
  if (!values.root) throw new Error('Specify --root with the absolute product root.');
  if (values.init) {
    if (!values.origin) throw new Error('Initialization requires --origin (the browser-facing origin).');
    initializeInstallation(values.root, { version: 1, origin: values.origin, port: Number(values.port ?? 3210) });
    process.stdout.write('Installation configuration created. Start without --init.\n');
  } else {
    if (values.origin || values.port) throw new Error('Edit config/niwa.json to change the installed origin or port.');
    const service = await startService(values.root);
    process.stdout.write('Niwa is running. The administrator login key is in secrets/admin-key under the product root.\n');
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void service.close(); });
  }
} catch {
  process.stderr.write('Niwa could not start. Check --root, config/niwa.json, file permissions, and whether another instance is running.\n');
  process.exitCode = 1;
}
