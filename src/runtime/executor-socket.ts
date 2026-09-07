import { lstatSync, unlinkSync, type Stats } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, isAbsolute } from 'node:path';
import { assertDirectoryPath } from '../config/paths.ts';

interface SocketIO { stat(path: string): Pick<Stats, 'uid' | 'mode' | 'ino' | 'dev' | 'nlink' | 'isSocket' | 'isSymbolicLink'>; alive(path: string): Promise<boolean>; remove(path: string): void }
const socketIO: SocketIO = {
  stat: lstatSync, remove: unlinkSync,
  alive: path => new Promise((resolve, reject) => {
    const socket = createConnection(path); const timeout = setTimeout(() => { socket.destroy(); reject(new Error('Socket probe timed out')); }, 500);
    socket.once('connect', () => { clearTimeout(timeout); socket.destroy(); resolve(true); });
    socket.once('error', error => { clearTimeout(timeout); socket.destroy();
      if ((error as NodeJS.ErrnoException).code === 'ECONNREFUSED') resolve(false); else reject(error);
    });
  }),
};

/** Call only while holding the service's exclusive process lock, in its protected socket directory. */
export async function recoverExecutorSocket(path: string, uid: number, io: SocketIO = socketIO): Promise<void> {
  if (!isAbsolute(path) || !Number.isSafeInteger(uid) || uid < 1) throw new Error('Invalid executor socket');
  assertDirectoryPath(dirname(path));
  let before: ReturnType<SocketIO['stat']>;
  try { before = io.stat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  const owned = (info: typeof before) => info.isSocket() && !info.isSymbolicLink() && info.uid === uid && info.nlink === 1 && !(info.mode & 0o007);
  if (!owned(before)) throw new Error('Unsafe executor socket');
  if (await io.alive(path)) throw new Error('Executor socket is still in use');
  const current = io.stat(path);
  if (!owned(current) || current.ino !== before.ino || current.dev !== before.dev) throw new Error('Executor socket changed during recovery');
  io.remove(path);
}
