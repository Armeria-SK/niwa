import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { check, text } from '../domain/types.ts';
import { transaction } from '../storage/database.ts';
import type { Actor } from './runtime.ts';
import type { Tasks } from './tasks.ts';

export interface ScheduleInput {
  id: string; agent_id: string; room_id: string; prompt: string;
  interval_ms: number; next_at: number; max_runs: number; timeout_ms: number;
}
interface Schedule extends ScheduleInput { enabled: number; run_count: number; failure_reset: number; wait_reason: string | null }

/** Administrator-owned triggers; each occurrence and its task commit together. */
export class Schedules {
  constructor(private db: DatabaseSync, private tasks: Tasks, private admin: (actor: Actor) => unknown,
    private recipient: (actor: Actor, agentId: string, roomId: string) => void) {}

  list(actor: Actor): Schedule[] {
    this.admin(actor);
    return this.db.prepare(`SELECT id,agent_id,room_id,prompt,interval_ms,next_at,max_runs,timeout_ms,
      enabled,run_count,failure_reset,wait_reason FROM schedules ORDER BY rowid`).all() as unknown as Schedule[];
  }
  create(actor: Actor, input: ScheduleInput): Schedule {
    this.admin(actor);
    check(typeof input.id === 'string' && /^[0-9a-f-]{36}$/.test(input.id), 'invalid', 'Invalid schedule id');
    text(input.prompt);
    for (const [value, min, max] of [[input.interval_ms, 60_000, 365 * 86400_000],
      [input.next_at, 0, 8_000_000_000_000_000], [input.max_runs, 1, 10_000], [input.timeout_ms, 60_000, 86400_000]]) {
      check(Number.isSafeInteger(value) && value! >= min! && value! <= max!, 'invalid', 'Invalid schedule bounds');
    }
    const hash = createHash('sha256').update(JSON.stringify([input.agent_id, input.room_id, input.prompt,
      input.interval_ms, input.next_at, input.max_runs, input.timeout_ms])).digest('hex');
    return transaction(this.db, () => {
      const prior = this.db.prepare('SELECT input_hash FROM schedules WHERE id=?').get(input.id);
      if (prior) check(prior.input_hash === hash, 'conflict', 'Schedule id already used with different input');
      else {
        this.recipient(actor, input.agent_id, input.room_id);
        check(input.next_at >= Date.now(), 'invalid', 'First occurrence must be in the future');
        this.db.prepare(`INSERT INTO schedules(id,agent_id,room_id,prompt,interval_ms,next_at,max_runs,timeout_ms,input_hash)
          VALUES (?,?,?,?,?,?,?,?,?)`).run(input.id, input.agent_id, input.room_id, input.prompt,
          input.interval_ms, input.next_at, input.max_runs, input.timeout_ms, hash);
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
      this.recipient(actor, row.agent_id, row.room_id);
    }
    this.db.prepare('UPDATE schedules SET enabled=?,wait_reason=NULL,failure_reset=run_count WHERE id=?').run(Number(enabled), id);
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
        const task = this.tasks.create(actor, row.agent_id, row.room_id, row.prompt, Date.now() + row.timeout_ms);
        this.db.prepare('INSERT INTO schedule_runs VALUES (?,?,?)').run(row.id, row.next_at, task.id);
        const next = row.next_at + (Math.floor((now - row.next_at) / row.interval_ms) + 1) * row.interval_ms;
        this.db.prepare('UPDATE schedules SET next_at=?,run_count=run_count+1 WHERE id=?').run(next, row.id);
      }
    });
  }
}
