import type { DatabaseSync } from 'node:sqlite';
import { check } from '../domain/types.ts';
import type { Actor } from './runtime.ts';
import { currentNight, inNight, lastNight, previewOpen, type NightWindow } from './night.ts';

export const DEFAULT_NIGHT_CALLS = 30;
// What the Bots never do unattended. These already wait for the administrator's approval; the plan says so in plain words.
const NEVER = ['支払い・購入・契約', '外部への公開・送信（フォームやメール）', 'あなたの許可が要る操作（朝まで承認待ちで止まります）'];

/** Tonight's plan for unattended work: the administrator previews it in the evening, and the morning shows what came of it.
 * The plan is built from saved data (which Bots may act and their ongoing initiatives); no model is called to write it. */
export class NightPlans {
  constructor(private db: DatabaseSync, private admin: (actor: Actor) => void) {}

  preview(): boolean { return Number(this.db.prepare('SELECT night_preview FROM settings WHERE id=1').get()!.night_preview) === 1; }
  setPreview(actor: Actor, enabled: boolean) {
    this.admin(actor); check(typeof enabled === 'boolean', 'invalid', 'Expected preview boolean');
    this.db.prepare('UPDATE settings SET night_preview=? WHERE id=1').run(Number(enabled));
    return { preview: enabled };
  }
  /** Why unattended work may not start now, or null. Daytime and nights without the preview behave as before. */
  gate(now: number): string | null {
    if (!inNight(now)) return null;
    const night = currentNight(now), row = this.db.prepare('SELECT decision,call_limit FROM night_plans WHERE night=?').get(night.key);
    if (!row) return this.preview() ? '夜の計画の下見待ち' : null;
    if (row.decision === 'skipped') return '今夜は休む日';
    return this.usage(night).calls >= Number(row.call_limit) ? '今夜の利用枠に達しました' : null;
  }
  /** The draft of tonight's plan: which Bots may act and on what, how much they may use, and what they never do. */
  draft() {
    const settings = this.db.prepare('SELECT autonomous,paused FROM settings WHERE id=1').get()!;
    const agents = this.db.prepare(`SELECT a.id,a.name FROM agents a WHERE a.status='active' AND a.id NOT IN (SELECT id FROM deleted_agents)
      AND coalesce((SELECT enabled FROM agent_autonomy WHERE agent_id=a.id),1)=1 ORDER BY a.rowid`).all();
    const purposes = this.db.prepare("SELECT body FROM initiatives WHERE owner_id=? AND state IN ('active','resting') ORDER BY review_at LIMIT 5");
    const items = !settings.autonomous || settings.paused ? [] : agents.map(agent => ({ agent_id: String(agent.id), name: String(agent.name),
      doing: purposes.all(String(agent.id)).map(row => { try { return String((JSON.parse(String(row.body)) as { purpose?: unknown }).purpose ?? ''); } catch { return ''; } }).filter(Boolean) }));
    return { active: !!settings.autonomous && !settings.paused, items, never: NEVER };
  }
  decide(actor: Actor, now: number, night: string, approved: boolean, callLimit = DEFAULT_NIGHT_CALLS) {
    this.admin(actor);
    check(previewOpen(now) && night === currentNight(now).key, 'conflict', 'This night can no longer be previewed');
    check(typeof approved === 'boolean' && Number.isSafeInteger(callLimit) && callLimit >= 1 && callLimit <= 500, 'invalid', 'Invalid night plan');
    this.db.prepare(`INSERT INTO night_plans(night,decision,call_limit,plan,decided_at) VALUES (?,?,?,?,?)
      ON CONFLICT(night) DO UPDATE SET decision=excluded.decision,call_limit=excluded.call_limit,plan=excluded.plan,decided_at=excluded.decided_at`)
      .run(night, approved ? 'approved' : 'skipped', callLimit, JSON.stringify(this.draft()), now);
    return this.state(actor, now);
  }
  private usage(night: NightWindow) {
    const row = this.db.prepare(`SELECT count(*) AS calls,coalesce(sum(coalesce(p.input_tokens,p.estimated_input_tokens)),0) AS input,coalesce(sum(p.output_tokens),0) AS output,coalesce(sum(p.input_tokens IS NULL),0) AS estimated
      FROM prompt_runs p JOIN tasks t ON t.id=p.task_id WHERE t.internal_autonomous=1 AND p.created_at>=? AND p.created_at<? AND p.status<>'discarded'`).get(night.start, night.end)!;
    return { calls: Number(row.calls), input: Number(row.input), output: Number(row.output), estimated: Number(row.estimated) };
  }
  /** What the last finished night produced: finished work, what waits for a decision, what stopped and why, and how much was used. */
  private harvest(night: NightWindow) {
    const tasks = this.db.prepare(`SELECT t.id,t.agent_id,a.name,t.prompt,t.state,t.result,t.wait_reason,t.paused,(SELECT status FROM approval_requests r WHERE r.task_id=t.id) AS approval
      FROM tasks t JOIN agents a ON a.id=t.agent_id WHERE t.internal_autonomous=1 AND t.created_at>=? AND t.created_at<? ORDER BY t.created_at`).all(night.start, night.end)
      .map(row => ({ id: String(row.id), agent_id: String(row.agent_id), name: String(row.name), state: String(row.state), approval: row.approval === null ? null : String(row.approval),
        summary: String(row.result ?? row.wait_reason ?? '').slice(0, 240), paused: row.paused === 1 }));
    const decision = this.db.prepare('SELECT decision,call_limit FROM night_plans WHERE night=?').get(night.key);
    return { night, decision: decision ? { decision: String(decision.decision), call_limit: Number(decision.call_limit) } : null,
      done: tasks.filter(task => task.state === 'completed'),
      waiting: tasks.filter(task => task.approval === 'pending' || task.state === 'waiting_user'),
      stopped: tasks.filter(task => ['failed', 'cancelled', 'waiting_provider'].includes(task.state) || (task.paused && task.state !== 'completed')),
      usage: this.usage(night) };
  }
  /** Consecutive approved nights before tonight, so the screen can offer to stop previewing after three. */
  private streak(before: string): number {
    let count = 0, expected = before;
    for (const row of this.db.prepare('SELECT night,decision FROM night_plans WHERE night<? ORDER BY night DESC LIMIT 30').all(before)) {
      const previous = new Date(Date.parse(`${expected}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
      if (row.night !== previous || row.decision !== 'approved') break;
      count++; expected = previous;
    }
    return count;
  }
  state(actor: Actor, now: number) {
    this.admin(actor);
    const night = currentNight(now), decided = this.db.prepare('SELECT decision,call_limit,decided_at FROM night_plans WHERE night=?').get(night.key);
    return { preview: this.preview(), night, in_night: inNight(now), preview_open: previewOpen(now), default_calls: DEFAULT_NIGHT_CALLS,
      decision: decided ? { decision: String(decided.decision), call_limit: Number(decided.call_limit), decided_at: Number(decided.decided_at) } : null,
      used: this.usage(night), plan: this.draft(), streak: this.streak(night.key), gate: this.gate(now), harvest: this.harvest(lastNight(now)) };
  }
}
