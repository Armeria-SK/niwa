import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { check, text } from '../domain/types.ts';
import type { Actor } from './runtime.ts';
import type { Task, TaskLease, TaskState, TaskEvent } from '../domain/task.ts';
import { isTerminal } from '../domain/task.ts';
import { transaction } from '../storage/database.ts';
import type { JsonObject, ModelEvent } from '../contracts/model.ts';

interface Access {
  principal(actor: Actor): { kind: 'admin' | 'agent'; id: string };
  room(actor: Actor, roomId: string): unknown;
  participant(agentId: string, roomId: string): boolean;
  memory(actor: Actor, agentId: string): DatabaseSync;
}
type RecordWithLease = Task & { lease_token: string | null };
const publicTask = ({ lease_token: _token, ...task }: RecordWithLease): Task => task;

export class Tasks {
  #db: DatabaseSync;
  #access: Access;
  constructor(db: DatabaseSync, access: Access) { this.#db = db; this.#access = access; }
  #admin(actor: Actor): void { check(this.#access.principal(actor).kind === 'admin', 'forbidden', 'Administrator required'); }
  #read(id: string): RecordWithLease {
    const task = this.#db.prepare('SELECT * FROM tasks WHERE id=?').get(text(id, 100)) as unknown as RecordWithLease | undefined;
    check(task, 'not_found', 'Task not found');
    return task;
  }
  get(actor: Actor, id: string): Task {
    this.#access.principal(actor);
    const task = this.#read(id);
    this.#access.room(actor, task.room_id);
    return publicTask(task);
  }
  list(actor: Actor): Task[] {
    this.#access.principal(actor);
    const records = this.#db.prepare('SELECT * FROM tasks ORDER BY created_at, rowid').all() as unknown as RecordWithLease[];
    return records.filter(task => { try { this.#access.room(actor, task.room_id); return true; } catch { return false; } }).map(publicTask);
  }
  create(actor: Actor, agentId: string, roomId: string, prompt: string, deadlineAt = Date.now() + 24 * 60 * 60_000): Task {
    const principal = this.#access.principal(actor);
    this.#access.room(actor, roomId);
    check(this.#access.participant(agentId, roomId), 'forbidden', 'Recipient cannot access this conversation');
    text(prompt);
    check(Number.isSafeInteger(deadlineAt) && deadlineAt > Date.now(), 'invalid', 'Task deadline must be in the future');
    return transaction(this.#db, () => {
      if (principal.kind === 'agent') check(!this.#paused(), 'forbidden', 'Runtime is paused');
      const id = randomUUID(); const now = Date.now();
      this.#db.prepare(`INSERT INTO tasks(id,agent_id,requester_id,room_id,prompt,state,deadline_at,created_at,updated_at)
        VALUES (?,?,?,?,?,'queued',?,?,?)`).run(id, agentId, principal.id, roomId, prompt, deadlineAt, now, now);
      this.#event(id, 'queued');
      return publicTask(this.#read(id));
    });
  }
  #paused(): boolean { return this.#db.prepare('SELECT paused FROM settings WHERE id=1').get()!.paused === 1; }
  #event(id: string, kind: string): void {
    this.#db.prepare('INSERT INTO task_events(task_id,kind,created_at) VALUES (?,?,?)').run(id, kind, Date.now());
  }
  #change(id: string, state: TaskState, result: string | null = null, reason: string | null = null): void {
    this.#db.prepare('UPDATE tasks SET state=?,result=?,wait_reason=?,updated_at=? WHERE id=?').run(state, result, reason, Date.now(), id);
    if (isTerminal(state)) this.#db.prepare('UPDATE tasks SET paused=0 WHERE id=?').run(id);
    if (state === 'completed') {
      const task = this.#read(id);
      this.#db.prepare("INSERT INTO updates(room_id,author_id,kind,title,detail,task_id,created_at) VALUES (?,?,'done',?,?,?,?)")
        .run(task.room_id, task.agent_id, task.prompt.slice(0, 200), result || '完了', id, Date.now());
    }
    this.#event(id, state);
  }
  /** Claims one task atomically; waiting parents consume no execution slot. */
  claim(actor: Actor, excludedAgents: ReadonlySet<string> = new Set()): TaskLease | undefined {
    this.#admin(actor);
    return transaction(this.#db, () => {
      this.expire(actor);
      if (this.#paused()) return undefined;
      const { concurrency_limit } = this.#db.prepare('SELECT concurrency_limit FROM settings WHERE id=1').get()!;
      const { count } = this.#db.prepare("SELECT count(*) AS count FROM tasks WHERE state='running'").get()!;
      if (typeof concurrency_limit === 'number' && Number(count) >= concurrency_limit) return undefined;
      const next = (this.#db.prepare(`SELECT t.id,t.agent_id FROM tasks t JOIN agents a ON a.id=t.agent_id
        WHERE t.state='queued' AND t.paused=0 AND a.status='active' AND NOT EXISTS
          (SELECT 1 FROM tasks running WHERE running.agent_id=t.agent_id AND running.state='running')
        ORDER BY t.created_at,t.rowid`).all() as { id: string; agent_id: string }[]).find(task => !excludedAgents.has(task.agent_id));
      if (!next) return undefined;
      const token = randomUUID();
      this.#db.prepare("UPDATE tasks SET lease_token=?,attempt=attempt+1 WHERE id=?").run(token, next.id);
      this.#change(next.id, 'running');
      return { task: publicTask(this.#read(next.id)), token };
    });
  }
  #owned(actor: Actor, lease: TaskLease, requireRunning = true): RecordWithLease {
    const principal = this.#access.principal(actor);
    const task = this.#read(lease.task.id);
    check(principal.kind === 'agent' && task.agent_id === principal.id, 'forbidden', 'Task belongs to another agent');
    check(task.lease_token === lease.token && !task.paused && (!requireRunning || task.state === 'running'), 'conflict', 'Task lease is no longer active');
    return task;
  }
  active(actor: Actor, lease: TaskLease): boolean {
    try { this.#owned(actor, lease); return true; } catch { return false; }
  }
  /** Fresh task-local facts for model input; never a replacement for lease/approval checks. */
  workState(actor: Actor, lease: TaskLease) {
    const task = this.#owned(actor, lease);
    this.#access.room(actor, task.room_id);
    const memory = this.#access.memory(actor, task.agent_id);
    const plan = memory.prepare('SELECT revision,remaining FROM task_plans WHERE task_id=? AND memory_revision=(SELECT revision FROM memory_state WHERE id=1)').get(task.id);
    return {
      task: publicTask(task), runtime_paused: this.#paused(),
      remaining_plan: { revision: plan ? Number(plan.revision) : 0, remaining: plan ? JSON.parse(String(plan.remaining)) as string[] : [] },
      applied_procedures: memory.prepare('SELECT procedure_id,revision,applicability FROM procedure_uses WHERE task_id=? ORDER BY created_at,operation_id').all(task.id),
      administrator_replies: this.#db.prepare('SELECT sequence,body,created_at FROM task_replies WHERE task_id=? ORDER BY sequence').all(task.id),
      child_results: this.#db.prepare('SELECT id AS task_id,agent_id,prompt,state,result,wait_reason FROM tasks WHERE parent_id=? AND room_id=? ORDER BY created_at,rowid').all(task.id, task.room_id),
      updates: this.#db.prepare('SELECT id,kind,title,detail,artifact_id FROM updates WHERE task_id=? AND room_id=? ORDER BY id').all(task.id, task.room_id),
      artifacts: this.#db.prepare(`SELECT DISTINCT a.id,a.name,a.kind,a.description FROM artifacts a
        JOIN updates u ON u.artifact_id=a.id WHERE u.task_id=? AND u.room_id=? AND a.room_id=? ORDER BY a.id`).all(task.id, task.room_id, task.room_id),
      external_operations: this.#db.prepare('SELECT operation_id,input_hash,execution_id,output FROM external_operations WHERE task_id=? ORDER BY operation_id').all(task.id)
        .map(row => ({ operation_id: row.operation_id, input_hash: row.input_hash, execution_id: row.execution_id,
          outcome: row.output === null ? 'unknown' : 'recorded', result: row.output === null ? null : JSON.parse(String(row.output)) as JsonObject })),
      saved_model_steps: memory.prepare('SELECT count(*) AS count FROM task_steps WHERE task_id=?').get(task.id)!.count,
    };
  }
  /** Planning notes are private, revisioned data, not execution or approval authority. */
  updatePlan(actor: Actor, lease: TaskLease, operationId: string, expectedRevision: number, remaining: string[]): JsonObject {
    const task = this.#owned(actor, lease); this.#access.room(actor, task.room_id); text(operationId, 200);
    check(Number.isSafeInteger(expectedRevision) && expectedRevision >= 0 && expectedRevision < Number.MAX_SAFE_INTEGER, 'invalid', 'Invalid plan revision');
    check(Array.isArray(remaining) && remaining.length <= 30, 'invalid', 'Invalid remaining steps');
    for (const item of remaining) text(item, 1000);
    const encoded = JSON.stringify(remaining);
    check(encoded.length <= 16_000, 'invalid', 'Remaining plan is too long');
    const hash = createHash('sha256').update(JSON.stringify([expectedRevision, remaining])).digest('hex');
    const db = this.#access.memory(actor, task.agent_id);
    return transaction(db, () => {
      const prior = db.prepare('SELECT revision,operation_id,input_hash FROM task_plans WHERE task_id=?').get(task.id);
      if (prior?.operation_id === operationId) {
        check(prior.input_hash === hash, 'conflict', 'Plan operation input changed');
        return { revision: Number(prior.revision) };
      }
      check(Number(prior?.revision ?? 0) === expectedRevision, 'conflict', 'Plan changed; read the current work state');
      const revision = expectedRevision + 1;
      db.prepare(`INSERT INTO task_plans VALUES (?,?,(SELECT revision FROM memory_state WHERE id=1),?,?,?)
        ON CONFLICT(task_id) DO UPDATE SET revision=excluded.revision,memory_revision=excluded.memory_revision,
          remaining=excluded.remaining,operation_id=excluded.operation_id,input_hash=excluded.input_hash`).run(task.id, revision, encoded, operationId, hash);
      return { revision };
    });
  }
  /** The executor must durably deduplicate executionId. Only hashes and outcomes are stored here. */
  async externalOnce(actor: Actor, lease: TaskLease, operationId: string, input: JsonObject,
    execute: (executionId: string) => Promise<JsonObject>): Promise<JsonObject> {
    const pending = transaction(this.#db, () => {
      this.#owned(actor, lease);
      const inputHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
      const prior = this.#db.prepare('SELECT input_hash,execution_id,output FROM external_operations WHERE task_id=? AND operation_id=?')
        .get(lease.task.id, operationId) as { input_hash: string; execution_id: string; output: string | null } | undefined;
      if (prior) { check(prior.input_hash === inputHash, 'conflict', 'External operation input changed'); return prior; }
      const record = { input_hash: inputHash, execution_id: randomUUID(), output: null };
      this.#db.prepare('INSERT INTO external_operations VALUES (?,?,?,?,NULL)').run(lease.task.id, operationId, inputHash, record.execution_id);
      return record;
    });
    if (pending.output !== null) return JSON.parse(pending.output) as JsonObject;
    let output: JsonObject;
    try { output = await execute(pending.execution_id); }
    catch { output = { error: 'outcome_unknown' }; }
    if (output.error === 'outcome_unknown') {
      if (this.active(actor, lease)) this.wait(actor, lease, 'waiting_user', '共有ファイルへの書込結果を確認できません。再開時に実行サービスの記録を照合します。');
    } else {
      // Completion can arrive after stop/cancellation. Record history without reactivating the task.
      this.#db.prepare('UPDATE external_operations SET output=? WHERE task_id=? AND operation_id=? AND execution_id=? AND output IS NULL')
        .run(JSON.stringify(output), lease.task.id, operationId, pending.execution_id);
    }
    return output;
  }
  /** Read-only external I/O may repeat after a crash before receipt commit; never use for external writes. */
  async readOnce(actor: Actor, lease: TaskLease, operationId: string, input: JsonObject, read: () => Promise<JsonObject>): Promise<JsonObject> {
    this.#owned(actor, lease);
    const encoded = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const existing = this.#db.prepare('SELECT input,output FROM tool_receipts WHERE task_id=? AND operation_id=?')
      .get(lease.task.id, operationId) as { input: string; output: string } | undefined;
    if (existing) {
      check(existing.input === encoded, 'conflict', 'Operation id was reused with different input');
      return JSON.parse(existing.output) as JsonObject;
    }
    const output = await read();
    return this.once(actor, lease, operationId, input, () => output);
  }
  /** Atomic receipts for trusted, synchronous internal operations. External I/O uses a separate outbox. */
  once(actor: Actor, lease: TaskLease, operationId: string, input: JsonObject, work: () => JsonObject): JsonObject {
    return transaction(this.#db, () => {
      this.#owned(actor, lease);
      const encoded = createHash('sha256').update(JSON.stringify(input)).digest('hex');
      const existing = this.#db.prepare('SELECT input,output FROM tool_receipts WHERE task_id=? AND operation_id=?')
        .get(lease.task.id, operationId) as { input: string; output: string } | undefined;
      if (existing) {
        check(existing.input === encoded, 'conflict', 'Operation id was reused with different input');
        return JSON.parse(existing.output) as JsonObject;
      }
      const output = work();
      this.#db.prepare('INSERT INTO tool_receipts VALUES (?,?,?,?)').run(lease.task.id, operationId, encoded, JSON.stringify(output));
      return output;
    });
  }
  steps(actor: Actor, id: string): { step: number; memory_revision: number; discarded: number; events: ModelEvent[] }[] {
    const task = this.get(actor, id);
    const db = this.#access.memory(actor, task.agent_id);
    const rows = db.prepare('SELECT step,memory_revision,discarded,events FROM task_steps WHERE task_id=? ORDER BY step').all(id) as { step: number; memory_revision: number; discarded: number; events: string }[];
    return rows.map(row => ({ ...row, events: JSON.parse(row.events) as ModelEvent[] }));
  }
  /** Read the current task's private transcript, never another task or a superseded memory revision. */
  readStep(actor: Actor, lease: TaskLease, step: number, offset = 0, revision: string | null = null): JsonObject {
    const task = this.#owned(actor, lease); this.#access.room(actor, task.room_id);
    check(Number.isSafeInteger(step) && step >= 0 && Number.isSafeInteger(offset) && offset >= 0, 'invalid', 'Invalid history position');
    check(revision === null || /^[a-f0-9]{64}$/.test(revision), 'invalid', 'Invalid history revision');
    check(offset === 0 || revision !== null, 'invalid', 'A revision is required for continuation');
    const db = this.#access.memory(actor, task.agent_id);
    const row = db.prepare(`SELECT events,memory_revision FROM task_steps WHERE task_id=? AND step=? AND discarded=0
      AND memory_revision=(SELECT revision FROM memory_state WHERE id=1)`).get(task.id, step);
    check(row, 'not_found', 'Task history is unavailable');
    const events = JSON.parse(String(row.events)) as ModelEvent[];
    const calls = events.filter((event): event is Extract<ModelEvent, { type: 'tool_call' }> => event.type === 'tool_call');
    const results = calls.map((call, index) => {
      const inputHash = createHash('sha256').update(JSON.stringify({ name: call.name, arguments: call.arguments })).digest('hex');
      const receipt = this.#db.prepare('SELECT input AS input_hash,output FROM tool_receipts WHERE task_id=? AND operation_id=?').get(task.id, `${step}:${index}`)
        ?? this.#db.prepare('SELECT input_hash,output FROM external_operations WHERE task_id=? AND operation_id=?').get(task.id, `${step}:${index}`);
      return { tool_call_id: call.tool_call_id, name: call.name,
        result: receipt?.input_hash === inputHash && receipt.output !== null ? JSON.parse(String(receipt.output)) as JsonObject : null };
    });
    const content = JSON.stringify({ events, tool_results: results });
    const current = createHash('sha256').update(JSON.stringify([task.agent_id, task.room_id, task.id, step, row.memory_revision, content])).digest('hex');
    check(revision === null || revision === current, 'conflict', 'Task history changed; read from the beginning');
    check(offset <= content.length, 'invalid', 'History offset is outside the source');
    const end = Math.min(offset + 20_000, content.length);
    return { task_id: task.id, step, revision: current, offset, text: content.slice(offset, end),
      next_offset: end < content.length ? end : null, untrusted: true };
  }
  saveStep(actor: Actor, lease: TaskLease, memoryRevision: number, events: readonly ModelEvent[]): number {
    const task = this.#owned(actor, lease);
    const db = this.#access.memory(actor, task.agent_id);
    return transaction(db, () => {
      const { next } = db.prepare('SELECT coalesce(max(step),-1)+1 AS next FROM task_steps WHERE task_id=?').get(lease.task.id) as { next: number };
      db.prepare('INSERT INTO task_steps(task_id,step,memory_revision,events) VALUES (?,?,?,?)').run(lease.task.id, next, memoryRevision, JSON.stringify(events));
      return next;
    });
  }
  discardStep(actor: Actor, lease: TaskLease, step: number): void {
    const task = this.#owned(actor, lease);
    // The text itself is dropped so it cannot become a future model context after a memory correction.
    this.#access.memory(actor, task.agent_id).prepare("UPDATE task_steps SET discarded=1,events='[]' WHERE task_id=? AND step=?").run(lease.task.id, step);
  }
  delegate(actor: Actor, lease: TaskLease, agentId: string, prompt: string): Task {
    return transaction(this.#db, () => {
      const parent = this.#owned(actor, lease);
      check(parent.agent_id !== agentId, 'invalid', 'Use the current task instead of delegating to yourself');
      const child = this.create(actor, agentId, parent.room_id, prompt, parent.deadline_at);
      this.#db.prepare('UPDATE tasks SET parent_id=? WHERE id=?').run(parent.id, child.id);
      this.#change(parent.id, 'waiting_child');
      return publicTask(this.#read(child.id));
    });
  }
  finish(actor: Actor, lease: TaskLease, result: string, state: 'completed' | 'failed' = 'completed'): Task {
    text(result);
    check(state === 'completed' || state === 'failed', 'invalid', 'Invalid terminal state');
    return transaction(this.#db, () => {
      const task = this.#owned(actor, lease, false);
      if (isTerminal(task.state)) {
        check(task.state === state && task.result === result, 'conflict', 'Task was already finished with another result');
        return publicTask(task);
      }
      check(task.state === 'running', 'conflict', 'Task is waiting');
      this.#change(task.id, state, result);
      this.#resumeParent(task.parent_id);
      return publicTask(this.#read(task.id));
    });
  }
  #resumeParent(parentId: string | null): void {
    if (!parentId || this.#read(parentId).state !== 'waiting_child') return;
    if (this.#db.prepare("SELECT 1 FROM tasks WHERE parent_id=? AND state NOT IN ('completed','failed','cancelled')").get(parentId)) return;
    this.#change(parentId, 'queued');
    this.#db.prepare('UPDATE tasks SET lease_token=NULL WHERE id=?').run(parentId);
  }
  wait(actor: Actor, lease: TaskLease, state: 'waiting_user' | 'waiting_provider', reason: string): void {
    check(state === 'waiting_user' || state === 'waiting_provider', 'invalid', 'Invalid wait state');
    text(reason, 1000);
    transaction(this.#db, () => { this.#owned(actor, lease); this.#change(lease.task.id, state, null, reason); });
  }
  resume(actor: Actor, id: string, answer?: string): void {
    this.#admin(actor);
    transaction(this.#db, () => {
      const task = this.#read(id);
      if (task.paused) {
        this.#db.prepare('UPDATE tasks SET paused=0,updated_at=? WHERE id=?').run(Date.now(), id);
        this.#event(id, 'resumed');
        return;
      }
      check(task.state === 'waiting_user' || task.state === 'waiting_provider', 'conflict', 'Task cannot be resumed');
      if (answer !== undefined) {
        this.#db.prepare('INSERT INTO task_replies(task_id,body,created_at) VALUES (?,?,?)').run(id, text(answer), Date.now());
        this.#access.memory(actor, task.agent_id).prepare('DELETE FROM task_plans WHERE task_id=?').run(id);
        this.#access.memory(actor, task.agent_id).prepare('DELETE FROM task_summaries WHERE id=?').run(id);
      }
      this.#change(id, 'queued');
      this.#db.prepare('UPDATE tasks SET lease_token=NULL WHERE id=?').run(id);
    });
  }
  pause(actor: Actor, id: string): void {
    this.#admin(actor);
    transaction(this.#db, () => {
      const task = this.#read(id);
      check(!isTerminal(task.state), 'conflict', 'Task has finished');
      if (task.paused) return;
      if (task.state === 'running') this.#change(id, 'queued');
      this.#db.prepare('UPDATE tasks SET paused=1,lease_token=NULL,updated_at=? WHERE id=?').run(Date.now(), id);
      this.#event(id, 'paused');
    });
  }
  instruct(actor: Actor, id: string, body: string): void {
    this.#admin(actor); text(body);
    transaction(this.#db, () => {
      const task = this.#read(id);
      check(!['completed', 'cancelled'].includes(task.state), 'conflict', 'Task has finished');
      // Drop unfinished model plans; completed tool receipts remain to prevent their replay.
      this.#access.memory(actor, task.agent_id).prepare("UPDATE task_steps SET discarded=1,events='[]' WHERE task_id=?").run(id);
      this.#access.memory(actor, task.agent_id).prepare('DELETE FROM task_plans WHERE task_id=?').run(id);
      this.#access.memory(actor, task.agent_id).prepare('DELETE FROM task_summaries WHERE id=?').run(id);
      this.#db.prepare('INSERT INTO task_replies(task_id,body,created_at) VALUES (?,?,?)').run(id, body, Date.now());
      if (task.state === 'running') {
        this.#change(id, 'queued');
        this.#db.prepare('UPDATE tasks SET lease_token=NULL WHERE id=?').run(id);
      }
      this.#event(id, 'instructed');
    });
  }
  retry(actor: Actor, id: string): void {
    this.#admin(actor);
    transaction(this.#db, () => {
      const task = this.#read(id);
      check(['failed', 'cancelled'].includes(task.state), 'conflict', 'Task cannot be retried');
      check(!task.parent_id || this.#read(task.parent_id).state === 'waiting_child', 'conflict', 'Parent has already continued; submit a new request');
      this.#db.prepare('UPDATE tasks SET paused=0,lease_token=NULL,deadline_at=? WHERE id=?').run(Date.now() + 24 * 60 * 60_000, id);
      this.#change(id, 'queued');
      this.#event(id, 'retried');
    });
  }
  complete(actor: Actor, id: string): void {
    this.#admin(actor);
    transaction(this.#db, () => {
      const task = this.#read(id);
      check(task.state === 'running' || task.state === 'queued', 'conflict', 'Task cannot be completed');
      this.#db.prepare('UPDATE tasks SET paused=0,lease_token=NULL WHERE id=?').run(id);
      this.#change(id, 'completed', '管理者が完了にしました');
      this.#resumeParent(task.parent_id);
    });
  }
  replies(actor: Actor, id: string): { body: string; created_at: number }[] {
    this.get(actor, id);
    return this.#db.prepare('SELECT body,created_at FROM task_replies WHERE task_id=? ORDER BY sequence').all(id) as { body: string; created_at: number }[];
  }
  cancel(actor: Actor, id: string): void {
    const principal = this.#access.principal(actor);
    const task = this.#read(id);
    this.#access.room(actor, task.room_id);
    check(principal.kind === 'admin' || principal.id === task.requester_id || principal.id === task.agent_id, 'forbidden', 'Cannot cancel another task');
    transaction(this.#db, () => { this.#cancelTree(id); this.#resumeParent(task.parent_id); });
  }
  #cancelTree(id: string): void {
    const descendants = this.#db.prepare('SELECT id FROM tasks WHERE parent_id=?').all(id) as { id: string }[];
    for (const child of descendants) this.#cancelTree(child.id);
    if (!isTerminal(this.#read(id).state)) this.#change(id, 'cancelled', 'Cancelled');
  }
  expire(actor: Actor, now = Date.now()): void {
    this.#admin(actor);
    transaction(this.#db, () => {
      const expired = this.#db.prepare("SELECT * FROM tasks WHERE deadline_at<=? AND state NOT IN ('completed','failed','cancelled')").all(now) as unknown as Task[];
      for (const task of expired) this.#change(task.id, 'failed', 'Task deadline exceeded');
      for (const task of expired) this.#resumeParent(task.parent_id);
    });
  }
  /** Requeue only the host's still-current lease during graceful shutdown. */
  interrupt(actor: Actor, lease: TaskLease): void {
    this.#admin(actor);
    transaction(this.#db, () => {
      const task = this.#read(lease.task.id);
      if (task.state !== 'running' || task.lease_token !== lease.token) return;
      this.#change(task.id, 'queued');
      this.#db.prepare('UPDATE tasks SET lease_token=NULL WHERE id=?').run(task.id);
    });
  }
  /** Call once on service startup after obtaining its exclusive process lock. */
  recover(actor: Actor): void {
    this.#admin(actor);
    transaction(this.#db, () => {
      const interrupted = this.#db.prepare("SELECT id FROM tasks WHERE state='running'").all() as { id: string }[];
      for (const task of interrupted) {
        this.#change(task.id, 'queued');
        this.#db.prepare('UPDATE tasks SET lease_token=NULL WHERE id=?').run(task.id);
      }
      this.expire(actor);
    });
  }
  events(actor: Actor, after = 0): TaskEvent[] {
    check(Number.isSafeInteger(after) && after >= 0, 'invalid', 'Invalid event cursor');
    const allowed = new Set(this.list(actor).map(task => task.id));
    return (this.#db.prepare('SELECT * FROM task_events WHERE sequence>? ORDER BY sequence').all(after) as unknown as TaskEvent[])
      .filter(event => allowed.has(event.task_id));
  }
}
