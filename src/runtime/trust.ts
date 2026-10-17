import type { DatabaseSync } from 'node:sqlite';
import { check } from '../domain/types.ts';
import type { Actor } from './runtime.ts';

/** Consecutive approvals of one kind, by one Bot, before Niwa suggests letting it go ahead without asking. */
export const TRUST_STREAK = 5;
/** Kinds of approval. A Bot's free-form request is for payments, purchases or publishing; forms and page requests send data to other sites.
 * None of these is ever suggested. Only writes through an MCP tool the administrator marked for review can be, one tool at a time. */
export type ApprovalKind = 'request' | 'form' | 'page_request' | 'action' | `mcp:${string}`;
/** Tool names that look like money, contracts or putting something out in public. They always ask, however often approved. */
const ALWAYS_ASK = /(pay|purchase|buy|order|checkout|charge|invoice|bill|refund|transfer|wallet|subscri|contract|sign|agree|publish|post|tweet|share|send|mail|message|reply|comment|deploy|release|public)/i;

export function suggestable(kind: string): boolean {
  if (!/^mcp:mcp_[a-z][a-z0-9_]{0,19}_.{1,128}$/.test(kind)) return false;
  return !ALWAYS_ASK.test(kind.slice(4));
}

/** Approval history and the kinds the administrator let a Bot do without asking. Raising trust only ever happens when the administrator presses for it. */
export class Trust {
  constructor(private db: DatabaseSync, private admin: (actor: Actor) => void) {}

  /** One row per decision. A replayed automatic go-ahead for the same operation is recorded once. */
  record(taskId: string, agentId: string, kind: string, decision: 'approved' | 'declined' | 'auto', operation: string | null, now = Date.now()): void {
    if (decision === 'auto' && this.db.prepare("SELECT 1 FROM approval_history WHERE task_id=? AND operation=? AND decision='auto'").get(taskId, operation)) return;
    this.db.prepare('INSERT INTO approval_history(task_id,agent_id,kind,operation,decision,decided_at) VALUES (?,?,?,?,?,?)').run(taskId, agentId, kind, operation, decision, now);
  }
  /** Whether this Bot may go ahead with this kind without asking. A kind that can never be suggested is never granted, even if a row exists. */
  granted(agentId: string, kind: string): boolean {
    return suggestable(kind) && !!this.db.prepare('SELECT 1 FROM approval_grants WHERE agent_id=? AND kind=?').get(agentId, kind);
  }
  /** Approvals given as asked since the last time this kind was declined. Automatic ones are not the administrator's approvals and do not count. */
  #streak(agentId: string, kind: string): number {
    const declined = Number(this.db.prepare("SELECT coalesce(max(id),0) AS id FROM approval_history WHERE agent_id=? AND kind=? AND decision='declined'").get(agentId, kind)!.id);
    return Number(this.db.prepare("SELECT count(*) AS n FROM approval_history WHERE agent_id=? AND kind=? AND decision='approved' AND id>?").get(agentId, kind, declined)!.n);
  }
  state(actor: Actor) {
    this.admin(actor);
    const names = new Map(this.db.prepare('SELECT id,name FROM agents WHERE id NOT IN (SELECT id FROM deleted_agents)').all().map(row => [String(row.id), String(row.name)]));
    const suggestions = this.db.prepare("SELECT agent_id,kind,max(decided_at) AS last_at FROM approval_history WHERE decision='approved' GROUP BY agent_id,kind").all()
      .filter(row => names.has(String(row.agent_id)) && suggestable(String(row.kind)) && !this.granted(String(row.agent_id), String(row.kind)))
      .map(row => {
        const agentId = String(row.agent_id), kind = String(row.kind), streak = this.#streak(agentId, kind);
        const dismissed = Number(this.db.prepare('SELECT streak FROM approval_grant_dismissals WHERE agent_id=? AND kind=?').get(agentId, kind)?.streak ?? 0);
        return { agent_id: agentId, name: names.get(agentId)!, kind, streak, last_at: Number(row.last_at), due: streak >= TRUST_STREAK && streak >= dismissed + TRUST_STREAK };
      }).filter(item => item.due).map(({ due: _due, ...item }) => item).sort((a, b) => b.last_at - a.last_at);
    const grants = this.db.prepare('SELECT agent_id,kind,streak,granted_at FROM approval_grants ORDER BY granted_at DESC').all()
      .filter(row => names.has(String(row.agent_id))).map(row => ({ agent_id: String(row.agent_id), name: names.get(String(row.agent_id))!, kind: String(row.kind), streak: Number(row.streak), granted_at: Number(row.granted_at),
        automatic: Number(this.db.prepare("SELECT count(*) AS n FROM approval_history WHERE agent_id=? AND kind=? AND decision='auto' AND decided_at>=?").get(String(row.agent_id), String(row.kind), Number(row.granted_at))!.n) }));
    return { threshold: TRUST_STREAK, suggestions, grants };
  }
  /** Lets a Bot go ahead with one kind without asking. Only a kind that is suggested now can be granted; nothing is granted on its own. */
  grant(actor: Actor, agentId: string, kind: string, now = Date.now()) {
    this.admin(actor);
    check(suggestable(kind), 'forbidden', 'This kind always asks');
    const suggestion = this.state(actor).suggestions.find(item => item.agent_id === agentId && item.kind === kind);
    check(suggestion, 'conflict', 'This kind is not suggested now');
    this.db.prepare('INSERT INTO approval_grants(agent_id,kind,streak,granted_at) VALUES (?,?,?,?) ON CONFLICT(agent_id,kind) DO NOTHING').run(agentId, kind, suggestion.streak, now);
    return this.state(actor);
  }
  /** Back to asking every time. Always allowed; the same suggestion returns only after another run of approvals. */
  revoke(actor: Actor, agentId: string, kind: string, now = Date.now()) {
    this.admin(actor);
    this.db.prepare('DELETE FROM approval_grants WHERE agent_id=? AND kind=?').run(agentId, kind);
    return this.dismiss(actor, agentId, kind, now);
  }
  /** Keeps asking; the suggestion comes back only after another run of approvals. */
  dismiss(actor: Actor, agentId: string, kind: string, now = Date.now()) {
    this.admin(actor);
    this.db.prepare('INSERT INTO approval_grant_dismissals(agent_id,kind,streak,dismissed_at) VALUES (?,?,?,?) ON CONFLICT(agent_id,kind) DO UPDATE SET streak=excluded.streak,dismissed_at=excluded.dismissed_at')
      .run(agentId, kind, this.#streak(agentId, kind), now);
    return this.state(actor);
  }
  /** A deleted Bot's grants and history go with it. */
  forgetAgent(agentId: string): void {
    for (const table of ['approval_history', 'approval_grants', 'approval_grant_dismissals']) this.db.prepare(`DELETE FROM ${table} WHERE agent_id=?`).run(agentId);
  }
}
