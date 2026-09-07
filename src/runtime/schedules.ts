import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { check, text } from '../domain/types.ts';
import { transaction } from '../storage/database.ts';
import type { Actor } from './runtime.ts';
import type { Tasks } from './tasks.ts';

export interface ScheduleInput {
  id: string; agent_id: string; room_id: string; prompt: string;
  interval_ms: number; next_at: number; max_runs: number; timeout_ms: number;
  max_model_calls?: number;
  trigger_kind?: 'interval' | 'shared_changes';
  autonomous?: boolean;
}
interface Schedule extends Omit<ScheduleInput, 'autonomous'> { autonomous: number; source_revision: string; max_model_calls: number; model_calls: number; enabled: number; run_count: number; failure_reset: number; wait_reason: string | null }

/** Administrator-owned triggers; each occurrence and its task commit together. */
export class Schedules {
  constructor(private db: DatabaseSync, private tasks: Tasks, private admin: (actor: Actor) => unknown,
    private recipient: (actor: Actor, agentId: string, roomId: string) => void) {}

  list(actor: Actor): Schedule[] {
    this.admin(actor);
    return this.db.prepare(`SELECT id,agent_id,room_id,prompt,interval_ms,next_at,max_runs,timeout_ms,
      enabled,run_count,failure_reset,wait_reason,max_model_calls,model_calls,trigger_kind,source_revision,autonomous FROM schedules WHERE deleted=0 ORDER BY rowid`).all() as unknown as Schedule[];
  }
  private sourceRevision(agentId: string, roomId: string): string {
    const messages = this.db.prepare('SELECT id,author_id,body FROM messages WHERE room_id=? AND author_id<>? ORDER BY id').all(roomId, agentId);
    return createHash('sha256').update(JSON.stringify(messages)).digest('hex');
  }
  create(actor: Actor, input: ScheduleInput): Schedule {
    this.admin(actor);
    check(typeof input.id === 'string' && /^[0-9a-f-]{36}$/.test(input.id), 'invalid', 'Invalid schedule id');
    text(input.prompt);
    for (const [value, min, max] of [[input.interval_ms, 60_000, 365 * 86400_000],
      [input.next_at, 0, 8_000_000_000_000_000], [input.max_runs, 1, 10_000], [input.timeout_ms, 60_000, 86400_000]]) {
      check(Number.isSafeInteger(value) && value! >= min! && value! <= max!, 'invalid', 'Invalid schedule bounds');
    }
    const maxCalls = input.max_model_calls ?? input.max_runs * 24;
    const trigger = input.trigger_kind ?? 'interval';
    check(input.autonomous === undefined || typeof input.autonomous === 'boolean', 'invalid', 'Invalid autonomy mode');
    check(trigger === 'interval' || trigger === 'shared_changes', 'invalid', 'Invalid schedule trigger');
    check(Number.isSafeInteger(maxCalls) && maxCalls > 0 && maxCalls <= 1_000_000, 'invalid', 'Invalid model call limit');
    const hash = createHash('sha256').update(JSON.stringify([input.agent_id, input.room_id, input.prompt,
      input.interval_ms, input.next_at, input.max_runs, input.timeout_ms,
      ...(input.max_model_calls === undefined ? [] : [input.max_model_calls]), ...(trigger === 'interval' ? [] : [trigger]), ...(input.autonomous ? ['autonomous'] : [])])).digest('hex');
    return transaction(this.db, () => {
      const prior = this.db.prepare('SELECT input_hash,deleted FROM schedules WHERE id=?').get(input.id);
      check(!prior?.deleted, 'conflict', 'Schedule was deleted');
      if (prior) check(prior.input_hash === hash, 'conflict', 'Schedule id already used with different input');
      else {
        this.recipient(actor, input.agent_id, input.room_id);
        if (trigger === 'shared_changes' || input.autonomous) check(this.db.prepare('SELECT visibility FROM rooms WHERE id=?').get(input.room_id)!.visibility === 'shared', 'forbidden', 'Automatic participation requires a shared room');
        check(input.next_at >= Date.now(), 'invalid', 'First occurrence must be in the future');
        this.db.prepare(`INSERT INTO schedules(id,agent_id,room_id,prompt,interval_ms,next_at,max_runs,timeout_ms,input_hash,max_model_calls,trigger_kind,source_revision,autonomous)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(input.id, input.agent_id, input.room_id, input.prompt,
          input.interval_ms, input.next_at, input.max_runs, input.timeout_ms, hash, maxCalls, trigger,
          trigger === 'shared_changes' ? this.sourceRevision(input.agent_id, input.room_id) : '', Number(input.autonomous ?? false));
      }
      return this.list(actor).find(row => row.id === input.id)!;
    });
  }
  setEnabled(actor: Actor, id: string, enabled: boolean): void {
    this.admin(actor); text(id, 100); check(typeof enabled === 'boolean', 'invalid', 'Invalid enabled state');
    const row = this.list(actor).find(item => item.id === id);
    check(row, 'not_found', 'Schedule not found');
    if (enabled) {
      check(row.run_count < row.max_runs, 'limit', 'Schedule run limit reached');
      check(row.model_calls < row.max_model_calls, 'limit', 'Schedule model call limit reached');
      this.recipient(actor, row.agent_id, row.room_id);
    }
    this.db.prepare('UPDATE schedules SET enabled=?,wait_reason=NULL,failure_reset=run_count WHERE id=?').run(Number(enabled), id);
  }
  remove(actor: Actor, id: string): void {
    this.admin(actor); text(id, 100);
    // Keep identity/budget links for existing jobs and reject late creation retries.
    const result = this.db.prepare("UPDATE schedules SET deleted=1,enabled=0,prompt='',source_revision='',wait_reason=NULL WHERE id=?").run(id);
    check(result.changes > 0, 'not_found', 'Schedule not found');
  }
  dispatch(actor: Actor, now = Date.now()): void {
    this.admin(actor);
    check(Number.isSafeInteger(now) && now >= 0 && now <= 8_000_000_000_000_000, 'invalid', 'Invalid clock');
    transaction(this.db, () => {
      if (this.db.prepare('SELECT paused FROM settings WHERE id=1').get()!.paused === 1) return;
      for (const row of this.list(actor).filter(item => item.enabled)) {
        const recent = this.db.prepare(`SELECT t.id,t.state FROM schedule_runs r JOIN tasks t ON t.id=r.task_id
          WHERE r.schedule_id=? ORDER BY r.scheduled_at DESC LIMIT 3`).all(row.id);
        if (this.db.prepare(`SELECT 1 FROM schedule_runs r JOIN tasks t ON t.id=r.task_id
          WHERE r.schedule_id=? AND t.state NOT IN ('completed','failed','cancelled') LIMIT 1`).get(row.id)) continue;
        let reason: string | null = row.run_count >= row.max_runs ? '起動回数の上限に達しました。' : null;
        if (row.model_calls >= row.max_model_calls) reason = '定期実行のモデル呼び出し上限に達しました。';
        if (row.run_count - row.failure_reset >= 3 && recent.length === 3 && recent.every(task => task.state !== 'completed'))
          reason = '3回続けて完了しなかったため、定期実行を停止しました。';
        if (reason) {
          this.db.prepare('UPDATE schedules SET enabled=0,wait_reason=? WHERE id=?').run(reason, row.id);
          this.db.prepare(`INSERT INTO updates(room_id,author_id,kind,title,detail,task_id,created_at)
            VALUES (?,?,?,?,?,?,?)`).run(row.room_id, row.agent_id, row.run_count >= row.max_runs ? 'decision' : 'question',
            `定期実行を停止：${row.prompt.slice(0, 180)}`, reason, recent[0]?.id ?? null, Date.now());
          continue;
        }
        if (row.next_at > now) continue;
        // Dormancy or revoked room access leaves the occurrence pending without creating a task.
        try { this.recipient(actor, row.agent_id, row.room_id); } catch { continue; }
        if (row.autonomous && this.db.prepare('SELECT visibility FROM rooms WHERE id=?').get(row.room_id)!.visibility !== 'shared') continue;
        const next = row.next_at + (Math.floor((now - row.next_at) / row.interval_ms) + 1) * row.interval_ms;
        let revision = row.source_revision;
        if (row.trigger_kind === 'shared_changes') {
          if (this.db.prepare('SELECT visibility FROM rooms WHERE id=?').get(row.room_id)!.visibility !== 'shared') continue;
          revision = this.sourceRevision(row.agent_id, row.room_id);
          if (revision === row.source_revision) {
            this.db.prepare('UPDATE schedules SET next_at=? WHERE id=?').run(next, row.id); continue;
          }
        }
        const task = this.tasks.create(actor, row.agent_id, row.room_id, row.prompt, Date.now() + row.timeout_ms);
        this.db.prepare('INSERT INTO schedule_runs VALUES (?,?,?)').run(row.id, row.next_at, task.id);
        this.db.prepare('UPDATE schedules SET next_at=?,run_count=run_count+1,source_revision=? WHERE id=?').run(next, revision, row.id);
      }
    });
  }
}
