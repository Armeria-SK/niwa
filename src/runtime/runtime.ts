import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { check, text } from '../domain/types.ts';
import type { Agent, Room, Message, Memory, Settings } from '../domain/types.ts';
import { openDatabase, transaction } from '../storage/database.ts';
import { controlSchema, memorySchema } from '../storage/schema.ts';

declare const identity: unique symbol;
/** Opaque in-process capability; never construct this from HTTP or tool arguments. */
export type Actor = { readonly [identity]: true };
type Principal = { kind: 'admin'; id: 'administrator' } | { kind: 'agent'; id: string };

/** Trusted application service. Do not expose this object to generated code or models. */
export class Runtime {
  #db: DatabaseSync;
  #root: string;
  #identities = new WeakMap<Actor, Principal>();
  #memories = new Map<string, DatabaseSync>();
  #closed = false;

  constructor(stateDirectory: string) {
    this.#root = resolve(stateDirectory);
    this.#db = openDatabase(join(this.#root, 'control.db'), controlSchema);
  }

  close(): void {
    if (this.#closed) return;
    for (const db of this.#memories.values()) db.close();
    this.#db.close();
    this.#closed = true;
    this.#identities = new WeakMap();
  }

  // Composition-root functions: future HTTP authentication / scheduler issues these.
  // These are NOT login endpoints; models never get to choose an execution identity.
  administrator(): Actor { return this.#issue({ kind: 'admin', id: 'administrator' }); }
  agentSession(agentId: string): Actor {
    this.#agent(agentId);
    return this.#issue({ kind: 'agent', id: agentId });
  }
  #issue(principal: Principal): Actor {
    check(!this.#closed, 'conflict', 'Runtime is closed');
    const actor = Object.freeze({}) as Actor;
    this.#identities.set(actor, principal);
    return actor;
  }
  #principal(actor: Actor): Principal {
    const principal = this.#identities.get(actor);
    check(principal, 'forbidden', 'Unrecognized execution identity');
    if (principal.kind === 'agent') {
      check(this.#agent(principal.id).status === 'active', 'forbidden', 'Agent is dormant');
    }
    return principal;
  }
  #admin(actor: Actor): Principal {
    const principal = this.#principal(actor);
    check(principal.kind === 'admin', 'forbidden', 'Administrator required');
    return principal;
  }
  #bot(actor: Actor): Principal & { kind: 'agent' } {
    const principal = this.#principal(actor);
    check(principal.kind === 'agent', 'forbidden', 'Agent required');
    return principal;
  }
  #agent(id: string): Agent {
    check(typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id), 'forbidden', 'Invalid agent identity');
    const agent = this.#db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as unknown as Agent | undefined;
    check(agent, 'not_found', 'Agent not found');
    return agent;
  }
  #running(actor: Actor): Principal {
    const principal = this.#principal(actor);
    if (principal.kind === 'agent') check(!this.settings(actor).paused, 'forbidden', 'Runtime is paused');
    return principal;
  }
  #leader(actor: Actor): Principal {
    const principal = this.#bot(actor);
    check(this.#agent(principal.id).role === 'leader', 'forbidden', 'Leader required');
    return principal;
  }

  bootstrap(actor: Actor): Agent {
    this.#admin(actor);
    return transaction(this.#db, () => {
      const existing = this.#db.prepare("SELECT * FROM agents WHERE role = 'leader'").get() as unknown as Agent | undefined;
      if (existing) return existing;
      const id = randomUUID();
      // Provisional name/model preference only; catalog verification and persona dialogue follow later.
      this.#db.prepare('INSERT INTO agents VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, 'リーダー', 'leader', 'active', 'gpt-6-astra', 'low');
      return this.#agent(id);
    });
  }
  agents(actor: Actor): Agent[] {
    this.#principal(actor);
    return this.#db.prepare('SELECT * FROM agents ORDER BY rowid').all() as unknown as Agent[];
  }
  createAgent(actor: Actor, name: string): Agent {
    this.#leader(actor);
    this.#running(actor);
    text(name, 100);
    return transaction(this.#db, () => {
      const { count } = this.#db.prepare("SELECT count(*) AS count FROM agents WHERE role = 'member'").get() as { count: number };
      check(count < this.settings(actor).generatedLimit, 'limit', 'Generated agent limit reached');
      const id = randomUUID();
      this.#db.prepare('INSERT INTO agents VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, name, 'member', 'active', 'gpt-5.6-luna', 'max');
      return this.#agent(id);
    });
  }
  setDormant(actor: Actor, agentId: string, dormant: boolean): void {
    const principal = this.#principal(actor);
    if (principal.kind !== 'admin') { this.#leader(actor); this.#running(actor); }
    check(typeof dormant === 'boolean', 'invalid', 'Expected boolean');
    check(this.#agent(agentId).role !== 'leader', 'forbidden', 'Leader cannot be made dormant');
    this.#db.prepare('UPDATE agents SET status = ? WHERE id = ?').run(dormant ? 'dormant' : 'active', agentId);
  }

  settings(actor: Actor): Settings {
    this.#principal(actor);
    const row = this.#db.prepare('SELECT * FROM settings WHERE id = 1').get() as {
      paused: number; generated_limit: number; concurrency_limit: number | null; backup_days: number;
    };
    return { paused: row.paused === 1, generatedLimit: row.generated_limit,
      concurrencyLimit: row.concurrency_limit, backupDays: row.backup_days };
  }
  updateSettings(actor: Actor, patch: Partial<Settings>): Settings {
    this.#admin(actor);
    check(patch && typeof patch === 'object' && !Array.isArray(patch), 'invalid', 'Expected settings');
    const allowed = ['paused', 'generatedLimit', 'concurrencyLimit', 'backupDays'];
    check(Object.keys(patch).every(key => allowed.includes(key)), 'invalid', 'Unknown setting');
    return transaction(this.#db, () => {
      const next = { ...this.settings(actor), ...patch };
      check(typeof next.paused === 'boolean', 'invalid', 'Expected boolean');
      check(Number.isSafeInteger(next.generatedLimit) && next.generatedLimit >= 0, 'invalid', 'Invalid agent limit');
      check(next.concurrencyLimit === null || (Number.isSafeInteger(next.concurrencyLimit) && next.concurrencyLimit > 0),
        'invalid', 'Invalid concurrency limit');
      check(Number.isSafeInteger(next.backupDays) && next.backupDays > 0, 'invalid', 'Invalid backup days');
      this.#db.prepare('UPDATE settings SET paused=?, generated_limit=?, concurrency_limit=?, backup_days=? WHERE id=1')
        .run(Number(next.paused), next.generatedLimit, next.concurrencyLimit, next.backupDays);
      return next;
    });
  }

  /** A room is one UI thread. Private participants are immutable; admin always has access. */
  createRoom(actor: Actor, title: string, participants?: string[]): Room {
    const principal = this.#running(actor);
    text(title, 200);
    if (participants !== undefined) {
      check(Array.isArray(participants) && participants.length > 0 && participants.length <= 100,
        'invalid', 'Private rooms need participants');
      for (const id of participants) this.#agent(id);
      check(principal.kind === 'admin' || participants.includes(principal.id), 'forbidden', 'Creator must participate');
    }
    const room: Room = { id: randomUUID(), title, visibility: participants ? 'private' : 'shared' };
    return transaction(this.#db, () => {
      this.#db.prepare('INSERT INTO rooms VALUES (?, ?, ?)').run(room.id, title, room.visibility);
      for (const id of new Set(participants)) this.#db.prepare('INSERT INTO participants VALUES (?, ?)').run(room.id, id);
      return room;
    });
  }
  rooms(actor: Actor): Room[] {
    const principal = this.#principal(actor);
    return (principal.kind === 'admin'
      ? this.#db.prepare('SELECT * FROM rooms ORDER BY rowid').all()
      : this.#db.prepare(`SELECT * FROM rooms WHERE visibility = 'shared' OR id IN
          (SELECT room_id FROM participants WHERE agent_id = ?) ORDER BY rowid`).all(principal.id)) as unknown as Room[];
  }
  #room(actor: Actor, id: string): Room {
    const principal = this.#principal(actor);
    const room = this.#db.prepare('SELECT * FROM rooms WHERE id = ?').get(text(id, 100)) as unknown as Room | undefined;
    check(room && (principal.kind === 'admin' || room.visibility === 'shared'
      || this.#db.prepare('SELECT 1 FROM participants WHERE room_id = ? AND agent_id = ?').get(id, principal.id)),
    'forbidden', 'Room unavailable');
    return room;
  }
  post(actor: Actor, roomId: string, body: string): Message {
    const principal = this.#running(actor);
    this.#room(actor, roomId);
    text(body);
    const message: Message = { id: randomUUID(), room_id: roomId, author_id: principal.id, body, created_at: new Date().toISOString() };
    this.#db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?)')
      .run(message.id, roomId, message.author_id, body, message.created_at);
    return message;
  }
  messages(actor: Actor, roomId: string): Message[] {
    this.#room(actor, roomId);
    return this.#db.prepare('SELECT * FROM messages WHERE room_id = ? ORDER BY rowid').all(roomId) as unknown as Message[];
  }

  #memory(actor: Actor, agentId: string): DatabaseSync {
    const principal = this.#principal(actor);
    check(principal.kind === 'admin' || principal.id === agentId, 'forbidden', 'Private memory');
    this.#agent(agentId); // Registered server UUID only, before constructing a filesystem path.
    let db = this.#memories.get(agentId);
    if (!db) {
      db = openDatabase(join(this.#root, 'agents', agentId, 'memory.db'), memorySchema);
      this.#memories.set(agentId, db);
    }
    return db;
  }
  #audit(db: DatabaseSync, id: string, action: string, actorId: string, revision: number): void {
    db.prepare('INSERT INTO memory_audit(memory_id, action, actor_id, revision, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, action, actorId, revision, new Date().toISOString());
    db.exec('UPDATE memory_state SET revision = revision + 1 WHERE id = 1');
  }
  remember(actor: Actor, sourceMessageId: string, body: string): Memory {
    const principal = this.#bot(actor);
    this.#running(actor);
    text(body);
    const source = this.#db.prepare('SELECT * FROM messages WHERE id = ?').get(text(sourceMessageId, 100)) as unknown as Message | undefined;
    check(source, 'forbidden', 'Source unavailable');
    this.#room(actor, source.room_id);
    const db = this.#memory(actor, principal.id);
    return transaction(db, () => {
      const memory: Memory = { id: randomUUID(), body, source_message_id: source.id, source_room_id: source.room_id, revision: 1 };
      db.prepare('INSERT INTO memories VALUES (?, ?, ?, ?, ?)').run(memory.id, body, source.id, source.room_id, 1);
      this.#audit(db, memory.id, 'created', principal.id, 1);
      return memory;
    });
  }
  memories(actor: Actor, agentId: string, query = ''): Memory[] {
    const db = this.#memory(actor, agentId);
    check(typeof query === 'string' && query.length <= 200, 'invalid', 'Invalid search query');
    if (!query) return db.prepare('SELECT * FROM memories ORDER BY rowid').all() as unknown as Memory[];
    // Literal search supports short Japanese terms as well as trigram-indexed substrings.
    const escaped = query.replace(/[\\%_]/g, '\\$&');
    return db.prepare(`SELECT m.* FROM memories m JOIN memory_search s ON s.id = m.id
      WHERE s.body LIKE ? ESCAPE '\\' ORDER BY m.rowid`).all(`%${escaped}%`) as unknown as Memory[];
  }
  correctMemory(actor: Actor, agentId: string, id: string, revision: number, body: string): void {
    const principal = this.#admin(actor);
    text(body);
    const db = this.#memory(actor, agentId);
    transaction(db, () => {
      const result = db.prepare('UPDATE memories SET body = ?, revision = revision + 1 WHERE id = ? AND revision = ?')
        .run(body, text(id, 100), this.#revision(revision));
      check(result.changes === 1, 'conflict', 'Memory revision changed or memory was deleted');
      this.#audit(db, id, 'admin_corrected', principal.id, revision + 1);
    });
  }
  deleteMemory(actor: Actor, agentId: string, id: string, revision: number): void {
    const principal = this.#admin(actor);
    const db = this.#memory(actor, agentId);
    transaction(db, () => {
      const result = db.prepare('DELETE FROM memories WHERE id = ? AND revision = ?').run(text(id, 100), this.#revision(revision));
      check(result.changes === 1, 'conflict', 'Memory revision changed or memory was deleted');
      this.#audit(db, id, 'deleted', principal.id, revision + 1);
    });
  }
  #revision(value: number): number {
    check(Number.isSafeInteger(value) && value >= 1, 'invalid', 'Invalid revision');
    return value;
  }
  memoryAudit(actor: Actor, agentId: string): unknown[] {
    this.#admin(actor);
    return this.#memory(actor, agentId).prepare('SELECT * FROM memory_audit ORDER BY sequence').all();
  }
  context(actor: Actor, roomId: string): { memories: Memory[]; revision: number } {
    const principal = this.#bot(actor);
    this.#room(actor, roomId);
    const db = this.#memory(actor, principal.id);
    return transaction(db, () => {
      const memories = this.memories(actor, principal.id).filter(memory => {
        const sourceRoom = this.#room(actor, memory.source_room_id);
        return sourceRoom.visibility === 'shared' || sourceRoom.id === roomId;
      });
      const { revision } = db.prepare('SELECT revision FROM memory_state WHERE id = 1').get() as { revision: number };
      return { memories, revision };
    });
  }
  isContextCurrent(actor: Actor, revision: number): boolean {
    const principal = this.#bot(actor);
    const db = this.#memory(actor, principal.id);
    return (db.prepare('SELECT revision FROM memory_state WHERE id = 1').get() as { revision: number }).revision === revision;
  }
}
