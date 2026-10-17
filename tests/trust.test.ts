import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Runtime } from '../src/runtime/runtime.ts';
import { suggestable, TRUST_STREAK } from '../src/runtime/trust.ts';
import { DomainError } from '../src/domain/types.ts';

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'niwa-trust-'));
  const runtime = new Runtime(root);
  const db = new DatabaseSync(join(root, 'control.db'));
  t.after(() => { db.close(); runtime.close(); rmSync(root, { recursive: true, force: true }); });
  const admin = runtime.administrator(), leader = runtime.bootstrap(admin), bot = runtime.agentSession(leader.id);
  const room = runtime.createRoom(admin, '任せる範囲');
  runtime.tasks.create(admin, leader.id, room.id, 'メモを書き足していく');
  return { runtime, db, admin, leader, bot, room };
}
const NOTE = 'mcp:mcp_notes_append_note';
/** One approval request of `kind`, answered by the administrator. Returns whether the Bot had to ask. */
function ask(f: ReturnType<typeof fixture>, kind: string, n: number, approve: boolean | null) {
  const lease = f.runtime.tasks.claim(f.admin)!;
  const asked = !f.runtime.authorizeAction(f.bot, lease, `op-${n}`, '書き込み', { tool: kind, arguments: { n } }, kind as never);
  if (asked && approve !== null) {
    const pending = f.runtime.approvals(f.admin).find(item => item.task_id === lease.task.id)!;
    f.runtime.decideApproval(f.admin, lease.task.id, approve, String(pending.version));
    if (!approve) f.runtime.tasks.create(f.admin, f.leader.id, f.room.id, '続きのメモ');
  } else if (!asked) f.runtime.tasks.finish(f.bot, lease, '書き込みました');
  return asked;
}

test('five approvals in a row suggest going ahead without asking; only a press grants it, and it can be taken back', t => {
  const f = fixture(t), { runtime, admin, leader } = f;
  for (let n = 1; n < TRUST_STREAK; n++) assert.equal(ask(f, NOTE, n, true), true);
  assert.deepEqual(runtime.trust.state(admin).suggestions, []);
  assert.equal(ask(f, NOTE, TRUST_STREAK, true), true);
  const [suggestion] = runtime.trust.state(admin).suggestions;
  assert.deepEqual({ ...suggestion, last_at: 0 }, { agent_id: leader.id, name: leader.name, kind: NOTE, streak: TRUST_STREAK, last_at: 0 });
  // Still asking until the administrator presses.
  assert.equal(ask(f, NOTE, 6, true), true);
  runtime.trust.grant(admin, leader.id, NOTE);
  assert.equal(ask(f, NOTE, 7, null), false, 'granted kinds go ahead without asking');
  assert.equal(runtime.approvals(admin).length, 0);
  const state = runtime.trust.state(admin);
  assert.deepEqual(state.grants.map(item => [item.kind, item.automatic]), [[NOTE, 1]]);
  assert.deepEqual(state.suggestions, []);
  // Other kinds and other Bots still ask.
  runtime.tasks.create(admin, leader.id, f.room.id, '別の書き込み');
  assert.equal(ask(f, 'mcp:mcp_notes_delete_note', 8, true), true);
  runtime.trust.revoke(admin, leader.id, NOTE);
  assert.deepEqual(runtime.trust.state(admin), { threshold: TRUST_STREAK, suggestions: [], grants: [] }, 'a revoked kind is not suggested again at once');
  assert.equal(ask(f, NOTE, 9, true), true, 'after revoking, it asks again');
  assert.throws(() => runtime.trust.grant(f.bot, leader.id, NOTE), /Administrator required/);
});

test('a decline starts the count again, a dismissed suggestion waits for another run, and an ungranted kind cannot be granted', t => {
  const f = fixture(t), { runtime, admin, leader } = f;
  for (let n = 1; n <= 4; n++) ask(f, NOTE, n, true);
  ask(f, NOTE, 5, false);
  for (let n = 6; n <= 9; n++) ask(f, NOTE, n, true);
  assert.deepEqual(runtime.trust.state(admin).suggestions, []);
  assert.throws(() => runtime.trust.grant(admin, leader.id, NOTE), (error: unknown) => error instanceof DomainError && error.code === 'conflict');
  ask(f, NOTE, 10, true);
  assert.equal(runtime.trust.state(admin).suggestions.length, 1);
  runtime.trust.dismiss(admin, leader.id, NOTE);
  for (let n = 11; n <= 14; n++) ask(f, NOTE, n, true);
  assert.deepEqual(runtime.trust.state(admin).suggestions, []);
  ask(f, NOTE, 15, true);
  assert.equal(runtime.trust.state(admin).suggestions[0]!.streak, 10);
});

test('forms, page requests, free requests and payment-like tools are never suggested, however often approved', t => {
  const f = fixture(t), { runtime, admin, leader } = f;
  for (const kind of ['form', 'page_request', 'mcp:mcp_shop_create_payment', 'mcp:mcp_blog_publish_post', 'mcp:mcp_mail_send_message']) {
    for (let n = 1; n <= TRUST_STREAK + 2; n++) ask(f, kind, n, true);
    assert.equal(suggestable(kind), false);
    assert.throws(() => runtime.trust.grant(admin, leader.id, kind), (error: unknown) => error instanceof DomainError && error.code === 'forbidden');
  }
  const lease = runtime.tasks.claim(admin)!;
  runtime.requestApproval(f.bot, lease, '購入の承認', '1,200円の本を買う');
  runtime.decideApproval(admin, lease.task.id, true, String(runtime.approvals(admin)[0]!.version));
  assert.deepEqual(runtime.trust.state(admin).suggestions, []);
  // Even a row written directly never lets a form go ahead.
  f.db.prepare('INSERT INTO approval_grants VALUES (?,?,?,?)').run(leader.id, 'form', 9, Date.now());
  assert.equal(ask(f, 'form', 99, null), true);
  assert.equal(suggestable(NOTE), true);
  assert.equal(suggestable('action'), false);
});

test('deleting a conversation removes its approval history, and deleting a Bot removes its grants', t => {
  const f = fixture(t), { runtime, admin, leader, db } = f;
  for (let n = 1; n <= TRUST_STREAK; n++) ask(f, NOTE, n, true);
  runtime.trust.grant(admin, leader.id, NOTE);
  const other = runtime.createRoom(admin, '別の会話');
  runtime.tasks.create(admin, leader.id, other.id, 'もうひとつ');
  assert.equal(Number(db.prepare('SELECT count(*) AS n FROM approval_history').get()!.n), TRUST_STREAK);
  runtime.deleteContent(admin, 'room', f.room.id);
  assert.equal(Number(db.prepare('SELECT count(*) AS n FROM approval_history').get()!.n), 0);
  const member = runtime.createAgent(f.bot, '手伝い');
  db.prepare('INSERT INTO approval_grants VALUES (?,?,?,?)').run(member.id, NOTE, 5, Date.now());
  runtime.deleteAgent(admin, member.id);
  assert.equal(Number(db.prepare('SELECT count(*) AS n FROM approval_grants WHERE agent_id=?').get(member.id)!.n), 0);
});
