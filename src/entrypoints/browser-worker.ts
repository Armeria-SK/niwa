import { browserWorker } from '../tools/browser/worker.ts';

if (process.platform !== 'linux' || !process.getuid?.()) throw new Error('Browser worker requires its non-root Linux container');
process.umask(0o077);
const worker = await browserWorker(process.stdin, process.stdout, '/usr/bin/chromium', '/tmp/niwa-browser');
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { void worker.close(); });
