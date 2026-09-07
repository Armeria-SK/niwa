import { chmodSync, lstatSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { assertDirectoryPath } from '../config/paths.ts';
import { acquireProcessLock } from '../runtime/process-lock.ts';
import { configuredProgramRunner } from '../sandbox/program.ts';
import { ProgramLog } from '../sandbox/program-log.ts';
import { createProgramServer } from '../sandbox/server.ts';

let broker: ReturnType<typeof createProgramServer> | undefined;
let log: ProgramLog | undefined; let unlock: (() => void) | undefined; let closing: Promise<void> | undefined;
const close = () => closing ??= (async () => { await broker?.stop(); log?.close(); unlock?.(); })();
try {
  const { values } = parseArgs({ options: Object.fromEntries(['workspace', 'socket', 'state', 'home', 'runtime', 'image'].map(key => [key, { type: 'string' as const }])) });
  if (process.platform !== 'linux' || !process.getuid?.() || Object.values(values).some(value => typeof value !== 'string') ||
      !values.workspace || !values.socket || !values.state || !values.home || !values.runtime || !values.image) throw new Error('Executor configuration required');
  if (!isAbsolute(values.workspace as string)) throw new Error('Absolute workspace required');
  const workspace = resolve(values.workspace as string); const socket = values.socket as string; const state = values.state as string;
  for (const privatePath of [socket, state]) {
    if (!isAbsolute(privatePath)) throw new Error('Absolute executor path required');
    const rel = relative(workspace, resolve(privatePath));
    if (!rel || (!rel.startsWith('../') && rel !== '..')) throw new Error('Execution state must be outside the shared mount');
  }
  assertDirectoryPath(state); assertDirectoryPath(dirname(socket));
  const stateInfo = lstatSync(state); const socketInfo = lstatSync(dirname(socket));
  if (stateInfo.uid !== process.getuid() || (stateInfo.mode & 0o077) || socketInfo.uid !== process.getuid() || (socketInfo.mode & 0o007))
    throw new Error('Protected executor directories required');
  process.umask(0o077);
  const environment = { workspace, image: values.image as string, uid: process.getuid(), gid: process.getgid!(), home: values.home as string, runtime: values.runtime as string };
  const run = configuredProgramRunner(environment);
  await run.verify();
  unlock = acquireProcessLock(join(state, 'program-lock.db'));
  log = new ProgramLog(join(state, 'programs.db'), JSON.stringify(environment), run);
  // Recovery only terminates saved containers. It does not infer success or repeat their commands.
  for (const pending of log.pending()) await run.cleanup(pending.container);
  broker = createProgramServer(log);
  await new Promise<void>((resolve, reject) => { broker!.server.once('error', reject); broker!.server.listen(socket, resolve); });
  chmodSync(socket, 0o660);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void close().catch(() => { process.exitCode = 1; }); });
  process.stdout.write('Niwa program executor is listening on its protected local socket.\n');
} catch {
  await close();
  process.stderr.write('Program executor could not start. Check its dedicated identity, private state, protected socket and installed Podman environment.\n');
  process.exitCode = 1;
}
