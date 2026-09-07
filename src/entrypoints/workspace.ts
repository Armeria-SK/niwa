import { chmodSync, lstatSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { assertDirectoryPath } from '../config/paths.ts';
import { Workspace } from '../tools/files/workspace.ts';
import { createWorkspaceServer } from '../tools/files/server.ts';
import { WorkspaceWriteLog } from '../tools/files/write-log.ts';
import { acquireProcessLock } from '../runtime/process-lock.ts';

let server: ReturnType<typeof createWorkspaceServer> | undefined;
let writes: WorkspaceWriteLog | undefined;
let unlock: (() => void) | undefined;
let closed = false;
const closeState = () => { if (!closed) { closed = true; writes?.close(); unlock?.(); } };
try {
  const { values } = parseArgs({ options: { workspace: { type: 'string' }, socket: { type: 'string' }, state: { type: 'string' } } });
  if (process.platform !== 'linux' || !process.getuid?.() || !values.workspace || !values.socket || !values.state ||
    !isAbsolute(values.socket) || !isAbsolute(values.state)) throw new Error('Dedicated Linux execution identity required');
  for (const privatePath of [values.state, values.socket]) {
    const rel = relative(resolve(values.workspace), resolve(privatePath));
    if (!rel || (!rel.startsWith('../') && rel !== '..' && !isAbsolute(rel))) throw new Error('Execution state and socket must be outside the shared mount');
  }
  assertDirectoryPath(values.state);
  const state = lstatSync(values.state);
  if (state.uid !== process.getuid?.() || (state.mode & 0o077)) throw new Error('Private executor state required');
  assertDirectoryPath(dirname(values.socket));
  const directory = lstatSync(dirname(values.socket));
  if (directory.mode & 0o007) throw new Error('Socket directory must exclude other users');
  process.umask(0o077);
  unlock = acquireProcessLock(join(values.state, 'workspace-lock.db'));
  const files = new Workspace(values.workspace);
  writes = new WorkspaceWriteLog(join(values.state, 'workspace-writes.db'), files);
  server = createWorkspaceServer(files, writes);
  server.once('close', closeState);
  // Do not unlink an existing socket: a second process must fail instead of replacing a live broker.
  await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(values.socket, resolve); });
  chmodSync(values.socket, 0o660);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
    server!.close(); server!.closeAllConnections();
  });
  process.stdout.write('Niwa workspace broker is listening on its protected local socket.\n');
} catch {
  server?.close(); server?.closeAllConnections();
  closeState();
  process.stderr.write('Workspace broker could not start. Check the dedicated identity, private execution state, workspace and protected socket directory.\n');
  process.exitCode = 1;
}
