import { createHash, randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { check, text, DomainError } from '../domain/types.ts';
import type { Agent, Room, Message, Memory, Settings } from '../domain/types.ts';
import { openDatabase, transaction } from '../storage/database.ts';
import { controlSchema, memoryMigrations } from '../storage/schema.ts';
import { taskSchema } from '../storage/task-schema.ts';
import { Tasks } from './tasks.ts';
import { Schedules } from './schedules.ts';
import { scheduleSchema } from '../storage/schedule-schema.ts';
import { submissionSchema } from '../storage/submission-schema.ts';
import { modelSchema } from '../storage/model-schema.ts';
import { fallbackSchema } from '../storage/fallback-schema.ts';
import { externalSchema } from '../storage/external-schema.ts';
import { historySearchSchema } from '../storage/history-search-schema.ts';
import { profileSchema as profileMigration } from '../storage/profile-schema.ts';
import { conversationSchema } from '../storage/conversation-schema.ts';
import { organizationSchema } from '../storage/organization-schema.ts';
import { taskControlSchema } from '../storage/task-control-schema.ts';
import { productivitySchema } from '../storage/productivity-schema.ts';
import { deletionSchema } from '../storage/deletion-schema.ts';
import { assertDirectoryPath } from '../config/paths.ts';
import { profileSchema } from '../domain/profile.ts';
import { Value } from '@sinclair/typebox/value';
import type { Task, TaskLease } from '../domain/task.ts';
import { summarySchema, type WorkSummary } from '../domain/summary.ts';
import { executeProcedure } from './procedures.ts';
import type { JsonObject } from '../contracts/model.ts';

declare const identity: unique symbol;
/** Opaque in-process capability; never construct this from HTTP or tool arguments. */
export type Actor = { readonly [identity]: true };
type Principal = { kind: 'admin'; id: 'administrator' } | { kind: 'agent'; id: string };

/** Trusted application service. Do not expose this object to generated code or models. */
export class Runtime {
  readonly tasks: Tasks;
  readonly schedules: Schedules;
  #db: DatabaseSync;
  #root: string;
  #identities = new WeakMap<Actor, Principal>();
  #memories = new Map<string, DatabaseSync>();
  #closed = false;

  constructor(stateDirectory: string) {
    this.#root = resolve(stateDirectory);
    this.#db = openDatabase(join(this.#root, 'control.db'), [controlSchema, taskSchema, submissionSchema, modelSchema, profileMigration, conversationSchema, organizationSchema, taskControlSchema, productivitySchema, deletionSchema, fallbackSchema, externalSchema, historySearchSchema, scheduleSchema]);
    this.tasks = new Tasks(this.#db, {
      principal: actor => this.#principal(actor),
      room: (actor, id) => this.#room(actor, id),
      memory: (actor, id) => this.#memory(actor, id),
      participant: (agentId, roomId) => {
        const agent = this.#agent(agentId);
        const room = this.#db.prepare('SELECT visibility FROM rooms WHERE id=?').get(roomId);
        return agent.status === 'active' && (room?.visibility === 'shared'
          || !!this.#db.prepare('SELECT 1 FROM participants WHERE room_id=? AND agent_id=?').get(roomId, agentId));
      },
    });
    this.schedules = new Schedules(this.#db, this.tasks, actor => this.#admin(actor), (actor, agentId, roomId) => {
      this.#room(actor, roomId);
      check(!this.roomPreferences(actor, roomId).archived, 'conflict', 'Restore the archived room before scheduling');
      check(this.#agent(agentId).status === 'active', 'forbidden', 'Agent is dormant');
      this.#room(this.agentSession(agentId), roomId);
    });
  }

  close(): void {
    if (this.#closed) return;
    for (const db of this.#memories.values()) db.close();
    this.#db.close();
    this.#closed = true;
    this.#identities = new WeakMap();
  }
  /** The service lock excludes other hosts; synchronous execution pauses all application writes. */
  snapshot(actor: Actor, directory: string): string[] {
    this.#admin(actor); assertDirectoryPath(directory);
    mkdirSync(directory, { mode: 0o700 });
    const databases = [['control.db', this.#db] as const, ...this.agents(actor).map(agent =>
      [`agents/${agent.id}/memory.db`, this.#memory(actor, agent.id)] as const)];
    for (const [name, db] of databases) {
      const target = join(directory, name);
      mkdirSync(resolve(target, '..'), { recursive: true, mode: 0o700 });
      closeSync(openSync(target, 'wx', 0o600));
      db.prepare('VACUUM INTO ?').run(target);
    }
    return databases.map(([name]) => name);
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
      this.#db.prepare('INSERT INTO agents(id,name,role,status,model,reasoning) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, 'リーダー', 'leader', 'active', 'gpt-6-astra', 'low');
      return this.#agent(id);
    });
  }
  agents(actor: Actor): Agent[] {
    this.#principal(actor);
    return this.#db.prepare('SELECT * FROM agents ORDER BY rowid').all() as unknown as Agent[];
  }
  invalidateProvider(actor: Actor, provider: Agent['provider']): void {
    this.#admin(actor);
    for (const agent of this.agents(actor)) if (agent.provider === provider) this.#interruptTasks(agent.id);
  }
  profile(actor: Actor, agentId: string): Record<string, string> {
    const principal = this.#principal(actor); this.#agent(agentId);
    check(principal.kind === 'admin' || principal.id === agentId, 'forbidden', 'Private profile');
    const row = this.#db.prepare('SELECT profile FROM agent_profiles WHERE agent_id=?').get(agentId);
    return row ? JSON.parse(row.profile as string) as Record<string, string> : {};
  }
  updateProfile(actor: Actor, agentId: string, patch: Record<string, unknown>): void {
    this.#admin(actor); this.#agent(agentId);
    check(Value.Check(profileSchema, patch), 'invalid', 'Invalid profile');
    this.#writeProfile(actor, agentId, patch, true);
  }
  updateOwnProfile(actor: Actor, name: string, persona: string): void {
    const principal = this.#bot(actor); this.#running(actor);
    this.#writeProfile(actor, principal.id, { name: text(name, 100), persona: text(persona, 10_000) }, false);
  }
  #writeProfile(actor: Actor, agentId: string, patch: Record<string, unknown>, interrupt: boolean): void {
    transaction(this.#db, () => {
      const { name, ...details } = patch;
      if (name !== undefined) this.#db.prepare('UPDATE agents SET name=? WHERE id=?').run(text(name, 100), agentId);
      const next = { ...this.profile(actor, agentId), ...details };
      this.#db.prepare('INSERT INTO agent_profiles VALUES (?,?) ON CONFLICT(agent_id) DO UPDATE SET profile=excluded.profile').run(agentId, JSON.stringify(next));
      if (interrupt) this.#interruptTasks(agentId);
    });
  }
  createAgent(actor: Actor, name: string): Agent {
    this.#leader(actor);
    this.#running(actor);
    text(name, 100);
    return transaction(this.#db, () => {
      const { count } = this.#db.prepare("SELECT count(*) AS count FROM agents WHERE role = 'member'").get() as { count: number };
      check(count < this.settings(actor).generatedLimit, 'limit', 'Generated agent limit reached');
      const id = randomUUID();
      this.#db.prepare('INSERT INTO agents(id,name,role,status,model,reasoning) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, name, 'member', 'active', 'gpt-5.6-luna', 'max');
      return this.#agent(id);
    });
  }
  setDormant(actor: Actor, agentId: string, dormant: boolean): void {
    const principal = this.#principal(actor);
    if (principal.kind !== 'admin') { this.#leader(actor); this.#running(actor); }
    check(typeof dormant === 'boolean', 'invalid', 'Expected boolean');
    check(this.#agent(agentId).role !== 'leader', 'forbidden', 'Leader cannot be made dormant');
    transaction(this.#db, () => {
      this.#db.prepare('UPDATE agents SET status = ? WHERE id = ?').run(dormant ? 'dormant' : 'active', agentId);
      if (dormant) this.#interruptTasks(agentId);
    });
  }

  #interruptTasks(agentId?: string): void {
    const condition = agentId === undefined ? "state='running'" : "state='running' AND agent_id=?";
    const args = agentId === undefined ? [] : [agentId];
    this.#db.prepare(`INSERT INTO task_events(task_id,kind,created_at) SELECT id,'interrupted',? FROM tasks WHERE ${condition}`).run(Date.now(), ...args);
    this.#db.prepare(`UPDATE tasks SET state='queued',lease_token=NULL,updated_at=? WHERE ${condition}`).run(Date.now(), ...args);
  }

  modelSettings(actor: Actor): { ollamaUrl: string | null; fallbackModel: string | null } {
    this.#admin(actor);
    const row = this.#db.prepare('SELECT ollama_url,fallback_model FROM model_settings WHERE id=1').get()!;
    return { ollamaUrl: row.ollama_url as string | null, fallbackModel: row.fallback_model as string | null };
  }
  /** Host must verify local model capabilities against this exact endpoint before saving. */
  configureFallback(actor: Actor, url: string, model: string | null): void {
    this.#admin(actor);
    check(this.modelSettings(actor).ollamaUrl === url, 'conflict', 'Ollama configuration changed during discovery');
    if (model !== null) text(model, 256);
    this.#db.prepare('UPDATE model_settings SET fallback_model=? WHERE id=1').run(model);
  }
  configureOllama(actor: Actor, url: string | null): void {
    this.#admin(actor);
    if (url !== null) {
      text(url, 2048);
      let parsed: URL;
      try { parsed = new URL(url); } catch { throw new DomainError('invalid', 'Invalid Ollama URL'); }
      check(['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password && !parsed.search && !parsed.hash, 'invalid', 'Invalid Ollama URL');
    }
    transaction(this.#db, () => {
      this.#db.prepare('UPDATE model_settings SET fallback_model=CASE WHEN ollama_url IS ? THEN fallback_model ELSE NULL END,ollama_url=? WHERE id=1').run(url, url);
      this.#interruptTasks();
    });
  }
  /** The host verifies selection capabilities before invoking this persistence operation. */
  setAgentModel(actor: Actor, agentId: string, provider: Agent['provider'], model: string, reasoning: string): Agent {
    this.#admin(actor); this.#agent(agentId);
    check(provider === 'openai_subscription' || provider === 'ollama', 'invalid', 'Invalid provider');
    text(model, 256); text(reasoning, 64);
    return transaction(this.#db, () => {
      this.#db.prepare('UPDATE agents SET provider=?,model=?,reasoning=? WHERE id=?').run(provider, model, reasoning, agentId);
      this.#interruptTasks(agentId);
      return this.#agent(agentId);
    });
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
      if (next.paused) this.#interruptTasks();
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
  participants(actor: Actor, roomId: string): string[] {
    const room = this.#room(actor, roomId);
    if (room.visibility === 'shared') return this.agents(actor).map(agent => agent.id);
    return (this.#db.prepare('SELECT agent_id FROM participants WHERE room_id=?').all(roomId) as { agent_id: string }[]).map(row => row.agent_id);
  }
  roomPreferences(actor: Actor, roomId: string): { pinned: boolean; archived: boolean } {
    this.#admin(actor); this.#room(actor, roomId);
    const row = this.#db.prepare('SELECT pinned,archived FROM room_preferences WHERE room_id=?').get(roomId);
    return { pinned: row?.pinned === 1, archived: row?.archived === 1 };
  }
  createArtifact(actor: Actor, roomId: string, name: string, kind: string, description: string, content: string, taskId?: string): string {
    const principal = this.#bot(actor); this.#running(actor); this.#room(actor, roomId);
    text(name, 200); text(kind, 50); text(description, 1000); text(content, 100_000);
    check(!/[\\/\x00-\x1f]/.test(name), 'invalid', 'Use a filename without directories');
    return transaction(this.#db, () => {
      const id = randomUUID();
      this.#db.prepare('INSERT INTO artifacts VALUES (?,?,?,?,?,?,?,?)').run(id, roomId, principal.id, name, kind, description, content, Date.now());
      this.reportUpdate(actor, roomId, 'done', `${name}ができました`, description, taskId, id);
      return id;
    });
  }
  artifacts(actor: Actor): Record<string, unknown>[] {
    const rooms = new Set(this.rooms(actor).map(room => room.id));
    return this.#db.prepare('SELECT id,room_id,author_id,name,kind,description,created_at FROM artifacts ORDER BY created_at DESC').all().filter(row => rooms.has(row.room_id as string));
  }
  artifact(actor: Actor, id: string): Record<string, unknown> {
    const row = this.#db.prepare('SELECT * FROM artifacts WHERE id=?').get(text(id, 100));
    check(row, 'not_found', 'Artifact not found'); this.#room(actor, row.room_id as string);
    return row;
  }
  reportUpdate(actor: Actor, roomId: string, kind: 'done' | 'decision' | 'question', title: string, detail: string, taskId?: string, artifactId?: string): void {
    const principal = this.#bot(actor); this.#running(actor); this.#room(actor, roomId);
    check(['done', 'decision', 'question'].includes(kind), 'invalid', 'Invalid update kind'); text(title, 200); text(detail);
    if (taskId) check(this.tasks.get(actor, taskId).room_id === roomId, 'forbidden', 'Task belongs to another room');
    if (artifactId) check(this.artifact(actor, artifactId).room_id === roomId, 'forbidden', 'Artifact belongs to another room');
    this.#db.prepare('INSERT INTO updates(room_id,author_id,kind,title,detail,task_id,artifact_id,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(roomId, principal.id, kind, title, detail, taskId ?? null, artifactId ?? null, Date.now());
  }
  updates(actor: Actor): Record<string, unknown>[] {
    this.#admin(actor);
    return this.#db.prepare('SELECT * FROM updates ORDER BY created_at DESC,id DESC').all();
  }
  readUpdates(actor: Actor, ids: number[]): void {
    this.#admin(actor); check(Array.isArray(ids) && ids.length <= 1000 && ids.every(id => Number.isSafeInteger(id) && id > 0), 'invalid', 'Invalid update ids');
    transaction(this.#db, () => { for (const id of ids) this.#db.prepare('UPDATE updates SET seen=1 WHERE id=?').run(id); });
  }
  organizeRoom(actor: Actor, roomId: string, patch: { pinned?: boolean; archived?: boolean }): void {
    this.#admin(actor); this.#room(actor, roomId);
    check(Object.entries(patch).every(([key, value]) => ['pinned', 'archived'].includes(key) && typeof value === 'boolean'), 'invalid', 'Invalid room preferences');
    const next = { ...this.roomPreferences(actor, roomId), ...patch };
    this.#db.prepare('INSERT INTO room_preferences VALUES (?,?,?) ON CONFLICT(room_id) DO UPDATE SET pinned=excluded.pinned,archived=excluded.archived')
      .run(roomId, Number(next.pinned), Number(next.archived));
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

  /** A browser retry must not post twice or start two jobs. Both records commit together. */
  createConversation(actor: Actor, id: string, title: string, body: string, participants?: string[], agentId?: string): { room: Room; message: Message; task: Task | null } {
    this.#admin(actor);
    check(typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id), 'invalid', 'Invalid conversation request id');
    text(title, 200); text(body);
    const hash = createHash('sha256').update(JSON.stringify([title, body, participants ?? null, agentId ?? null])).digest('hex');
    return transaction(this.#db, () => {
      const previous = this.#db.prepare('SELECT input_hash,room_id FROM conversation_requests WHERE id=?').get(id) as
        { input_hash: string; room_id: string } | undefined;
      if (previous) check(previous.input_hash === hash, 'conflict', 'Conversation request id was reused with different input');
      const room = previous ? this.#room(actor, previous.room_id) : this.createRoom(actor, title, participants);
      const submitted = this.submit(actor, id, room.id, body, agentId);
      if (!previous) this.#db.prepare('INSERT INTO conversation_requests VALUES (?,?,?)').run(id, hash, room.id);
      return { room, ...submitted };
    });
  }
  /** A browser retry must not post twice or start two jobs. Both records commit together. */
  submit(actor: Actor, id: string, roomId: string, body: string, agentId?: string): { message: Message; task: Task | null } {
    this.#admin(actor);
    check(typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id), 'invalid', 'Invalid submission id');
    text(body);
    const hash = createHash('sha256').update(JSON.stringify([roomId, body, agentId ?? null])).digest('hex');
    return transaction(this.#db, () => {
      const previous = this.#db.prepare('SELECT * FROM submissions WHERE id=?').get(id) as
        { input_hash: string; message_id: string; task_id: string | null } | undefined;
      if (previous) {
        check(previous.input_hash === hash, 'conflict', 'Submission id was reused with different input');
        const message = this.#db.prepare('SELECT * FROM messages WHERE id=?').get(previous.message_id) as unknown as Message;
        return { message, task: previous.task_id ? this.tasks.get(actor, previous.task_id) : null };
      }
      check(!this.roomPreferences(actor, roomId).archived, 'conflict', 'Restore the archived room before replying');
      const message = this.post(actor, roomId, body);
      const questions = agentId ? this.tasks.list(actor).filter(task => task.agent_id === agentId && task.room_id === roomId && task.state === 'waiting_user') : [];
      let task: Task | null = null;
      if (questions.length === 1) {
        this.tasks.resume(actor, questions[0]!.id, body);
        task = this.tasks.get(actor, questions[0]!.id);
      } else if (agentId) task = this.tasks.create(actor, agentId, roomId, body);
      this.#db.prepare('INSERT INTO submissions VALUES (?,?,?,?)').run(id, hash, message.id, task?.id ?? null);
      return { message, task };
    });
  }

  #memory(actor: Actor, agentId: string): DatabaseSync {
    const principal = this.#principal(actor);
    check(principal.kind === 'admin' || principal.id === agentId, 'forbidden', 'Private memory');
    this.#agent(agentId); // Registered server UUID only, before constructing a filesystem path.
    let db = this.#memories.get(agentId);
    if (!db) {
      db = openDatabase(join(this.#root, 'agents', agentId, 'memory.db'), memoryMigrations);
      this.#memories.set(agentId, db);
    }
    return db;
  }
  #audit(db: DatabaseSync, id: string, action: string, actorId: string, revision: number): void {
    db.prepare('INSERT INTO memory_audit(memory_id, action, actor_id, revision, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, action, actorId, revision, new Date().toISOString());
    // New memories are picked up on the next turn. Corrections/deletions invalidate old generated output.
    if (action !== 'created') db.exec('UPDATE memory_state SET revision = revision + 1 WHERE id = 1');
  }
  remember(actor: Actor, sourceMessageId: string, body: string, operationId?: string): Memory {
    const principal = this.#bot(actor);
    this.#running(actor);
    text(body);
    const source = this.#db.prepare('SELECT * FROM messages WHERE id = ?').get(text(sourceMessageId, 100)) as unknown as Message | undefined;
    check(source, 'forbidden', 'Source unavailable');
    this.#room(actor, source.room_id);
    const db = this.#memory(actor, principal.id);
    return transaction(db, () => {
      const id = operationId === undefined ? randomUUID() : createHash('sha256').update(text(operationId, 200)).digest('hex');
      if (operationId !== undefined) {
        check(!this.#db.prepare('SELECT 1 FROM deletion_records WHERE agent_id=? AND memory_id=?').get(principal.id, id), 'conflict', 'This memory was deleted');
        const existing = db.prepare('SELECT * FROM memories WHERE id=?').get(id) as unknown as Memory | undefined;
        if (existing) return existing;
        check(!db.prepare('SELECT 1 FROM memory_audit WHERE memory_id=?').get(id), 'conflict', 'This memory was deleted');
      }
      const memory: Memory = { id, body, source_message_id: source.id, source_room_id: source.room_id, revision: 1 };
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
  deletionRecords(actor: Actor): { agent_id: string; memory_id: string; revision: number }[] {
    this.#admin(actor);
    const records = this.#db.prepare('SELECT * FROM deletion_records').all() as { agent_id: string; memory_id: string; revision: number }[];
    for (const agent of this.agents(actor)) {
      const rows = this.#memory(actor, agent.id).prepare("SELECT memory_id,max(revision) AS revision FROM memory_audit WHERE action='deleted' GROUP BY memory_id").all() as { memory_id: string; revision: number }[];
      records.push(...rows.map(row => ({ agent_id: agent.id, ...row })));
    }
    return records;
  }
  /** Restore preparation only. Preserve even records for bots absent from this older snapshot. */
  applyDeletions(actor: Actor, records: ReturnType<Runtime['deletionRecords']>): void {
    this.#admin(actor);
    const agents = new Set(this.agents(actor).map(agent => agent.id));
    for (const record of records) {
      text(record.agent_id, 100); text(record.memory_id, 100); this.#revision(record.revision);
      this.#db.prepare('INSERT INTO deletion_records VALUES (?,?,?) ON CONFLICT(agent_id,memory_id) DO UPDATE SET revision=max(revision,excluded.revision)')
        .run(record.agent_id, record.memory_id, record.revision);
      if (!agents.has(record.agent_id)) continue;
      const db = this.#memory(actor, record.agent_id);
      transaction(db, () => {
        db.prepare('DELETE FROM memories WHERE id=?').run(record.memory_id);
        db.exec("UPDATE memory_state SET revision=revision+1 WHERE id=1; UPDATE task_steps SET discarded=1,events='[]';");
      });
    }
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
  searchHistory(actor: Actor, roomId: string, query: string) {
    const principal = this.#bot(actor); this.#room(actor, roomId); text(query, 200);
    const rooms = this.rooms(actor).filter(room => room.visibility === 'shared' || room.id === roomId).map(room => room.id);
    const indexed = [...query].length >= 3;
    const match = indexed ? `"${query.replaceAll('"', '""')}"` : query;
    const entries = this.#db.prepare(`SELECT kind,source_id,room_id,body FROM history_search
      WHERE room_id IN (SELECT value FROM json_each(?)) AND ${indexed ? 'history_search MATCH ?' : 'instr(body,?)>0'}
      ORDER BY rowid DESC LIMIT 20`).all(JSON.stringify(rooms), match) as { kind: string; source_id: string; room_id: string; body: string }[];
    const memory = this.#memory(actor, principal.id);
    const memories = memory.prepare(`SELECT m.* FROM memories m JOIN memory_search s ON s.id=m.id
      WHERE m.source_room_id IN (SELECT value FROM json_each(?)) AND ${indexed ? 'memory_search MATCH ?' : 'instr(s.body,?)>0'}
      ORDER BY m.rowid DESC LIMIT 20`).all(JSON.stringify(rooms), match) as unknown as Memory[];
    const excerpt = (body: string) => {
      const start = Math.max(0, body.toLowerCase().indexOf(query.toLowerCase()) - 160);
      return { text: body.slice(start, start + 1000), truncated: start > 0 || body.length > start + 1000 };
    };
    const summaries: { kind: string; source_id: string; room_id: string; text: string; truncated: boolean }[] = [];
    const candidates = memory.prepare(`SELECT s.id FROM task_summaries s JOIN summary_search f ON f.id=s.id
      WHERE s.room_id IN (SELECT value FROM json_each(?)) AND ${indexed ? 'summary_search MATCH ?' : 'instr(f.body,?)>0'} ORDER BY s.created_at DESC,s.id`).all(JSON.stringify(rooms), match);
    for (const candidate of candidates) {
      const summary = this.#summary(actor, roomId, String(candidate.id));
      if (summary) summaries.push({ kind: 'summary', source_id: String(candidate.id), room_id: summary.room_id, ...excerpt(summary.body) });
      if (summaries.length >= 20) break;
    }
    return [...entries.map(entry => ({ kind: entry.kind, source_id: entry.source_id, room_id: entry.room_id, ...excerpt(entry.body) })), ...summaries,
      ...memories.map(item => ({ kind: 'memory', source_id: item.id, room_id: item.source_room_id, revision: item.revision,
        source_message_id: item.source_message_id, ...excerpt(item.body) }))];
  }
  readHistory(actor: Actor, roomId: string, kind: string, sourceId: string, offset = 0, revision: string | null = null) {
    const principal = this.#bot(actor); this.#room(actor, roomId); text(sourceId, 100);
    check(Number.isSafeInteger(offset) && offset >= 0 && (offset === 0 || revision !== null), 'invalid', 'Continuation requires a source revision');
    const queries: Record<string, string> = {
      message: 'SELECT room_id,body FROM messages WHERE id=?',
      task: "SELECT room_id,prompt || char(10) || coalesce(result,'') AS body FROM tasks WHERE id=?",
      task_reply: 'SELECT t.room_id,r.body FROM task_replies r JOIN tasks t ON t.id=r.task_id WHERE r.sequence=?',
      artifact: 'SELECT room_id,name || char(10) || description || char(10) || content AS body FROM artifacts WHERE id=?',
    };
    check(kind === 'memory' || kind === 'summary' || Object.hasOwn(queries, kind), 'invalid', 'Unknown source kind');
    const record = (kind === 'summary' ? this.#summary(actor, roomId, sourceId) : kind === 'memory'
      ? this.#memory(actor, principal.id).prepare('SELECT source_room_id AS room_id,body,revision FROM memories WHERE id=?').get(sourceId)
      : this.#db.prepare(queries[kind]!).get(sourceId)) as { room_id: string; body: string; revision?: number } | undefined;
    const allowed = this.rooms(actor).some(room => room.id === record?.room_id && (room.visibility === 'shared' || room.id === roomId));
    check(record && allowed, 'not_found', 'Source unavailable in this conversation');
    const current = createHash('sha256').update(JSON.stringify([kind, sourceId, record.room_id, record.body, record.revision ?? null])).digest('hex');
    check(revision === null || revision === current, 'conflict', 'Source changed; read it again from the beginning');
    check(offset <= record.body.length, 'invalid', 'Offset exceeds source length');
    const next = Math.min(offset + 20_000, record.body.length);
    return { kind, source_id: sourceId, room_id: record.room_id, revision: current, offset,
      text: record.body.slice(offset, next), next_offset: next < record.body.length ? next : null, untrusted: true };
  }
  saveSummary(actor: Actor, lease: TaskLease, operationId: string, summary: WorkSummary) {
    const principal = this.#bot(actor);
    check(this.tasks.active(actor, lease), 'conflict', 'Task is no longer active');
    const task = this.tasks.get(actor, lease.task.id); text(operationId, 200);
    check(Value.Check(summarySchema, summary), 'invalid', 'Invalid work summary');
    const body = JSON.stringify(summary); text(body, 16_000);
    for (const source of summary.sources) this.readHistory(actor, task.room_id, source.kind, source.source_id, 0, source.revision);
    const db = this.#memory(actor, principal.id), hash = createHash('sha256').update(body).digest('hex');
    return transaction(db, () => {
      const prior = db.prepare('SELECT revision,operation_id,input_hash FROM task_summaries WHERE id=?').get(task.id);
      if (prior?.operation_id === operationId) {
        check(prior.input_hash === hash, 'conflict', 'Summary operation input changed');
        return { id: task.id, revision: Number(prior.revision) };
      }
      const revision = Number(prior?.revision ?? 0) + 1;
      db.prepare(`INSERT INTO task_summaries VALUES (?,?,?,?,?,(SELECT revision FROM memory_state WHERE id=1),?,?,?)
        ON CONFLICT(id) DO UPDATE SET purpose=excluded.purpose,body=excluded.body,revision=excluded.revision,
          memory_revision=excluded.memory_revision,operation_id=excluded.operation_id,input_hash=excluded.input_hash,created_at=excluded.created_at`)
        .run(task.id, task.room_id, task.prompt, body, revision, operationId, hash, Date.now());
      return { id: task.id, revision };
    });
  }
  procedureTool(actor: Actor, lease: TaskLease, operationId: string, name: string, args: JsonObject): JsonObject {
    const principal = this.#bot(actor); this.#running(actor);
    check(this.tasks.active(actor, lease), 'conflict', 'Task is no longer active');
    const task = this.tasks.get(actor, lease.task.id); text(operationId, 180);
    return executeProcedure({
      db: this.#memory(actor, principal.id), task,
      rooms: this.rooms(actor).filter(room => room.visibility === 'shared' || room.id === task.room_id).map(room => room.id),
      readSource: (kind, id, revision) => this.readHistory(actor, task.room_id, kind, id, 0, revision),
      taskInfo: id => this.tasks.get(actor, id),
      updatePlan: (revision, remaining) => this.tasks.updatePlan(actor, lease, `${operationId}:plan`, revision, remaining),
    }, name, args, operationId);
  }
  /** Validate dependencies before returning derived text; summaries never become execution authority. */
  #summary(actor: Actor, roomId: string, id: string): { room_id: string; body: string; revision: number } | undefined {
    const principal = this.#bot(actor), db = this.#memory(actor, principal.id);
    const row = db.prepare('SELECT * FROM task_summaries WHERE id=?').get(id);
    if (!row || !this.rooms(actor).some(room => room.id === row.room_id && (room.visibility === 'shared' || room.id === roomId))) return undefined;
    try {
      const summary = JSON.parse(String(row.body)) as unknown;
      if (!Value.Check(summarySchema, summary) || !this.isContextCurrent(actor, Number(row.memory_revision))) throw new Error('Invalid summary');
      for (const source of summary.sources) this.readHistory(actor, roomId, source.kind, source.source_id, 0, source.revision);
      return { room_id: String(row.room_id), revision: Number(row.revision), body: JSON.stringify({
        purpose: row.purpose, ...summary, generated: true, task_id: id, task_state: this.tasks.get(actor, id).state, created_at: row.created_at,
      }) };
    } catch {
      db.prepare('DELETE FROM task_summaries WHERE id=?').run(id);
      return undefined;
    }
  }
}
