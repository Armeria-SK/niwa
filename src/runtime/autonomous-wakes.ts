import type {Initiatives} from './initiatives.ts';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Actor } from './runtime.ts';
import type { Tasks } from './tasks.ts';
import { transaction } from '../storage/database.ts';

const MINUTE = 60_000;
const PROMPT = '予定によらない自発活動の機会です。自分の人格・関心と、この共有会話で利用できる記憶・最近の共有会話・成果物・未完了の取り組みを確認し、今役立つ活動を自分で選んでください。history_search/readとcoordination_readで過去の実績や待ち理由を確認し、同じ調査・成果物・用件のない呼びかけを繰り返さないでください。承認や入力待ちの仕事を別の仕事として迂回しません。必要がなければtask_restで休息し、発言や成果物を無理に増やさないでください。私的な会話の内容は持ち込まず、外部操作の承認・予算・停止・隔離を守ります。';

/** Persistent wake opportunities, not user schedules. All work still uses Tasks/TurnRunner. */
export class AutonomousWakes {
  constructor(private db: DatabaseSync, private tasks: Tasks, private admin: (actor: Actor) => void,
    private createRoom: (actor: Actor) => string, private initiatives: Initiatives) {}

  list(actor: Actor) {
    this.admin(actor);
    const settings = this.db.prepare('SELECT paused,autonomous FROM settings WHERE id=1').get()!;
    const shared = this.db.prepare(`SELECT 1 FROM rooms r LEFT JOIN room_preferences p ON p.room_id=r.id WHERE r.visibility='shared'
      AND coalesce(p.archived,0)=0 AND r.id NOT IN (SELECT id FROM deleted_content WHERE kind='room') LIMIT 1`).get();
    const roomBlocked = !shared && !!this.db.prepare("SELECT 1 FROM rooms WHERE visibility='shared' LIMIT 1").get();
    const gate = Number(this.db.prepare('SELECT coalesce(max(last_started_at),0)+? AS due FROM autonomous_wakes').get(MINUTE)!.due);
    const ongoing=this.initiatives.enabled()?this.initiatives.list(actor):[];
    return this.db.prepare(`SELECT a.id AS agent_id,a.name,a.status,w.next_at,w.reason,w.model_calls,w.budget_reset_at,w.task_id,t.state,t.provider_retry_at,
      EXISTS(SELECT 1 FROM tasks busy WHERE busy.agent_id=a.id AND busy.paused=0 AND (busy.state IN ('queued','running') OR (busy.state='waiting_provider' AND (SELECT enabled FROM initiative_settings)=0))) AS busy
      FROM agents a LEFT JOIN autonomous_wakes w ON w.agent_id=a.id LEFT JOIN tasks t ON t.id=w.task_id
      WHERE a.id NOT IN (SELECT id FROM deleted_agents) ORDER BY a.rowid`).all().map(row => {const blocked=roomBlocked&&!ongoing.some(i=>i.owner_id===row.agent_id&&i.state==='active'&&!this.db.prepare('SELECT 1 FROM room_preferences WHERE room_id=? AND archived=1').get(i.room_id));return ({
        agent_id: row.agent_id, name: row.name, task_id: row.task_id, model_calls: row.model_calls ?? 0, budget_reset_at: row.budget_reset_at,
        reason: settings.paused ? '全体停止中' : !settings.autonomous ? '自発活動オフ' : row.status !== 'active' ? '休眠中'
          : blocked ? '利用できる共有会話がありません' : row.busy ? (row.task_id ? '前回の活動を継続・待機中' : '既存の仕事を優先') : row.reason ?? '起動判定の準備中',
        next_at: settings.paused || !settings.autonomous || row.status !== 'active' || blocked ? null
          : row.busy ? (row.state === 'waiting_provider' ? row.provider_retry_at : null) : Math.max(Number(row.next_at ?? Date.now()+MINUTE),gate),
      });});
  }

  private evidence(agentId: string) {
    // Re-reading or saving the same content does not create new evidence.
    const content = this.db.prepare(`SELECT DISTINCT a.content FROM artifacts a JOIN rooms r ON r.id=a.room_id
      WHERE r.visibility='shared' AND a.author_id=?`).all(agentId).map(row=>String(row.content).replace(/\s+/g,' ').trim());
    const sources = this.db.prepare(`SELECT json_extract(x.output,'$.text') AS text FROM tool_receipts x JOIN tasks t ON t.id=x.task_id
      JOIN rooms r ON r.id=t.room_id WHERE t.agent_id=? AND r.visibility='shared' AND json_extract(x.output,'$.url') IS NOT NULL AND json_extract(x.output,'$.fetched_at') IS NOT NULL`).all(agentId)
      .filter(row=>typeof row.text==='string').map(row=>String(row.text).replace(/\s+/g,' ').trim());
    return createHash('sha256').update(JSON.stringify([...new Set([...content,...sources])].sort())).digest('hex');
  }

  dispatch(actor: Actor, now = Date.now()): void {
    this.admin(actor);
    transaction(this.db, () => {
      // Settle completed cycles even when stopped; never reset a persisted rest on restart.
      for (const row of this.db.prepare(`SELECT w.*,t.state,t.result,t.updated_at FROM autonomous_wakes w JOIN tasks t ON t.id=w.task_id
        WHERE t.state IN ('completed','failed','cancelled','waiting_user','waiting_child') OR (t.state='waiting_provider' AND (SELECT enabled FROM initiative_settings)=1)`).all()) {
        const linked=this.db.prepare('SELECT initiative_id FROM initiative_tasks WHERE task_id=?').get(row.task_id!);
        const evidence = linked ? String(this.db.prepare('SELECT count(*) AS n FROM initiative_evidence WHERE initiative_id=?').get(linked.initiative_id!)!.n) : this.evidence(String(row.agent_id));
        const held = ['waiting_user','waiting_child','waiting_provider'].includes(String(row.state));
        const stagnant = row.evidence === evidence ? Number(row.stagnant)+1 : 0;
        const failed = !held && row.state !== 'completed', failures = failed ? Number(row.failures)+1 : 0;
        const rested = row.result === '今回は休息しました。';
        const delay = held ? 15 : failed ? Math.min(360,60 * 2 ** Math.min(failures-1,3)) : rested ? 60 : 15;
        this.db.prepare('UPDATE autonomous_wakes SET task_id=NULL,next_at=?,failures=?,reason=?,evidence=?,stagnant=? WHERE agent_id=?')
          .run(Math.max(Number(row.next_at),Number(row.updated_at)+Math.max(delay,Math.min(1440,15*2**Math.min(stagnant,7)))*MINUTE),failures,held?'保留した仕事とは別の活動を判定':stagnant>=2?'進展がないため方法の見直し待ち':failed?'失敗後の待機':rested?'休息中':'活動完了後の間隔',evidence,stagnant,row.agent_id!);
      }
      if(this.initiatives.enabled())this.db.exec("UPDATE autonomous_wakes SET task_id=NULL WHERE task_id IN (SELECT id FROM tasks WHERE paused=1 AND state<>'running')");
      const settings = this.db.prepare('SELECT paused,autonomous FROM settings WHERE id=1').get()!;
      if (settings.paused || !settings.autonomous) return;
      this.db.prepare(`INSERT OR IGNORE INTO autonomous_wakes(agent_id,next_at,reason)
        SELECT id,?,'予定なしの起動機会を待機中' FROM agents WHERE status='active' AND id NOT IN (SELECT id FROM deleted_agents)`).run(now+MINUTE);
      this.initiatives.observe(actor,now);
      for(const item of this.initiatives.due(actor,now)) this.db.prepare('UPDATE autonomous_wakes SET next_at=min(next_at,?) WHERE agent_id=? AND last_started_at+900000<=?').run(now,item.owner_id,now);
      const last = Number(this.db.prepare('SELECT coalesce(max(last_started_at),0) AS last FROM autonomous_wakes').get()!.last);
      if (now < last+MINUTE) return;
      const candidates = this.db.prepare(`SELECT w.agent_id,w.stagnant FROM autonomous_wakes w JOIN agents a ON a.id=w.agent_id
        WHERE w.task_id IS NULL AND w.next_at<=? AND a.status='active' AND a.id NOT IN (SELECT id FROM deleted_agents)
        AND NOT EXISTS(SELECT 1 FROM tasks t WHERE t.agent_id=a.id AND (t.state IN ('queued','running') OR (t.state='waiting_provider' AND (SELECT enabled FROM initiative_settings)=0)) AND t.paused=0)
        AND NOT (w.model_calls>=24 AND w.budget_reset_at>?)
        ORDER BY w.last_started_at,w.next_at,a.rowid`).all(now,now);
      const candidate=candidates.find(c=>!this.initiatives.enabled()||this.initiatives.candidate(actor,String(c.agent_id),now)||!this.initiatives.list(actor).some(i=>i.owner_id===c.agent_id&&i.state==='resting'));
      if (!candidate) return;
      const initiative=this.initiatives.candidate(actor,String(candidate.agent_id),now);
      const room = initiative ? {id:initiative.room_id} : this.db.prepare(`SELECT r.id FROM rooms r LEFT JOIN room_preferences p ON p.room_id=r.id
        WHERE r.visibility='shared' AND coalesce(p.archived,0)=0 AND r.id NOT IN (SELECT id FROM deleted_content WHERE kind='room')
        ORDER BY r.rowid LIMIT 1`).get();
      // Do not bypass deliberately archived/deleted shared conversations by creating replacements.
      if (!room && this.db.prepare("SELECT 1 FROM rooms WHERE visibility='shared' LIMIT 1").get()) return;
      const roomId = String(room?.id ?? this.createRoom(actor));
      const held = this.db.prepare("SELECT id FROM tasks WHERE (agent_id=? OR room_id=?) AND (state IN ('waiting_user','waiting_child') OR ((SELECT enabled FROM initiative_settings)=1 AND (state='waiting_provider' OR (paused=1 AND state NOT IN ('completed','failed','cancelled'))))) ORDER BY id").all(candidate.agent_id!,roomId);
      const task = this.tasks.create(actor,String(candidate.agent_id),roomId,(initiative?this.initiatives.prompt(actor,initiative.id):PROMPT) + '\n保留中の仕事と独立した活動を選んでください。進展のない周期数：' + Number(candidate.stagnant) + '。2周期以上なら同じ確認を繰り返さず、情報源・仮説・方法を変えます。');
      if(initiative)this.initiatives.bind(task.id,initiative.id,now);
      if (held.length) this.db.prepare('INSERT INTO autonomous_boundaries VALUES (?,?)').run(task.id,JSON.stringify(held.map(row=>row.id)));
      this.db.prepare('UPDATE tasks SET internal_autonomous=1 WHERE id=?').run(task.id);
      this.db.prepare("UPDATE autonomous_wakes SET task_id=?,last_started_at=?,evidence=?,reason=? WHERE agent_id=?")
        .run(task.id,now,initiative?String(initiative.evidence.length):this.evidence(String(candidate.agent_id)),initiative?`継続する取り組み：${initiative.review_reason}`:'予定なしの定期判定から起動',candidate.agent_id!);
    });
  }
}
