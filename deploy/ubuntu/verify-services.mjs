import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { readInstallation } from '../../dist/config/installation.js';
import { configuredWorkspaceReader } from '../../dist/tools/files/client.js';
import { verifyExecutorEndpoint } from '../../dist/config/executor-endpoint.js';
import './wait-executors.mjs';
const root = '/home/niwa/niwa';
const config = readInstallation(root);
const socketPath = `${root}/runtime/sockets/program.sock`;
const verify = verifyExecutorEndpoint(socketPath, config.programExecutorUid);
const read = configuredWorkspaceReader(`${root}/runtime/sockets/workspace.sock`, config.workspaceExecutorUid);
const id = randomUUID(), directory = `.service-acceptance-${id}`;
const call = async input => {
  verify();
  return await new Promise((resolve, reject) => {
    const req = request({socketPath, path: '/programs', method: 'POST', headers: {'Content-Type': 'application/json'},
      signal: AbortSignal.timeout(30_000)}, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', chunk => { body += chunk; if(body.length > 200_000) res.destroy(new Error('Oversized result')); });
      res.on('error', reject); res.on('end', () => {try {assert.equal(res.statusCode, 200); resolve(JSON.parse(body).result);} catch(error){reject(error);} });
    }); req.on('error', reject); req.end(JSON.stringify(input));
  });
};
const input = {operation_id: `acceptance-${id}`, agent_id: 'local-acceptance', room_id: 'local-acceptance', task_id: 'local-acceptance', allow_start: true,
  seconds: 10, command: ['python3', '-c', `from pathlib import Path\np=Path(${JSON.stringify(directory)})\np.mkdir()\n(p/'proof.txt').write_text('service acceptance')\nprint('created')`]};
let created = false;
try {
  const result = await call(input); assert.equal(result.code, 0, result.stderr ?? result.error); created = true;
  assert.equal((await read('read', `${directory}/proof.txt`)).content, 'service acceptance');
  assert.deepEqual(await call({...input, allow_start: false}), result, 'Saved operation must not run again');
  assert.equal((await call({...input, operation_id: `missing-${id}`, allow_start: false})).error, 'outcome_unknown');
  console.log('PASS: live program/workspace IPC, shared output, durable receipt and no unapproved replay');
} finally {
  if (created) {
    const clean = await call({...input, operation_id: `cleanup-${id}`, command:['python3','-c',
      `from pathlib import Path\np=Path(${JSON.stringify(directory)})\n(p/'proof.txt').unlink()\np.rmdir()`]});
    assert.equal(clean.code, 0, 'Artificial workspace cleanup failed');
  }
}
