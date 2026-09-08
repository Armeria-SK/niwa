// Runs as the application user, including its IPC supplementary group.
import { request } from 'node:http';
import { readInstallation } from '../../dist/config/installation.js';
import { verifyExecutorEndpoint } from '../../dist/config/executor-endpoint.js';
const root = '/home/niwa/niwa';
const config = readInstallation(root);
const checks = [['workspace', config.workspaceExecutorUid], ['program', config.programExecutorUid]];
if (config.browserExecutorUid) checks.push(['browser', config.browserExecutorUid]);
const deadline = Date.now() + 45_000;
for (const [name, uid] of checks) {
  if (!uid) throw new Error(`Missing ${name} executor UID`);
  const socketPath = `${root}/runtime/sockets/${name}.sock`;
  const verify = verifyExecutorEndpoint(socketPath, uid);
  while (true) {
    try {
      verify();
      await new Promise((resolve, reject) => {
        // Invalid GET has no side effects; both brokers return 400 invalid_request.
        const req = request({ socketPath, path: '/', timeout: 1000 }, res => {
          res.resume(); res.on('end', () => res.statusCode === 400 ? resolve() : reject(new Error('Unexpected broker response')));
        });
        req.on('error', reject); req.on('timeout', () => req.destroy(new Error('Broker timeout'))); req.end();
      });
      break;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
}
console.log(`PASS: protected ${checks.map(([name])=>name).join(', ')} sockets respond as application user`);
