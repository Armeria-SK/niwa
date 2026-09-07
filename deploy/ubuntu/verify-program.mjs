import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { configuredProgramRunner } from '../../dist/sandbox/program.js';

// Run only under the prepared niwa-exec identity with an administrator-selected Python image.
const { values } = parseArgs({ options: { apply: { type: 'boolean' }, ...Object.fromEntries(['workspace', 'home', 'runtime', 'image'].map(key => [key, { type: 'string' }])) } });
assert.equal(values.apply, true, 'Explicit --apply is required to run the container checks');
assert.ok(['workspace', 'home', 'runtime', 'image'].every(key => typeof values[key] === 'string'));
const run = configuredProgramRunner({ ...values, uid: process.getuid?.(), gid: process.getgid?.() });
await run.verify();
assert.equal(readdirSync(values.workspace).length, 0, 'Use an empty verification workspace, never real Bot files');
const id = `verification-${randomUUID()}`; const shared = join(values.workspace, id); const sentinel = join(values.home, `${id}.txt`);
mkdirSync(shared); writeFileSync(sentinel, 'synthetic-private-sentinel', { flag: 'wx', mode: 0o600 });
try {
  symlinkSync(sentinel, join(shared, 'outside'));
  const code = `import json,os,pathlib,socket
work=pathlib.Path('/workspace')/${JSON.stringify(id)}
assert os.getuid()!=0
assert not pathlib.Path(${JSON.stringify(sentinel)}).exists()
try: (work/'outside').read_text(); raise AssertionError('host symlink escaped')
except (FileNotFoundError,PermissionError): pass
try: pathlib.Path('/niwa-write-test').write_text('x'); raise AssertionError('writable root')
except OSError: pass
s=socket.socket(); s.settimeout(.5)
try: s.connect(('1.1.1.1',443)); raise AssertionError('network allowed')
except OSError: pass
finally: s.close()
limits={name:pathlib.Path('/sys/fs/cgroup/'+name).read_text().strip() for name in ['memory.max','memory.swap.max','pids.max','cpu.max']}
assert limits['memory.max']=='536870912' and limits['memory.swap.max']=='0' and limits['pids.max']=='64'
quota,period=map(int,limits['cpu.max'].split()); assert quota==period
status=pathlib.Path('/proc/self/status').read_text(); assert 'NoNewPrivs:\\t1' in status and 'Seccomp:\\t2' in status
(work/'result.txt').write_text('synthetic-result')
print(json.dumps({'uid':os.getuid(),'limits':limits,'shared_write':True,'network_blocked':True,'private_blocked':True}))`;
  const checked = await run({ command: ['python3', '-c', code], seconds: 20 });
  assert.equal(checked.code, 0, checked.stderr); assert.equal(readFileSync(join(shared, 'result.txt'), 'utf8'), 'synthetic-result');
  assert.equal(readFileSync(sentinel, 'utf8'), 'synthetic-private-sentinel');
  const failed = await run({ command: ['python3', '-c', 'import sys;sys.exit(7)'], seconds: 5 }); assert.equal(failed.code, 7);
  const timeout = await run({ command: ['python3', '-c', 'import time;time.sleep(30)'], seconds: 1 }); assert.notEqual(timeout.code, 0);
  await assert.rejects(run({ command: ['python3', '-c', 'import sys;sys.stdout.write("x"*1048576)'], seconds: 5 }), /interrupted/);
  const cancel = new AbortController(); const timer = setTimeout(() => cancel.abort(), 1000);
  try { await assert.rejects(run({ command: ['python3', '-c', 'import time;time.sleep(30)'], seconds: 5 }, cancel.signal)); }
  finally { clearTimeout(timer); }
  process.stdout.write(`PASS: isolated program boundaries, shared output, nonzero exit, output limit, timeout and cancellation\n${checked.stdout}`);
} finally {
  // Both paths were created exclusively by this run, below the explicitly verified roots.
  rmSync(shared, { recursive: true, force: true }); rmSync(sentinel, { force: true });
}
