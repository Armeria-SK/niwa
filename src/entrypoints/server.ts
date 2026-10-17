import { parseArgs } from 'node:util';
import { initializeInstallation } from '../config/installation.ts';
import { startService } from '../runtime/service.ts';
import { Runtime } from '../runtime/runtime.ts';

try {
  const { values } = parseArgs({ options: { root: { type: 'string' }, init: { type: 'boolean' }, origin: { type: 'string' }, port: { type: 'string' } } });
  if (!values.root) throw new Error('Specify --root with the absolute product root.');
  if (values.init) {
    if (!values.origin) throw new Error('Initialization requires --origin (the browser-facing origin).');
    const paths = initializeInstallation(values.root, { version: 1, origin: values.origin, port: Number(values.port ?? 3210) });
    // A new installation previews tonight's plan before Bots work unattended; existing installations keep how they ran.
    const runtime = new Runtime(paths.state);
    try { runtime.nights.setPreview(runtime.administrator(), true); } finally { runtime.close(); }
    process.stdout.write('Installation configuration created. Start without --init.\n');
  } else {
    if (values.origin || values.port) throw new Error('Edit config/niwa.json to change the installed origin or port.');
    const service = await startService(values.root);
    process.stdout.write('Niwa is running. There is no login: anyone who can open the configured origin uses it as the administrator.\n');
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void service.close(); });
  }
} catch {
  process.stderr.write('Niwa could not start. Check --root, config/niwa.json, file permissions, and whether another instance is running.\n');
  process.exitCode = 1;
}
