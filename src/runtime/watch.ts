import type { DatabaseSync } from 'node:sqlite';
import type { Actor, Runtime } from './runtime.ts';
import { redactSecrets } from '../shared/redaction.ts';
import { currentNight } from './night.ts';

const HOUR = 3_600_000, JST = 9 * HOUR, DAY = 24 * HOUR;
/** The hourly allowance of model calls each Bot's unattended work may use (see Tasks.reserveModelCall). */
export const WAKE_CALLS_PER_HOUR = 24;
/** Midnight in Japan time, the start of "today" like the night and backup schedules. */
export const todayStart = (now: number) => Math.floor((now + JST) / DAY) * DAY - JST;

/** Only the address of a fetched page, never its query string or fragment, which may carry tokens. */
function pageAddress(value: unknown): string {
  try { const url = new URL(String(value)); return redactSecrets(`${url.origin}${url.pathname}`).slice(0, 200); }
  catch { return ''; }
}

/** The watch screen: what is running, what went out to the outside world, what waits for approval, and today's usage against its limits.
 * Read only. It reports saved records as they are; a recorded outcome is not proof the outside service did what was intended. */
export class Watch {
  constructor(private db: DatabaseSync, private runtime: Runtime, private admin: (actor: Actor) => void) {}

  state(actor: Actor, now = Date.now()) {
    this.admin(actor);
    const runtime = this.runtime, settings = runtime.settings(actor);
    const names = new Map(runtime.agents(actor).map(agent => [agent.id, agent.name]));
    const rooms = new Map(runtime.rooms(actor).map(room => [room.id, room.title]));
    const who = (id: unknown) => names.get(String(id)) ?? '削除したBot';
    const titles = this.db.prepare('SELECT (SELECT title FROM approval_requests WHERE task_id=?) AS approval,(SELECT title FROM business_tasks WHERE task_id=?) AS business');
    const running = this.db.prepare(`SELECT id,agent_id,room_id,prompt,state,paused,internal_autonomous,updated_at FROM tasks
      WHERE state NOT IN ('completed','failed','cancelled') ORDER BY state='running' DESC,updated_at DESC,rowid DESC LIMIT 50`).all().map(row => {
      const id = String(row.id), progress = runtime.tasks.progress(actor, id, true), named = titles.get(id, id);
      return { id, agent_id: String(row.agent_id), name: who(row.agent_id), room_title: rooms.get(String(row.room_id)) ?? '',
        title: redactSecrets(String(named?.approval ?? named?.business ?? row.prompt ?? '')).split('\n')[0]!.slice(0, 120),
        state: String(row.state), paused: row.paused === 1 || settings.paused, autonomous: row.internal_autonomous === 1, updated_at: Number(row.updated_at),
        progress: { label: progress.label, phase: progress.phase ?? null, kind: progress.kind, started_at: progress.started_at ?? null, retry_at: progress.retry_at ?? null, waiting_for: progress.waiting_for } };
    });
    // Sends, uploads and runs go through the outbox; a missing output means Niwa does not know how the outside service answered.
    const operations = this.db.prepare(`SELECT l.task_id,l.tool_name,l.started_at,e.output IS NOT NULL AS recorded,json_extract(e.output,'$.error') AS error,t.agent_id
      FROM external_operation_labels l JOIN external_operations e USING(task_id,operation_id) JOIN tasks t ON t.id=l.task_id ORDER BY l.started_at DESC LIMIT 30`).all()
      .map(row => ({ kind: 'operation' as const, task_id: String(row.task_id), tool: String(row.tool_name), address: '', at: Number(row.started_at),
        outcome: row.recorded === 1 ? 'recorded' as const : 'unknown' as const, failed: row.recorded === 1 && row.error !== null, name: who(row.agent_id) }));
    // Page reads keep their receipt; only the newest receipts are scanned.
    const fetches = this.db.prepare(`SELECT x.task_id,json_extract(x.output,'$.url') AS url,json_extract(x.output,'$.fetched_at') AS fetched_at,t.agent_id
      FROM (SELECT * FROM tool_receipts ORDER BY rowid DESC LIMIT 2000) x JOIN tasks t ON t.id=x.task_id
      WHERE json_extract(x.output,'$.url') IS NOT NULL AND json_extract(x.output,'$.fetched_at') IS NOT NULL ORDER BY json_extract(x.output,'$.fetched_at') DESC LIMIT 30`).all()
      .map(row => ({ kind: 'fetch' as const, task_id: String(row.task_id), tool: 'page_read', address: pageAddress(row.url), at: Date.parse(String(row.fetched_at)) || 0,
        outcome: 'recorded' as const, failed: false, name: who(row.agent_id) }));
    const outside = [...operations, ...fetches].sort((a, b) => b.at - a.at).slice(0, 30);
    const approvals = runtime.approvals(actor).map(row => {
      const task = runtime.tasks.get(actor, String(row.task_id));
      return { task_id: task.id, title: String(row.title), name: who(task.agent_id), room_title: rooms.get(task.room_id) ?? '', since: Number(task.updated_at) };
    });
    const night = runtime.nights.state(actor, now);
    const wakes = this.db.prepare(`SELECT a.id,a.name,w.model_calls,w.budget_reset_at FROM agents a LEFT JOIN autonomous_wakes w ON w.agent_id=a.id
      WHERE a.id NOT IN (SELECT id FROM deleted_agents) ORDER BY a.rowid`).all().map(row => {
      const reset = Number(row.budget_reset_at ?? 0), counting = reset > now;
      return { agent_id: String(row.id), name: String(row.name), used: counting ? Number(row.model_calls ?? 0) : 0, limit: WAKE_CALLS_PER_HOUR, reset_at: counting ? reset : null };
    });
    return { checked_at: now, paused: settings.paused, autonomous: settings.autonomous, running, outside, approvals,
      usage: { today: runtime.tasks.usageSince(actor, todayStart(now)),
        night: { key: currentNight(now).key, in_night: night.in_night, preview: night.preview, decision: night.decision?.decision ?? null, limit: night.decision?.call_limit ?? null, used: night.used.calls, gate: night.gate },
        wakes } };
  }
}
