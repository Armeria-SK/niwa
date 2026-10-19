import type { DatabaseSync } from 'node:sqlite';
import { Value } from '@sinclair/typebox/value';
import type { Runtime, Actor } from './runtime.ts';
import type { TaskLease } from '../domain/task.ts';
import type { Message } from '../domain/types.ts';
import { check, text } from '../domain/types.ts';
import { transaction } from '../storage/database.ts';
import { redactSecrets } from '../shared/redaction.ts';
import { DIGEST_SECTIONS, digestBodySchema, digestDeltaSchema, emptyDigest, type DigestBody, type DigestDelta, type DigestSection } from '../domain/room-digest.ts';
import { mergeDigest, type DigestSource } from './context/digest.ts';

export type RoomMode = 'full' | 'shadow' | 'digest';
export const ROOM_MODES: readonly RoomMode[] = ['full', 'shadow', 'digest'];
/** A refresh is due once this much of the conversation lies after the digest. */
const DUE_MESSAGES = 40, DUE_TOKENS = 16_000;
/** What stays word for word after a refresh, and how much one refresh may fold. */
const KEEP_MESSAGES = 10, KEEP_SHORT_MESSAGES = 20, KEEP_TOKENS = 6_000, FOLD_TOKENS = 30_000, CONTEXT_ONLY = 4;
const CLAIM_MS = 10 * 60_000, VERSIONS_KEPT = 20;
const TERMINAL = "('completed','cancelled','failed')";

/** Niwa's estimate of a message as the model sees it (bytes/3, like fitContext). */
export const messageTokens = (message: Pick<Message, 'id' | 'author_id' | 'body'>) => Math.ceil(Buffer.byteLength(JSON.stringify({ message_id: message.id, author_id: message.author_id, text: message.body })) / 3);
export type RoomView = { mode: RoomMode; digest_revision: number; cutoff_rowid: number };
export type FoldPlan = { expected_revision: number; old_cutoff: number; previous: DigestBody; fold: Message[]; context_only: Message[]; cutoff_message_id: string };

/** 会話のまとめ: one cited digest per conversation that Bots read in place of the older messages, and each task's pinned view of it. */
export class RoomDigests {
  constructor(private db: DatabaseSync, private runtime: Runtime, private principal: (actor: Actor) => { kind: string; id: string }) {}
  /** Message rowids in room order; messages() returns the same order. */
  rowids(roomId: string): number[] {
    return (this.db.prepare('SELECT rowid AS r FROM messages WHERE room_id=? ORDER BY rowid').all(roomId) as { r: number }[]).map(row => Number(row.r));
  }
  #sources(roomId: string, messages: readonly Message[]): Map<string, DigestSource> {
    const rowids = this.rowids(roomId);
    return new Map(messages.map((message, index) => [message.id, { author_id: message.author_id, rowid: rowids[index]! }]));
  }
  /** The digest as stored, at its current or a pinned revision; readable wherever the conversation is. */
  get(actor: Actor, roomId: string, revision?: number): { revision: number; cutoff_rowid: number; body: DigestBody; updated_at?: number; agent_id?: string | null; model?: string | null } | undefined {
    this.runtime.messages(actor, roomId);
    const row = revision === undefined ? this.db.prepare('SELECT * FROM room_digests WHERE room_id=?').get(roomId)
      : this.db.prepare('SELECT * FROM room_digest_versions WHERE room_id=? AND revision=?').get(roomId, revision);
    if (!row) return undefined;
    const body = JSON.parse(String(row.body)) as DigestBody;
    if (!Value.Check(digestBodySchema, body)) return undefined;
    return { revision: Number(row.revision), cutoff_rowid: Number(row.cutoff_rowid), body,
      ...(revision === undefined ? { updated_at: Number(row.updated_at), agent_id: row.agent_id as string | null, model: row.model as string | null } : {}) };
  }
  /**
   * The view a task keeps for its whole run: the mode and, in digest mode, the digest revision and cutoff at its first step. New messages
   * then only ever append to what the task sends. A task that already ran before this existed keeps today's full view.
   */
  bind(actor: Actor, lease: TaskLease, mode: RoomMode, hadSteps: boolean): RoomView {
    check(this.runtime.tasks.active(actor, lease), 'conflict', 'Task is no longer active');
    const current = mode === 'digest' && !hadSteps ? this.db.prepare('SELECT revision,cutoff_rowid FROM room_digests WHERE room_id=?').get(lease.task.room_id) : undefined;
    this.db.prepare('INSERT OR IGNORE INTO task_room_views VALUES (?,?,?,?,?)')
      .run(lease.task.id, hadSteps ? 'full' : mode, Number(current?.revision ?? 0), Number(current?.cutoff_rowid ?? 0), Date.now());
    const row = this.db.prepare('SELECT mode,digest_revision,cutoff_rowid FROM task_room_views WHERE task_id=?').get(lease.task.id)!;
    return { mode: row.mode as RoomMode, digest_revision: Number(row.digest_revision), cutoff_rowid: Number(row.cutoff_rowid) };
  }
  /** The view this task already fixed, if any. */
  view(actor: Actor, lease: TaskLease): RoomView | undefined {
    check(this.runtime.tasks.active(actor, lease), 'conflict', 'Task is no longer active');
    const row = this.db.prepare('SELECT mode,digest_revision,cutoff_rowid FROM task_room_views WHERE task_id=?').get(lease.task.id);
    return row ? { mode: row.mode as RoomMode, digest_revision: Number(row.digest_revision), cutoff_rowid: Number(row.cutoff_rowid) } : undefined;
  }
  /** What a refresh would fold now, if one is due: the oldest messages after the digest, keeping a word-for-word tail. */
  plan(actor: Actor, lease: TaskLease, foldBudget = FOLD_TOKENS): FoldPlan | undefined {
    const messages = this.runtime.messages(actor, lease.task.room_id), rowids = this.rowids(lease.task.room_id);
    const digest = this.get(actor, lease.task.room_id);
    const start = rowids.findIndex(rowid => rowid > (digest?.cutoff_rowid ?? 0));
    if (start < 0) return undefined;
    const tail = messages.slice(start), tokens = tail.map(messageTokens);
    const tailTokens = tokens.reduce((sum, value) => sum + value, 0);
    if (tail.length <= DUE_MESSAGES && tailTokens <= DUE_TOKENS) return undefined;
    let folded = 0, foldedTokens = 0;
    // The word-for-word tail keeps at least 10 messages and about 6k tokens; with short messages, 20 messages are enough.
    while (folded < tail.length && foldedTokens + tokens[folded]! <= foldBudget) {
      const left = tail.length - folded - 1, leftTokens = tailTokens - foldedTokens - tokens[folded]!;
      if (left < KEEP_MESSAGES || (leftTokens < KEEP_TOKENS && left < KEEP_SHORT_MESSAGES)) break;
      foldedTokens += tokens[folded++]!;
    }
    if (!folded) return undefined;
    return { expected_revision: digest?.revision ?? 0, old_cutoff: digest?.cutoff_rowid ?? 0, previous: digest?.body ?? emptyDigest(),
      fold: tail.slice(0, folded), context_only: tail.slice(folded, folded + CONTEXT_ONLY), cutoff_message_id: tail[folded - 1]!.id };
  }
  /** One task at a time refreshes a conversation's digest; a stale claim expires, and a failure waits before the next try. */
  claim(actor: Actor, lease: TaskLease): boolean {
    check(this.runtime.tasks.active(actor, lease), 'conflict', 'Task is no longer active');
    return transaction(this.db, () => {
      const now = Date.now(), row = this.db.prepare('SELECT task_id,claimed_at,retry_at FROM room_digest_claims WHERE room_id=?').get(lease.task.room_id);
      if (row && ((row.task_id !== null && Number(row.claimed_at) > now - CLAIM_MS) || Number(row.retry_at) > now)) return false;
      this.db.prepare(`INSERT INTO room_digest_claims(room_id,task_id,claimed_at) VALUES (?,?,?) ON CONFLICT(room_id) DO UPDATE SET task_id=excluded.task_id,claimed_at=excluded.claimed_at`)
        .run(lease.task.room_id, lease.task.id, now);
      return true;
    });
  }
  /** Gives the claim back; after a failure the next try waits 10 minutes, doubling up to an hour. */
  release(actor: Actor, lease: TaskLease, failed: boolean): void {
    this.runtime.tasks.get(actor, lease.task.id);
    if (!failed) { this.db.prepare('UPDATE room_digest_claims SET task_id=NULL,failures=0,retry_at=0 WHERE room_id=? AND task_id=?').run(lease.task.room_id, lease.task.id); return; }
    this.db.prepare(`UPDATE room_digest_claims SET task_id=NULL,failures=failures+1,retry_at=?+min(60,10*(1<<min(failures,3)))*60000 WHERE room_id=? AND task_id=?`)
      .run(Date.now(), lease.task.room_id, lease.task.id);
  }
  /** Applies a model's delta when the digest has not moved since the plan; the cutoff moves to the last folded message. */
  save(actor: Actor, lease: TaskLease, plan: FoldPlan, delta: DigestDelta, model: string): { saved: boolean; applied: number; rejected: number } {
    check(this.runtime.tasks.active(actor, lease), 'conflict', 'Task is no longer active');
    check(Value.Check(digestDeltaSchema, delta), 'invalid', 'Invalid digest delta');
    const messages = this.runtime.messages(actor, lease.task.room_id), sources = this.#sources(lease.task.room_id, messages);
    const cutoff = sources.get(plan.cutoff_message_id);
    check(cutoff, 'not_found', 'Digest cutoff left the conversation');
    return transaction(this.db, () => {
      const current = this.db.prepare('SELECT revision FROM room_digests WHERE room_id=?').get(lease.task.room_id);
      if (Number(current?.revision ?? 0) !== plan.expected_revision) return { saved: false, applied: 0, rejected: 0 };
      const revision = plan.expected_revision + 1;
      const merged = mergeDigest(plan.previous, delta, sources, plan.old_cutoff, cutoff.rowid, revision);
      if ('rejectedAll' in merged) return { saved: false, applied: 0, rejected: merged.rejected };
      this.#write(lease.task.room_id, revision, cutoff.rowid, merged.body, { task_id: lease.task.id, agent_id: lease.task.agent_id, model });
      this.db.prepare('INSERT INTO room_digest_audit VALUES (?,?,NULL,?,?,?)').run(lease.task.room_id, revision, 'built', lease.task.agent_id, Date.now());
      return { saved: true, applied: merged.applied, rejected: merged.rejected };
    });
  }
  #write(roomId: string, revision: number, cutoff: number, body: DigestBody, by: { task_id: string | null; agent_id: string | null; model: string | null }): void {
    const now = Date.now(), json = JSON.stringify(body);
    this.db.prepare(`INSERT INTO room_digests VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(room_id) DO UPDATE SET revision=excluded.revision,cutoff_rowid=excluded.cutoff_rowid,
      body=excluded.body,task_id=excluded.task_id,agent_id=excluded.agent_id,model=excluded.model,updated_at=excluded.updated_at`).run(roomId, revision, cutoff, json, by.task_id, by.agent_id, by.model, now);
    this.db.prepare('INSERT OR REPLACE INTO room_digest_versions VALUES (?,?,?,?,?)').run(roomId, revision, cutoff, json, now);
    // Keep the newest versions and any a running task still reads.
    this.db.prepare(`DELETE FROM room_digest_versions WHERE room_id=? AND revision<=? AND revision NOT IN
      (SELECT v.digest_revision FROM task_room_views v JOIN tasks t ON t.id=v.task_id WHERE t.room_id=? AND t.state NOT IN ${TERMINAL})`).run(roomId, revision - VERSIONS_KEPT, roomId);
  }
  #admin(actor: Actor): void { check(this.principal(actor).kind === 'admin', 'forbidden', 'Administrator required'); }
  /** The administrator's correction is final: models cannot change an edited item. */
  edit(actor: Actor, roomId: string, itemId: string, patch: { text: string; section: DigestSection }): DigestBody {
    this.#admin(actor); text(patch.text, 300);
    check(DIGEST_SECTIONS.includes(patch.section), 'invalid', 'Invalid digest section');
    return transaction(this.db, () => {
      const digest = this.get(actor, roomId);
      const item = digest?.body.items.find(candidate => candidate.id === itemId);
      check(digest && item, 'not_found', 'Digest item not found');
      const revision = digest.revision + 1;
      Object.assign(item, { text: redactSecrets(patch.text.trim()), section: patch.section, admin_edited: true as const, updated_rev: revision });
      this.#write(roomId, revision, digest.cutoff_rowid, digest.body, { task_id: null, agent_id: null, model: null });
      this.db.prepare('INSERT INTO room_digest_audit VALUES (?,?,?,?,?,?)').run(roomId, revision, itemId, 'edited', 'administrator', Date.now());
      return digest.body;
    });
  }
  /** Removing an item also removes its wording from every stored version. */
  remove(actor: Actor, roomId: string, itemId: string): DigestBody {
    this.#admin(actor);
    return transaction(this.db, () => {
      const digest = this.get(actor, roomId);
      check(digest && digest.body.items.some(item => item.id === itemId), 'not_found', 'Digest item not found');
      const revision = digest.revision + 1;
      digest.body.items = digest.body.items.filter(item => item.id !== itemId);
      for (const row of this.db.prepare('SELECT revision,body FROM room_digest_versions WHERE room_id=?').all(roomId)) {
        const body = JSON.parse(String(row.body)) as DigestBody;
        body.items = body.items.filter(item => item.id !== itemId); body.stubs = body.stubs.filter(stub => stub.id !== itemId); body.resolved = body.resolved.filter(entry => entry.id !== itemId);
        this.db.prepare('UPDATE room_digest_versions SET body=? WHERE room_id=? AND revision=?').run(JSON.stringify(body), roomId, Number(row.revision));
      }
      this.#write(roomId, revision, digest.cutoff_rowid, digest.body, { task_id: null, agent_id: null, model: null });
      this.db.prepare('INSERT INTO room_digest_audit VALUES (?,?,?,?,?,?)').run(roomId, revision, itemId, 'deleted', 'administrator', Date.now());
      return digest.body;
    });
  }
  /** Starts over: the next eligible task rebuilds the digest from the beginning, in chunks. */
  reset(actor: Actor, roomId: string): void {
    this.#admin(actor); this.runtime.messages(actor, roomId);
    this.purge(roomId);
    this.db.prepare('INSERT INTO room_digest_audit VALUES (?,0,NULL,?,?,?)').run(roomId, 'reset', 'administrator', Date.now());
  }
  /** Deletion of the conversation (or content it summarized) removes the digest and every stored version. */
  purge(roomId: string): void {
    for (const table of ['room_digests', 'room_digest_versions', 'room_digest_claims']) this.db.prepare(`DELETE FROM ${table} WHERE room_id=?`).run(roomId);
  }
  /** Audit and digest state for the administrator's panel. */
  history(actor: Actor, roomId: string) {
    this.#admin(actor); this.runtime.messages(actor, roomId);
    return this.db.prepare('SELECT revision,item_id,action,actor_id,created_at FROM room_digest_audit WHERE room_id=? ORDER BY rowid DESC LIMIT 50').all(roomId);
  }
}
