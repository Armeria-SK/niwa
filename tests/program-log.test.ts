import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { ProgramLog } from '../src/sandbox/program-log.ts';

const operation = () => ({ operation_id: 'op1', agent_id: 'bot1', room_id: 'room1', task_id: 'task1', command: ['python3', 'script.py'], seconds: 30, allow_start: true });
const output = { code: 0, stdout: 'saved', stderr: '' };
function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), 'niwa-program-'));
  const logs: ProgramLog[] = [];
  t.after(() => { for (const log of logs) { try { log.close(); } catch {} } rmSync(root, { recursive: true, force: true }); });
  const file = join(root, 'programs.db');
  return { file, open: (run: ConstructorParameters<typeof ProgramLog>[2], environment = 'image-and-workspace-v1') => {
    const log = new ProgramLog(file, environment, run); logs.push(log); return log;
  } };
}

test('program receipts survive restart and bind retries to command, environment and authenticated scope', async t => {
  const f = fixture(t); let runs = 0;
  const log = f.open(async () => { runs++; return output; });
  assert.deepEqual(await log.execute(operation()), output); assert.deepEqual(log.pending(), []); log.close();
  const reopened = f.open(async () => { runs++; return output; });
  assert.deepEqual(await reopened.execute(operation()), output); assert.equal(runs, 1);
  for (const field of ['agent_id', 'room_id', 'task_id'] as const) await assert.rejects(reopened.execute({ ...operation(), [field]: 'other' }), /conflicts/);
  await assert.rejects(reopened.execute({ ...operation(), command: ['python3', 'changed.py'] }), /conflicts/);
  await assert.rejects(reopened.execute({ ...operation(), seconds: 40 }), /conflicts/);
  await assert.rejects(f.open(async () => output, 'different-image').execute(operation()), /conflicts/);
  assert.equal(runs, 1);
});

test('concurrent delivery cannot execute a pending program twice and persisted intent records the exact container', async t => {
  const f = fixture(t); let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
  let name: string | undefined; let command: string[] | undefined;
  const log = f.open(async (request, _signal, container) => { name = container; await wait; command = request.command; return output; });
  const input = operation(); const first = log.execute(input); input.command[1] = 'mutated.py';
  const other = f.open(async () => { throw Error('Must not execute'); });
  assert.deepEqual(await other.execute(operation()), { error: 'outcome_unknown' });
  assert.deepEqual(other.pending(), [{ operation_id: 'op1', container: name }]);
  assert.match(name!, /^niwa-program-[a-f0-9-]{36}$/);
  release(); assert.deepEqual(await first, output); assert.deepEqual(command, operation().command);
  assert.deepEqual(await other.execute(operation()), output);
});

test('interrupted execution and failed receipt persistence remain unknown after restart without replay', async t => {
  const f = fixture(t); let runs = 0;
  const log = f.open(async () => { runs++; throw Error('interrupted after file write'); });
  assert.deepEqual(await log.execute(operation()), { error: 'outcome_unknown' }); log.close();
  const reopened = f.open(async () => { runs++; return output; });
  assert.deepEqual(await reopened.execute(operation()), { error: 'outcome_unknown' }); assert.equal(runs, 1);
  const db = new DatabaseSync(f.file);
  db.exec("CREATE TRIGGER reject_receipt BEFORE UPDATE ON programs BEGIN SELECT RAISE(ABORT,'disk failure'); END;");
  assert.deepEqual(await reopened.execute({ ...operation(), operation_id: 'op2' }), { error: 'outcome_unknown' });
  db.exec('DROP TRIGGER reject_receipt;'); db.close();
  assert.deepEqual(await reopened.execute({ ...operation(), operation_id: 'op2' }), { error: 'outcome_unknown' }); assert.equal(runs, 2);
  assert.equal(reopened.pending().length, 2);
});

test('invalid, pre-cancelled and closed-store operations do not start programs', async t => {
  const f = fixture(t); let runs = 0; const log = f.open(async () => { runs++; return output; });
  await assert.rejects(log.execute({ ...operation(), operation_id: '' }), /Invalid/);
  await assert.rejects(log.execute({ ...operation(), seconds: 301 }), /Invalid/);
  await assert.rejects(log.execute(operation(), AbortSignal.abort())); assert.deepEqual(log.pending(), []);
  const db = new DatabaseSync(f.file);
  db.exec("CREATE TRIGGER reject_intent BEFORE INSERT ON programs BEGIN SELECT RAISE(ABORT,'disk failure'); END;");
  await assert.rejects(log.execute(operation()), /disk failure/); db.close(); assert.deepEqual(log.pending(), []);
  log.close(); await assert.rejects(log.execute(operation())); assert.equal(runs, 0);
});

test('reconciliation cannot start a missing operation but can retrieve a saved result', async t => {
  const f = fixture(t); let runs = 0; const log = f.open(async () => { runs++; return output; });
  assert.deepEqual(await log.execute({ ...operation(), allow_start: false }), { error: 'outcome_unknown' });
  assert.deepEqual(log.pending(), []); assert.equal(runs, 0);
  assert.deepEqual(await log.execute(operation()), output);
  assert.deepEqual(await log.execute({ ...operation(), allow_start: false }), output); assert.equal(runs, 1);
  const db = new DatabaseSync(f.file); db.exec('DELETE FROM programs;'); db.close();
  assert.deepEqual(await log.execute({ ...operation(), allow_start: false }), { error: 'outcome_unknown' }); assert.equal(runs, 1);
});
