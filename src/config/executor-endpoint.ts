import { lstatSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { assertDirectoryPath } from './paths.ts';

export function verifyExecutorEndpoint(socketPath: string, executionUid: number): () => void {
  if (process.platform !== 'linux' || !isAbsolute(socketPath) || !Number.isSafeInteger(executionUid) || executionUid < 1 || executionUid === process.getuid?.())
    throw new Error('A separate Linux execution identity is required');
  return () => {
    assertDirectoryPath(dirname(socketPath));
    const directory = lstatSync(dirname(socketPath)); const socket = lstatSync(socketPath);
    if ((directory.mode & 0o007) || !socket.isSocket() || socket.isSymbolicLink() || socket.uid !== executionUid || (socket.mode & 0o007))
      throw new Error('Executor endpoint is not protected');
  };
}
