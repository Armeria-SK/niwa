import {redactSecrets} from '../shared/redaction.ts';
import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { check, text } from '../domain/types.ts';
import type { Actor } from './runtime.ts';
import type { Task, TaskLease, TaskState, TaskEvent } from '../domain/task.ts';
import { isTerminal } from '../domain/task.ts';
import { transaction } from '../storage/database.ts';
import type { JsonObject, ModelEvent } from '../contracts/model.ts';

interface Access {
  checkpoint(actor:Actor,lease:TaskLease,input:{tried:string;result:string;next_action:string;resume_condition:string;rest_minutes:number}):void;
  initiative(actor: Actor, task: string): unknown;
  principal(actor: Actor): { kind: 'admin' | 'agent'; id: string };
  room(actor: Actor, roomId: string): unknown;
  participant(agentId: string, roomId: string): boolean;
  memory(actor: Actor, agentId: string): DatabaseSync;
  announceDelegation(actor: Actor, roomId: string, agentId: string, prompt: string): string;
}
type RecordWithLease = Task & { lease_token: string | null };
const publicTask = ({ lease_token: _token, ...task }: RecordWithLease): Task => task;
const CONVERSATION_LIMIT_REASON = '会話の継続が16回の区切りに達しました。続ける場合は仕事の詳細から再開してください。';
const TURN_LIMIT_REASON = 'この仕事の実行区切りに達しました。続行する場合は、新しい依頼として必要な範囲を指定してください。';
const NO_DEADLINE = 8_640_000_000_000_000;

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
  create(actor: Actor, agentId: string, roomId: string, prompt: string, deadlineAt = NO_DEADLINE): Task {
    const principal = this.#access.principal(actor);
    this.#access.room(actor, roomId);
    check(this.#access.participant(agentId, roomId), 'forbidden', 'Recipient cannot access this conversation');
    text(prompt);
    const duration=prompt.match(/(?:制限時間|タイムボックス|期限)[:：\s]*(\d{1,4})\s*(秒|分|時間)/) ?? prompt.match(/(?<![\d.．-])(\d{1,4})\s*(秒|分|時間)(?:以内|で)/);
    if(duration) {const seconds=Number(duration[1])*({秒:1,分:60,時間:3600}[duration[2]!] ?? 0);if(seconds>0 && seconds<=86400) deadlineAt=Math.min(deadlineAt,Date.now()+seconds*1000);}
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
  #change(id: string, state: TaskState, result: string | null = null, reason: string | null = null, announce = true): void {
    this.#db.prepare('UPDATE tasks SET state=?,result=?,wait_reason=?,updated_at=?,provider_retry_at=NULL WHERE id=?').run(state, result, reason, Date.now(), id);
    if (isTerminal(state)) this.#db.prepare('UPDATE tasks SET paused=0 WHERE id=?').run(id);
    if (state === 'completed' && announce) {
      const task = this.#read(id);
      this.#db.prepare("INSERT INTO updates(room_id,author_id,kind,title,detail,task_id,created_at) VALUES (?,?,'done',?,?,?,?)")
        .run(task.room_id, task.agent_id, task.prompt.slice(0, 200), result || '完了', id, Date.now());
    }
    this.#event(id, state);
  }
  queuedRequestAgents(actor: Actor): Set<string> {
    this.#admin(actor);
    return new Set(this.#db.prepare("SELECT DISTINCT agent_id FROM tasks WHERE state='queued' AND paused=0 AND internal_autonomous=0 AND NOT EXISTS(SELECT 1 FROM execution_bindings e WHERE e.task_id=tasks.id AND e.waiting=1 AND e.state='pending')").all().map(row=>String(row.agent_id)));
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
        WHERE t.state='queued' AND t.paused=0 AND a.status='active' AND NOT EXISTS (SELECT 1 FROM execution_bindings e WHERE e.task_id=t.id AND e.waiting=1 AND e.state='pending') AND NOT EXISTS
          (SELECT 1 FROM tasks running WHERE running.agent_id=t.agent_id AND running.state='running')
        ORDER BY t.internal_autonomous,t.updated_at,t.rowid`).all() as { id: string; agent_id: string }[]).find(task => !excludedAgents.has(task.agent_id) && this.#autonomyAllowed(task.id));
      if (!next) return undefined;
      const token = randomUUID();
      this.#db.prepare("UPDATE tasks SET lease_token=?,attempt=attempt+1 WHERE id=?").run(token, next.id);
      this.#change(next.id, 'running');
      return { task: publicTask(this.#read(next.id)), token };
    });
  }
  /** Give another runnable job a turn after a durable model/tool step, without ending this work. */
  yieldIfWaiting(actor: Actor, lease: TaskLease): boolean {
    return transaction(this.#db, () => {
      this.#owned(actor, lease);
      const waiting = this.#db.prepare(`SELECT t.id,t.updated_at FROM tasks t JOIN agents a ON a.id=t.agent_id
        WHERE t.state='queued' AND t.paused=0 AND a.status='active' AND NOT EXISTS (SELECT 1 FROM execution_bindings e WHERE e.task_id=t.id AND e.waiting=1 AND e.state='pending') AND NOT EXISTS
          (SELECT 1 FROM tasks r WHERE r.agent_id=t.agent_id AND r.state='running' AND r.id<>?)
        ORDER BY t.updated_at,t.rowid`).all(lease.task.id).find(row => this.#autonomyAllowed(row.id as string));
      if (!waiting) return false;
      this.#change(lease.task.id, 'queued');
      this.#db.prepare('UPDATE tasks SET lease_token=NULL,updated_at=MAX(updated_at,?) WHERE id=?')
        .run(Number(waiting.updated_at) + 1, lease.task.id);
      return true;
    });
  }
  #owned(actor: Actor, lease: TaskLease, requireRunning = true): RecordWithLease {
    const principal = this.#access.principal(actor);
    const task = this.#read(lease.task.id);
    check(principal.kind === 'agent' && task.agent_id === principal.id, 'forbidden', 'Task belongs to another agent');
    check(task.lease_token === lease.token && !task.paused && (!requireRunning || task.state === 'running'), 'conflict', 'Task lease is no longer active');
    check(this.#autonomyAllowed(task.id), 'conflict', 'Autonomous activity is paused');
    return task;
  }
  executionAllowed(actor:Actor,id:string,token:string,waiting:boolean){
    try{const task=this.#read(id),who=this.#access.principal(actor);this.#access.room(actor,task.room_id);
      return who.kind==='agent'&&who.id===task.agent_id&&!this.#paused()&&!task.paused&&task.deadline_at>Date.now()&&this.#autonomyAllowed(id)&&this.#access.participant(task.agent_id,task.room_id)&&
       ((task.state==='running'&&task.lease_token===token)||(waiting&&task.state==='queued'));
    }catch{return false;}
  }
  waitExecution(actor:Actor,lease:TaskLease,id:string){
    return transaction(this.#db,()=>{
      this.#owned(actor,lease);const row=this.#db.prepare('SELECT state FROM execution_bindings WHERE id=? AND task_id=?').get(id,lease.task.id);check(row,'not_found','Execution not found');
      if(row.state!=='pending')return {waiting:false};
      this.#db.prepare('UPDATE execution_bindings SET waiting=1 WHERE id=?').run(id);
      this.#change(lease.task.id,'queued',null,'隔離実行の結果待ち');this.#db.prepare('UPDATE tasks SET lease_token=NULL WHERE id=?').run(lease.task.id);return {waiting:true};
    });
  }
  active(actor: Actor, lease: TaskLease): boolean {
    try { this.#owned(actor, lease); return true; } catch { return false; }
  }
  #autonomyAllowed(taskId: string): boolean {
    if(this.#db.prepare(`SELECT 1 FROM initiative_tasks l JOIN initiatives i ON i.id=l.initiative_id JOIN tasks t ON t.id=l.task_id WHERE l.task_id=? AND (NOT EXISTS(SELECT 1 FROM json_each(i.body,'$.participants') WHERE value=t.agent_id) OR i.state='paused' OR (t.internal_autonomous=1 AND (SELECT enabled FROM initiative_settings)=0))`).get(taskId))return false;
    if (this.#db.prepare('SELECT autonomous FROM settings WHERE id=1').get()!.autonomous === 1 &&
      !this.#db.prepare('SELECT 1 FROM tasks t JOIN room_preferences p ON p.room_id=t.room_id WHERE t.id=? AND p.archived=1').get(taskId)) return true;
    return !this.#db.prepare(`WITH RECURSIVE ancestors(id,parent_id,conversation_reply,internal_autonomous) AS (
      SELECT id,parent_id,conversation_reply,internal_autonomous FROM tasks WHERE id=? UNION SELECT t.id,t.parent_id,t.conversation_reply,t.internal_autonomous FROM tasks t JOIN ancestors a ON t.id=a.parent_id)
      SELECT 1 FROM ancestors a LEFT JOIN schedule_runs r ON r.task_id=a.id LEFT JOIN schedules s ON s.id=r.schedule_id
      WHERE a.conversation_reply=1 OR a.internal_autonomous=1 OR s.autonomous=1 LIMIT 1`).get(taskId);
  }
  suspendAutonomous(actor: Actor): void {
    this.#admin(actor);
    for (const task of this.#db.prepare("SELECT id FROM tasks WHERE state='running'").all() as { id: string }[]) {
      if (this.#autonomyAllowed(task.id)) continue;
      this.#change(task.id, 'queued');
      this.#db.prepare('UPDATE tasks SET lease_token=NULL WHERE id=?').run(task.id);
    }
  }
  #autonomous(taskId: string): boolean {
    return !!this.#db.prepare('SELECT 1 FROM tasks t LEFT JOIN schedule_runs r ON r.task_id=t.id LEFT JOIN schedules s ON s.id=r.schedule_id WHERE t.id=? AND (t.conversation_reply=1 OR t.internal_autonomous=1 OR s.autonomous=1)').get(taskId);
  }
  rest(actor: Actor, lease: TaskLease): void {
    transaction(this.#db, () => {
      const task = this.#owned(actor, lease); this.#access.room(actor, task.room_id);
      check(this.#autonomous(task.id), 'forbidden', 'Only autonomous work can choose rest');
      this.#change(task.id, 'completed', '今回は休息しました。', null, false);
    });
  }
  acknowledgeWork(actor:Actor,lease:TaskLease) {
    const task=this.#owned(actor,lease);
    if(!this.#db.prepare("SELECT 1 FROM task_events WHERE task_id=? AND kind='work_acknowledged'").get(task.id)) this.#event(task.id,'work_acknowledged');
    return {acknowledged:true,state:task.state};
  }
  /** Acknowledgment ends a conversational reply, never an assigned deliverable. */
  acknowledge(actor: Actor, lease: TaskLease): void {
    transaction(this.#db, () => {
      const task = this.#owned(actor, lease);
      check(task.conversation_reply === 1, 'forbidden', 'Assigned work needs a result; acknowledgment cannot complete it');
      check(!this.#db.prepare('SELECT 1 FROM external_operations WHERE task_id=?').get(task.id) &&
        !this.#db.prepare('SELECT 1 FROM updates WHERE task_id=? AND artifact_id IS NOT NULL').get(task.id), 'conflict', 'Report the work result instead of acknowledgment');
      const message = task.source_message_id
        ? this.#db.prepare('SELECT id FROM messages WHERE id=? AND room_id=? AND author_id=?').get(task.source_message_id, task.room_id, task.requester_id)
        : this.#db.prepare('SELECT id FROM messages WHERE room_id=? AND author_id=? AND body=? ORDER BY rowid DESC LIMIT 1').get(task.room_id, task.requester_id, task.prompt);
      if (message) this.#db.prepare('INSERT INTO message_acknowledgments VALUES (?,?,?) ON CONFLICT DO NOTHING').run(message.id!, task.agent_id, Date.now());
      this.#change(task.id, 'completed', '受領済み（返信不要）', null, false);
      this.#event(task.id, 'acknowledged'); this.#resumeParent(task.parent_id);
    });
  }
  /** Reserve before transport; failures and interruptions conservatively consume the reservation. */
  reserveModelCall(actor: Actor, lease: TaskLease): boolean {
    return transaction(this.#db, () => {
      const task = this.#owned(actor, lease); this.#access.room(actor, task.room_id);
      const wake = this.#db.prepare(`WITH RECURSIVE ancestors(id,parent_id,internal_autonomous,agent_id) AS (
        SELECT id,parent_id,internal_autonomous,agent_id FROM tasks WHERE id=? UNION
        SELECT t.id,t.parent_id,t.internal_autonomous,t.agent_id FROM tasks t JOIN ancestors a ON t.id=a.parent_id)
        SELECT w.* FROM ancestors a JOIN autonomous_wakes w ON w.agent_id=a.agent_id WHERE a.internal_autonomous=1 LIMIT 1`).get(task.id);
      if (wake) {
        const now = Date.now(), reset = Number(wake.budget_reset_at), calls = reset <= now ? 0 : Number(wake.model_calls);
        if (calls >= 24) {
          this.wait(actor,lease,'waiting_provider','自発活動の時間枠の利用量に達したため休息中です。時間枠が戻ると自動で続けます。',true);
          this.#db.prepare('UPDATE tasks SET provider_retry_at=? WHERE id=?').run(reset,task.id);this.waitKind(actor,lease,'budget');
          return false;
        }
        this.#db.prepare('UPDATE autonomous_wakes SET model_calls=?,budget_reset_at=? WHERE agent_id=?')
          .run(calls+1,reset<=now?now+3600000:reset,wake.agent_id!);
      }
      const row = this.#db.prepare(`WITH RECURSIVE ancestors(id,parent_id) AS (
        SELECT id,parent_id FROM tasks WHERE id=? UNION SELECT t.id,t.parent_id FROM tasks t JOIN ancestors a ON t.id=a.parent_id
      ) SELECT s.* FROM ancestors a JOIN schedule_runs r ON r.task_id=a.id JOIN schedules s ON s.id=r.schedule_id`).get(task.id);
      if (!row) return true;
      if (Number(row.model_calls) < Number(row.max_model_calls)) {
        this.#db.prepare('UPDATE schedules SET model_calls=model_calls+1 WHERE id=?').run(row.id!); return true;
      }
      const reason = '定期実行のモデル呼び出し上限に達しました。';
      if (row.wait_reason !== reason) {
        this.#db.prepare('UPDATE schedules SET enabled=0,wait_reason=? WHERE id=?').run(reason, row.id!);
        this.#db.prepare(`INSERT INTO updates(room_id,author_id,kind,title,detail,task_id,created_at)
          VALUES (?,?,'question',?,?,?,?)`).run(task.room_id, task.agent_id, '定期実行の予算を確認してください', reason, task.id, Date.now());
      }
      return false;
    });
  }
  independentActivity(actor: Actor, lease: TaskLease): boolean {
    this.#owned(actor,lease);
    return !!this.#db.prepare(`WITH RECURSIVE ancestors(id,parent_id) AS (
      SELECT id,parent_id FROM tasks WHERE id=? UNION SELECT t.id,t.parent_id FROM tasks t JOIN ancestors a ON t.id=a.parent_id)
      SELECT 1 FROM ancestors a JOIN autonomous_boundaries b ON b.task_id=a.id LIMIT 1`).get(lease.task.id);
  }
  checkpoint(actor: Actor, lease: TaskLease, operationId: string, input: {purpose:string; tried:string; result:string; alternatives:string; next_action:string; resume_condition:string; rest_minutes:number}) {
    const state=this.workState(actor,lease);
    check(state.autonomous,'forbidden','Checkpoint is for autonomous work');
    check(input.rest_minutes===0 || (Number.isInteger(input.rest_minutes)&&input.rest_minutes>=15&&input.rest_minutes<=1440),'invalid','Rest between 15 and 1440 minutes');
    const remaining=[`目的：${input.purpose}`,`試した方法：${input.tried}`,`結果：${input.result}`,`未着手の候補：${input.alternatives}`,`次の行動：${input.next_action}`,`再開条件：${input.resume_condition}`];
    this.updatePlan(actor,lease,operationId,state.remaining_plan.revision,remaining);
    this.#access.checkpoint(actor,lease,input);
    if(input.rest_minutes) {
      this.#db.prepare('UPDATE autonomous_wakes SET next_at=max(next_at,?) WHERE task_id=?').run(Date.now()+input.rest_minutes*60000,lease.task.id);
      this.rest(actor,lease);
    }
    return {saved:true,rested:!!input.rest_minutes};
  }
  /** Fresh task-local facts for model input; never a replacement for lease/approval checks. */
  /** Same room only; child_results remains explicitly local to its parent task. */
  controlRevision(actor:Actor,id:string):number {this.get(actor,id);return Number(this.#db.prepare('SELECT coalesce(max(sequence),0) AS revision FROM task_events WHERE task_id=?').get(id)!.revision);}
  conversationState(actor:Actor,roomId:string,exclude?:string) {
    this.#access.room(actor,roomId);
    const rows=this.#db.prepare(`SELECT t.id,t.parent_id,t.agent_id,a.name,t.prompt,t.state,t.paused,t.internal_autonomous,t.updated_at,t.attempt
      FROM tasks t JOIN agents a ON a.id=t.agent_id WHERE t.room_id=? AND t.id<>?
      AND NOT EXISTS(SELECT 1 FROM task_context c WHERE c.task_id=t.id AND c.kind='status')
      ORDER BY CASE WHEN t.state IN ('completed','cancelled','failed') THEN 1 ELSE 0 END,t.updated_at DESC LIMIT 41`).all(roomId,exclude??'') as unknown as {id:string;parent_id:string|null;agent_id:string;name:string;prompt:string;state:string;paused:number;internal_autonomous:number;updated_at:number;attempt:number}[];
    return {scope:'current_conversation',checked_at:Date.now(),truncated:rows.length>40,tasks:rows.slice(0,40).map(t=>({...t,control_revision:this.controlRevision(actor,t.id),
      prompt:redactSecrets(String(t.prompt)).slice(0,240),progress:(({label,state,kind,waiting_for,retry_at,last_activity_at})=>({label,state,kind,waiting_for,retry_at,last_activity_at}))(this.progress(actor,String(t.id),true))}))};
  }
  linkMessage(actor:Actor,messageId:string,taskId:string,kind:string) {
    const task=this.get(actor,taskId);
    check(this.#db.prepare('SELECT 1 FROM messages WHERE id=? AND room_id=?').get(messageId,task.room_id),'forbidden','Message is outside task conversation');
    this.#db.prepare('INSERT OR IGNORE INTO task_message_links VALUES (?,?,?)').run(messageId,taskId,kind);
  }
  completeInquiry(actor:Actor,id:string,result:string) {
    this.#admin(actor);const task=this.get(actor,id);
    check(task.state==='queued' && this.#db.prepare("SELECT 1 FROM task_context WHERE task_id=? AND kind='status'").get(id),'conflict','Not a pending status inquiry');
    this.#change(id,'completed',text(result),null,false);
  }
  continueWork(actor:Actor,lease:TaskLease,operationId:string,nextAction:string,expectedRevision:number) {
    this.#owned(actor,lease);
    this.updatePlan(actor,lease,operationId,expectedRevision,[text(nextAction,1000)]);
    // Preserve steps and receipts: reclaim replays the saved report receipt, never its publication.
    this.#change(lease.task.id,'queued');
    this.#db.prepare('UPDATE tasks SET lease_token=NULL WHERE id=?').run(lease.task.id);
  }
  childDisposition(actor:Actor,lease:TaskLease,id:string,action:string,revision:number):JsonObject {
    this.#owned(actor,lease);const child=this.get(actor,id);
    check(child.parent_id===lease.task.id,'forbidden','Not a direct child');
    check(this.controlRevision(actor,id)===revision,'conflict','Child changed; refresh');
    check(action==='cancel'||action==='independent','invalid','Unknown disposition');
    if(action==='cancel')this.cancel(actor,id);
    else {this.#db.prepare('INSERT OR REPLACE INTO task_child_dependencies VALUES (?,0)').run(id);this.#event(id,'independent');}
    return {recorded:true};
  }
  assertCompletion(actor:Actor,lease:TaskLease) {
    this.#owned(actor,lease);
    check(!this.#db.prepare("SELECT 1 FROM tasks WHERE parent_id=? AND state NOT IN ('completed','failed','cancelled') AND id NOT IN(SELECT task_id FROM task_child_dependencies WHERE required=0)").get(lease.task.id),'conflict','Required children remain; wait for them or explicitly cancel/detach them before completion');
  }
  workState(actor: Actor, lease: TaskLease) {
    const task = this.#owned(actor, lease);
    this.#access.room(actor, task.room_id);
    const memory = this.#access.memory(actor, task.agent_id);
    const plan = memory.prepare('SELECT revision,remaining FROM task_plans WHERE task_id=? AND memory_revision=(SELECT revision FROM memory_state WHERE id=1)').get(task.id);
    return {
      conversation_scope: this.conversationState(actor,task.room_id,task.id),
      request_context: this.#db.prepare('SELECT kind,related_task_id FROM task_context WHERE task_id=?').get(task.id)??null,
      observations: this.#db.prepare("SELECT operation_id,json_extract(output,'$.url') AS url,json_extract(output,'$.source_id') AS source_id FROM tool_receipts WHERE task_id=? AND (json_extract(output,'$.fetched_at') IS NOT NULL OR json_extract(output,'$.revision') IS NOT NULL)").all(task.id),
      initiative: this.#access.initiative(actor,task.id),
      quality_enabled: this.#db.prepare('SELECT enabled FROM quality_settings WHERE id=1').get()?.enabled===1,
      completion_checks: this.#db.prepare('SELECT revision,body FROM task_quality WHERE task_id=?').get(task.id)??null,
      workarea: this.#db.prepare('SELECT w.id,w.kind,w.name,w.room_id FROM task_workareas t JOIN workareas w ON w.id=t.area_id WHERE t.task_id=?').get(task.id) ?? null,
      independent_activity: this.independentActivity(actor,lease),
      recent_autonomous_work: this.#autonomous(task.id) ? this.#db.prepare(`SELECT t.id,t.room_id,substr(t.prompt,1,300) AS prompt,t.state,substr(t.result,1,1000) AS result,t.wait_reason
        FROM tasks t JOIN rooms r ON r.id=t.room_id WHERE t.agent_id=? AND t.id<>? AND r.visibility='shared'
        AND r.id NOT IN (SELECT id FROM deleted_content WHERE kind='room') ORDER BY t.updated_at DESC LIMIT 8`).all(task.agent_id,task.id).map(row=>({...row,remaining_plan:JSON.parse(String(memory.prepare('SELECT remaining FROM task_plans WHERE task_id=? AND memory_revision=(SELECT revision FROM memory_state WHERE id=1)').get(row.id!)?.remaining ?? '[]'))})) : [],
      coordination: this.#db.prepare('SELECT * FROM task_coordination WHERE task_id=?').get(task.id) ?? {revision:0},
      task: publicTask(task), runtime_paused: this.#paused(), autonomous: this.#autonomous(task.id),
      remaining_plan: { revision: plan ? Number(plan.revision) : 0, remaining: plan ? JSON.parse(String(plan.remaining)) as string[] : [] },
      applied_procedures: memory.prepare('SELECT procedure_id,revision,applicability FROM procedure_uses WHERE task_id=? ORDER BY created_at,operation_id').all(task.id),
      administrator_replies: this.#db.prepare('SELECT sequence,body,created_at FROM task_replies WHERE task_id=? ORDER BY sequence').all(task.id),
      child_results: this.#db.prepare('SELECT id AS task_id,agent_id,prompt,state,result,wait_reason,attempt,updated_at,coalesce((SELECT required FROM task_child_dependencies WHERE task_id=tasks.id),1) AS required FROM tasks WHERE parent_id=? AND room_id=? ORDER BY created_at,rowid').all(task.id, task.room_id),
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
    execute: (executionId: string, firstAttempt: boolean) => Promise<JsonObject>): Promise<JsonObject> {
    const pending = transaction(this.#db, () => {
      this.#owned(actor, lease);
      const inputHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
      const prior = this.#db.prepare('SELECT input_hash,execution_id,output FROM external_operations WHERE task_id=? AND operation_id=?')
        .get(lease.task.id, operationId) as { input_hash: string; execution_id: string; output: string | null } | undefined;
      if (prior) { check(prior.input_hash === inputHash, 'conflict', 'External operation input changed'); return { ...prior, firstAttempt: false }; }
      if (this.independentActivity(actor,lease)) return {input_hash:inputHash,execution_id:'',output:JSON.stringify({error:'independent_activity_scope',message:'保留中の操作を再実行しないため、この独立活動では公開情報の読取と新規テキスト成果物だけを扱います。元の操作は元の仕事で確認してください。'}),firstAttempt:false};
      const restored = this.#db.prepare(`WITH RECURSIVE ancestors(id,parent_id) AS (
        SELECT id,parent_id FROM tasks WHERE id=? UNION SELECT t.id,t.parent_id FROM tasks t JOIN ancestors a ON t.id=a.parent_id)
        SELECT 1 FROM ancestors a JOIN restored_tasks r ON r.task_id=a.id LIMIT 1`).get(lease.task.id);
      if (restored) {
        this.#change(lease.task.id, 'waiting_user', null, '復元後の外部操作は元の実行記録を確認する必要があります。この仕事から未記録の操作は開始できません。');
        return { input_hash: inputHash, execution_id: '', output: JSON.stringify({ error: 'outcome_unknown' }), firstAttempt: false };
      }
      const record = { input_hash: inputHash, execution_id: randomUUID(), output: null };
      this.#db.prepare('INSERT INTO external_operations VALUES (?,?,?,?,NULL)').run(lease.task.id, operationId, inputHash, record.execution_id);
      const toolName=typeof input.name==='string' && /^[a-z_]{1,64}$/.test(input.name) ? input.name : 'unknown';
      this.#db.prepare('INSERT INTO external_operation_labels VALUES (?,?,?,?)').run(lease.task.id,operationId,toolName,Date.now());
      return { ...record, firstAttempt: true };
    });
    if (pending.output !== null) return JSON.parse(pending.output) as JsonObject;
    let output: JsonObject;
    try { output = await execute(pending.execution_id, pending.firstAttempt); }
    catch { output = { error: 'outcome_unknown' }; }
    if (output.error === 'outcome_unknown') {
      if (this.active(actor, lease)) this.wait(actor, lease, 'waiting_user', '外部処理の実行結果を確認できません。再開時に実行サービスの記録を照合します。');
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
  /** Bind at a task boundary. Existing saved actions keep the old composition until this task ends. */
  bindPrompt(actor:Actor,lease:TaskLease,preferred:'legacy-v4'|'structured-v5'):'legacy-v4'|'structured-v5'{
    this.#owned(actor,lease);check(['legacy-v4','structured-v5'].includes(preferred),'invalid','Unknown prompt version');
    const version=this.steps(actor,lease.task.id).length?'legacy-v4':preferred;
    this.#db.prepare('INSERT OR IGNORE INTO task_prompt_versions VALUES (?,?)').run(lease.task.id,version);
    return this.#db.prepare('SELECT version FROM task_prompt_versions WHERE task_id=?').get(lease.task.id)!.version as 'legacy-v4'|'structured-v5';
  }
  recordPrompt(actor:Actor,lease:TaskLease,input:{version:string;phase:string;rules_revision:number;memory_revision:number;input_bytes:number;estimated_input_tokens:number;removed_messages:number}){
    this.#owned(actor,lease);
    return Number(this.#db.prepare('INSERT INTO prompt_runs(task_id,version,phase,rules_revision,memory_revision,input_bytes,estimated_input_tokens,removed_messages,created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(lease.task.id,input.version,input.phase,input.rules_revision,input.memory_revision,input.input_bytes,input.estimated_input_tokens,input.removed_messages,Date.now()).lastInsertRowid);
  }
  finishPrompt(actor:Actor,lease:TaskLease,id:number,events:readonly ModelEvent[]){
    this.get(actor,lease.task.id);const usage=events.filter(e=>e.type==='usage').at(-1);
    this.#db.prepare('UPDATE prompt_runs SET status=?,input_tokens=?,output_tokens=? WHERE id=? AND task_id=?').run(events.some(e=>e.type==='failed')?'failed':events.some(e=>e.type==='completed')?'completed':'unknown',usage?.input_tokens??null,usage?.output_tokens??null,id,lease.task.id);
  }
  promptRuns(actor:Actor,id:string){this.get(actor,id);return this.#db.prepare('SELECT * FROM prompt_runs WHERE task_id=? ORDER BY id').all(id);}
  steps(actor: Actor, id: string): { step: number; memory_revision: number; rules_revision: number; discarded: number; events: ModelEvent[] }[] {
    const task = this.get(actor, id);
    const db = this.#access.memory(actor, task.agent_id);
    const rows = db.prepare('SELECT step,memory_revision,rules_revision,discarded,events FROM task_steps WHERE task_id=? ORDER BY step').all(id) as { step: number; memory_revision: number; rules_revision: number; discarded: number; events: string }[];
    return rows.map(row => ({ ...row, events: JSON.parse(row.events) as ModelEvent[] }));
  }
  #summaries = new Map<string,{call:string;revision:number;text:string}>();
  activity(actor:Actor,lease:TaskLease,call:string,phase:string,status='running',revision?:number) {
    this.#owned(actor,lease);
    const memory=revision??Number(this.#access.memory(actor,lease.task.agent_id).prepare('SELECT revision FROM memory_state WHERE id=1').get()!.revision);
    const rules=Number(this.#db.prepare('SELECT revision FROM common_rules WHERE id=1').get()!.revision),now=Date.now();
    this.#db.prepare(`INSERT INTO task_activity VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET
      call_id=excluded.call_id,lease=excluded.lease,memory_revision=excluded.memory_revision,rules_revision=excluded.rules_revision,
      phase=excluded.phase,status=excluded.status,started_at=CASE WHEN call_id=excluded.call_id THEN started_at ELSE excluded.started_at END,updated_at=excluded.updated_at`)
      .run(lease.task.id,call,lease.token,memory,rules,phase,status,now,now);
    if(this.#summaries.get(lease.task.id)?.call!==call)this.#summaries.delete(lease.task.id);
  }
  summary(actor:Actor,lease:TaskLease,call:string,revision:number,body:string) {
    if(!this.active(actor,lease))return;
    const row=this.#db.prepare('SELECT * FROM task_activity WHERE task_id=?').get(lease.task.id);
    const current=this.#access.memory(actor,lease.task.agent_id).prepare('SELECT revision FROM memory_state WHERE id=1').get()!.revision;
    if(!row||row.call_id!==call||row.lease!==lease.token||current!==revision)return;
    // Replacement snapshots, never a fragment log. Only active calls retain display text.
    this.#summaries.set(lease.task.id,{call,revision,text:redactSecrets(body).slice(0,4000)});
    if(this.#summaries.size>100)this.#summaries.delete(this.#summaries.keys().next().value!);
    this.#db.prepare('UPDATE task_activity SET updated_at=? WHERE task_id=?').run(Date.now(),lease.task.id);
  }
  waitKind(actor:Actor,lease:TaskLease,kind:string) {
    this.#owned(actor,lease,false);
    this.#db.prepare('INSERT INTO task_waits VALUES (?,?) ON CONFLICT(task_id) DO UPDATE SET kind=excluded.kind').run(lease.task.id,kind);
  }
  clearActivity(actor:Actor,id:string) {
    this.#admin(actor);this.get(actor,id);this.#summaries.delete(id);
    for(const table of ['task_activity','task_observations','task_waits','task_memory_skips'])this.#db.prepare('DELETE FROM '+table+' WHERE task_id=?').run(id);
  }
  progress(actor:Actor,id:string,factsOnly=false) {
    const task=this.get(actor,id),row=this.#db.prepare('SELECT * FROM task_activity WHERE task_id=?').get(id);
    const deleted=!!this.#db.prepare('SELECT 1 FROM deleted_agents WHERE id=?').get(task.agent_id);
    const revision=deleted?null:factsOnly?row?.memory_revision:this.#access.memory(actor,task.agent_id).prepare('SELECT revision FROM memory_state WHERE id=1').get()!.revision;
    const rules=this.#db.prepare('SELECT revision FROM common_rules WHERE id=1').get()!.revision;
    const current=!deleted&&row?.memory_revision===revision&&row?.rules_revision===rules;
    const active=task.state==='running'&&!task.paused&&!this.#paused()&&current&&row?.lease===this.#read(id).lease_token;
    const waiting=this.#db.prepare('SELECT kind FROM task_waits WHERE task_id=?').get(id)?.kind??'unknown';
    const kind=task.paused||this.#paused()?'paused':['waiting_provider','waiting_user'].includes(task.state)&&waiting!=='unknown'?String(waiting):task.state;
    const labels:Record<string,string>={running:'作業中',paused:'停止中',queued:'順番待ち',waiting_child:'仲間の結果待ち',waiting_provider:'理由未確認の待機',waiting_user:'対応待ち（理由未確認）',user_input:'管理者の入力待ち',approval:'承認の判断待ち',invalid_output:'応答形式の確認待ち',budget:'自発活動の利用枠待ち',schedule_budget:'予定の利用枠待ち',network:'接続を再試行中',authentication:'認証の確認待ち',provider_quota:'接続先の利用枠待ち',unknown:'理由未確認の待機',stalled:'進展がないため再確認待ち',completed:'完了',failed:'失敗',cancelled:'中止'};
    const phases:Record<string,string>={resolve:'接続を準備中',model:'返答を考え中',memory_review:'記憶を整理中',task_summary_save:'結果を整理中',read:'資料を確認中',execute:'コードを実行中',tool:'操作中'};
    const summary=this.#summaries.get(id);
    return {task_id:id,agent_id:task.agent_id,state:task.state,kind,label:active?(phases[String(row.phase)]??'作業中'):(labels[kind]??'状態を確認中'),
      phase:current?row?.phase:null,status:active?row.status:task.state,started_at:current?row?.started_at:null,last_activity_at:current?row?.updated_at:null,
      retry_at:task.state==='waiting_provider'?task.provider_retry_at:null,
      summary:!factsOnly&&active&&summary&&summary.call===row.call_id&&summary.revision===revision?summary.text:null,
      recent:!factsOnly&&current?this.#db.prepare('SELECT name,failure,created_at FROM task_observations WHERE task_id=? AND memory_revision=? AND rules_revision=? ORDER BY rowid DESC LIMIT 6').all(id,revision!,rules!):[],
      waiting_for:task.state==='waiting_child'?this.#db.prepare("SELECT DISTINCT a.name FROM tasks t JOIN agents a ON a.id=t.agent_id WHERE t.parent_id=? AND t.state NOT IN ('completed','failed','cancelled')").all(id).map(r=>r.name):[]};
  }
  observe(actor:Actor,lease:TaskLease,operation:string,name:string,args:JsonObject,result:JsonObject) {
    this.#owned(actor,lease);const memory=this.#access.memory(actor,lease.task.agent_id).prepare('SELECT revision FROM memory_state WHERE id=1').get()!.revision;
    const rules=this.#db.prepare('SELECT revision FROM common_rules WHERE id=1').get()!.revision;
    const read=/^(task_history_read|history_read|web_read|browser_navigate|browser_snapshot|workspace_read|workspace_list)$/.test(name);
    const raw=JSON.stringify(result),failure=result.error?String(result.failure_kind??'unknown'):null;
    // History pages reference their source; never recursively embed another history read.
    const value=name==='history_read'?{source_reference:args,retained:false}:name==='task_history_read'?{step:args.step,offset:args.offset,revision:result.revision??null,next_offset:result.next_offset??null,history_reference:true}:
      raw.length<=20000?result:{retained:false,reason:'Read the original source in pages',bytes:Buffer.byteLength(raw)};
    const stable=JSON.stringify(result,(key,value)=>['fetched_at','checked_at','observed_at'].includes(key)?undefined:value);
    const fingerprint=createHash('sha256').update(JSON.stringify(result.history_indirection===true?[name,'history-indirection']:[name,args,stable])).digest('hex');
    this.#db.prepare('INSERT OR IGNORE INTO task_observations VALUES (?,?,?,?,?,?,?,?,?)').run(lease.task.id,operation,Number(memory),Number(rules),name,(read?'read:':'work:')+fingerprint,redactSecrets(JSON.stringify(value)),failure,Date.now());
    this.#db.prepare('DELETE FROM task_observations WHERE task_id=? AND rowid NOT IN (SELECT rowid FROM task_observations WHERE task_id=? ORDER BY rowid DESC LIMIT 32)').run(lease.task.id,lease.task.id);
  }
  observations(actor:Actor,lease:TaskLease) {
    this.#owned(actor,lease);const revision=this.#access.memory(actor,lease.task.agent_id).prepare('SELECT revision FROM memory_state WHERE id=1').get()!.revision;
    const rules=this.#db.prepare('SELECT revision FROM common_rules WHERE id=1').get()!.revision;
    const rows=this.#db.prepare('SELECT * FROM task_observations WHERE task_id=? AND memory_revision=? AND rules_revision=? AND created_at>? ORDER BY rowid').all(lease.task.id,Number(revision),Number(rules),Date.now()-30*60_000);
    let repeats=0;const seen=new Set();
    for(const row of rows){if(!String(row.fingerprint).startsWith('read:')){if(!['work_note','task_plan_update','coordination_read'].includes(String(row.name))){repeats=0;seen.clear();}continue;}if(seen.has(row.fingerprint))repeats++;else {seen.add(row.fingerprint);repeats=0;}}
    return {repeated_reads:repeats,recovery:repeats>=3?'同じ資料/版/ページや取得失敗への巡回です。以下の観測を使い、別の方法か分かった範囲の回答へ進んでください。観測は原資料・実行証拠の代わりではありません。':null,
      recent:rows.slice(-8).map(row=>({operation_id:row.operation_id,name:row.name,observed_at:row.created_at,failure:row.failure,result_preview:String(row.result).slice(0,1500)}))};
  }
  /** Read the current task's private transcript, never another task or a superseded memory revision. */
  readStep(actor: Actor, lease: TaskLease, step: number, offset = 0, revision: string | null = null): JsonObject {
    const task = this.#owned(actor, lease); this.#access.room(actor, task.room_id);
    check(Number.isSafeInteger(step) && step >= 0 && Number.isSafeInteger(offset) && offset >= 0, 'invalid', 'Invalid history position');
    check(revision === null || /^[a-f0-9]{64}$/.test(revision), 'invalid', 'Invalid history revision');
    check(offset === 0 || revision !== null, 'invalid', 'A revision is required for continuation');
    const db = this.#access.memory(actor, task.agent_id);
    const row = db.prepare(`SELECT events,memory_revision FROM task_steps WHERE task_id=? AND step=? AND discarded=0 AND rules_revision=?
      AND memory_revision=(SELECT revision FROM memory_state WHERE id=1)`).get(task.id, step,this.#db.prepare('SELECT revision FROM common_rules WHERE id=1').get()!.revision!);
    check(row, 'not_found', 'Task history is unavailable');
    const events = JSON.parse(String(row.events)) as ModelEvent[];
    const calls = events.filter((event): event is Extract<ModelEvent, { type: 'tool_call' }> => event.type === 'tool_call');
    const results = calls.map((call, index) => {
      if(call.name==='task_history_read')return {tool_call_id:call.tool_call_id,name:call.name,result:{history_reference:call.arguments}};

      const inputHash = createHash('sha256').update(JSON.stringify({ name: call.name, arguments: call.arguments })).digest('hex');
      const receipt = this.#db.prepare('SELECT input AS input_hash,output FROM tool_receipts WHERE task_id=? AND operation_id=?').get(task.id, `${step}:${index}`)
        ?? this.#db.prepare('SELECT input_hash,output FROM external_operations WHERE task_id=? AND operation_id=?').get(task.id, `${step}:${index}`);
      return { tool_call_id: call.tool_call_id, name: call.name,
        result: receipt?.input_hash === inputHash && receipt.output !== null ? JSON.parse(String(receipt.output)) as JsonObject : (()=>{const observation=this.#db.prepare('SELECT result FROM task_observations WHERE task_id=? AND operation_id=? AND memory_revision=?').get(task.id,`${step}:${index}`,row.memory_revision!);return observation?JSON.parse(String(observation.result)):{retained:false,reason:'No retained result; this does not establish failure'};})() };
    });
    const content = JSON.stringify({ events, tool_results: results });
    const current = createHash('sha256').update(JSON.stringify([task.agent_id, task.room_id, task.id, step, row.memory_revision, content])).digest('hex');
    check(revision === null || revision === current, 'conflict', 'Task history changed; read from the beginning');
    check(offset <= content.length, 'invalid', 'History offset is outside the source');
    const end = Math.min(offset + 20_000, content.length);
    return { task_id: task.id, step, revision: current, offset, text: content.slice(offset, end),history_indirection:calls.length>0&&calls.every(call=>call.name==='task_history_read'),
      next_offset: end < content.length ? end : null, untrusted: true };
  }
  saveStep(actor: Actor, lease: TaskLease, memoryRevision: number, events: readonly ModelEvent[]): number {
    const task = this.#owned(actor, lease);
    const db = this.#access.memory(actor, task.agent_id);
    return transaction(db, () => {
      const { next } = db.prepare('SELECT coalesce(max(step),-1)+1 AS next FROM task_steps WHERE task_id=?').get(lease.task.id) as { next: number };
      const rules = this.#db.prepare('SELECT revision FROM common_rules WHERE id=1').get()!;
      db.prepare('INSERT INTO task_steps(task_id,step,memory_revision,events,rules_revision) VALUES (?,?,?,?,?)').run(lease.task.id, next, memoryRevision, JSON.stringify(events), rules.revision!);
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
      if (this.independentActivity(actor,lease)) {
        check(!parent.parent_id,'forbidden','Independent work cannot create delegation chains');
        check(!this.#db.prepare("SELECT 1 FROM tasks WHERE agent_id=? AND room_id=? AND prompt=? AND state NOT IN ('completed','failed','cancelled')").get(agentId,parent.room_id,prompt),'conflict','This work is already pending');
        check(!this.#db.prepare('SELECT 1 FROM tasks WHERE parent_id=? AND agent_id=?').get(parent.id,agentId),'conflict','This recipient already has this independent assignment');
      }
      text(prompt, 19_000); // Leave room for the recipient in the visible chat message.
      check(parent.agent_id !== agentId, 'invalid', 'Use the current task instead of delegating to yourself');
      const child = this.create(actor, agentId, parent.room_id, prompt, parent.deadline_at);
      this.#db.prepare('UPDATE tasks SET parent_id=? WHERE id=?').run(parent.id, child.id);
      this.#db.prepare(`INSERT OR IGNORE INTO initiative_tasks SELECT ?,l.initiative_id FROM initiative_tasks l JOIN initiatives i ON i.id=l.initiative_id WHERE l.task_id=? AND EXISTS(SELECT 1 FROM json_each(i.body,'$.participants') WHERE value=?)`).run(child.id,parent.id,agentId);
      const messageId = this.#access.announceDelegation(actor, parent.room_id, agentId, prompt);
      this.#db.prepare('UPDATE tasks SET source_message_id=? WHERE id=?').run(messageId, child.id);
      this.#change(parent.id, 'waiting_child');
      return publicTask(this.#read(child.id));
    });
  }
  address(actor: Actor, lease: TaskLease, agentId: string, prompt: string, sourceMessageId?: string): void {
    const task = this.#owned(actor, lease);
    if (!this.#access.participant(agentId, task.room_id)) {
      this.#db.prepare(`INSERT INTO updates(room_id,author_id,kind,title,detail,task_id,created_at)
        VALUES (?,?,'question',?,?,?,?)`).run(task.room_id, task.agent_id, '会話の宛先を確認してください', '宛先のBotがこの会話に参加できないため、配送できませんでした。', task.id, Date.now());
      return;
    }
    if(this.independentActivity(actor,lease)) return; // Deliberate delegation only; status messages never start reply chains.
    const next = this.create(actor, agentId, task.room_id, prompt, task.deadline_at);
    this.#db.prepare('UPDATE tasks SET parent_id=?,conversation_reply=1,source_message_id=? WHERE id=?').run(task.id, sourceMessageId ?? null, next.id);
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
    if (this.#db.prepare("SELECT 1 FROM tasks WHERE parent_id=? AND state NOT IN ('completed','failed','cancelled') AND id NOT IN(SELECT task_id FROM task_child_dependencies WHERE required=0)").get(parentId)) return;
    this.#change(parentId, 'queued');
    this.#db.prepare('UPDATE tasks SET lease_token=NULL WHERE id=?').run(parentId);
  }
  wait(actor: Actor, lease: TaskLease, state: 'waiting_user' | 'waiting_provider', reason: string, retryProvider = false): void {
    check(state === 'waiting_user' || state === 'waiting_provider', 'invalid', 'Invalid wait state');
    check(!retryProvider || state === 'waiting_provider', 'invalid', 'Only provider waits can retry automatically');
    text(reason, 1000);
    transaction(this.#db, () => {
      this.#owned(actor, lease); this.#change(lease.task.id, state, null, reason);this.waitKind(actor,lease,'unknown');
      if (retryProvider) this.#db.prepare('UPDATE tasks SET provider_retry_at=? WHERE id=?').run(Date.now() + (lease.task.internal_autonomous ? Math.min(60,15*2**Math.min(lease.task.attempt-1,2))*60_000 : 60_000), lease.task.id);
    });
  }
  retryProviders(actor: Actor, now = Date.now()): void {
    this.#admin(actor);
    check(Number.isSafeInteger(now) && now >= 0, 'invalid', 'Invalid retry time');
    if (this.#paused()) return;
    transaction(this.#db, () => {
      const due = this.#db.prepare(`SELECT t.id,t.agent_id,t.room_id FROM tasks t
        WHERE t.state='waiting_provider' AND t.paused=0 AND t.provider_retry_at<=? AND t.deadline_at>?
        AND NOT EXISTS(SELECT 1 FROM room_preferences p WHERE p.room_id=t.room_id AND p.archived=1)`).all(now, now) as { id: string; agent_id: string; room_id: string }[];
      for (const task of due) {
        if (!this.#access.participant(task.agent_id, task.room_id)) continue;
        this.#change(task.id, 'queued');
        this.#db.prepare('UPDATE tasks SET lease_token=NULL WHERE id=?').run(task.id);
      }
    });
  }
  /** Recover only obsolete automatic count stops; real questions and approvals stay pending. */
  recoverCountLimits(actor: Actor): void {
    this.#admin(actor);
    if (this.#paused()) return;
    transaction(this.#db, () => {
      const tasks = this.#db.prepare(`SELECT id,agent_id,room_id FROM tasks t WHERE state='waiting_user' AND paused=0
        AND wait_reason IN (?,?) AND deadline_at>?
        AND NOT EXISTS(SELECT 1 FROM approval_requests a WHERE a.task_id=t.id AND a.status='pending')
        AND NOT EXISTS(SELECT 1 FROM room_preferences p WHERE p.room_id=t.room_id AND p.archived=1)`)
        .all(CONVERSATION_LIMIT_REASON, TURN_LIMIT_REASON, Date.now()) as { id: string; agent_id: string; room_id: string }[];
      for (const task of tasks) {
        if (!this.#access.participant(task.agent_id, task.room_id)) continue;
        this.#change(task.id, 'queued');
        this.#db.prepare('UPDATE tasks SET lease_token=NULL WHERE id=?').run(task.id);
      }
    });
  }
  resume(actor: Actor, id: string, answer?: string): void {
    this.#admin(actor);
    check(!this.#db.prepare("SELECT 1 FROM approval_requests WHERE task_id=? AND status='pending'").get(id), 'conflict', 'Decide the pending approval first');
    transaction(this.#db, () => {
      const task = this.get(actor, id);
      check(!this.#db.prepare('SELECT 1 FROM deleted_agents WHERE id=?').get(task.agent_id), 'not_found', 'Agent not found');
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
      const task = this.get(actor, id);
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
      const task = this.get(actor, id);
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
      const task = this.get(actor, id);
      check(!this.#db.prepare('SELECT 1 FROM deleted_agents WHERE id=?').get(task.agent_id), 'not_found', 'Agent not found');
      check(['failed', 'cancelled'].includes(task.state), 'conflict', 'Task cannot be retried');
      check(task.conversation_reply === 1 || !task.parent_id || this.#read(task.parent_id).state === 'waiting_child', 'conflict', 'Parent has already continued; submit a new request');
      this.#db.prepare('UPDATE tasks SET paused=0,lease_token=NULL,deadline_at=? WHERE id=?').run(NO_DEADLINE, id);
      this.#change(id, 'queued');
      this.#event(id, 'retried');
    });
  }
  complete(actor: Actor, id: string): void {
    this.#admin(actor);
    transaction(this.#db, () => {
      const task = this.get(actor, id);
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
  timebox(actor: Actor, lease: TaskLease, seconds: number) {
    const task=this.#owned(actor,lease);
    check(Number.isSafeInteger(seconds) && seconds>=1 && seconds<=86_400,'invalid','Timebox must be 1–86400 seconds');
    const deadline=Math.min(task.deadline_at,Date.now()+seconds*1000);
    transaction(this.#db,()=>{
      this.#db.prepare(`WITH RECURSIVE descendants(id) AS (SELECT ? UNION ALL SELECT t.id FROM tasks t JOIN descendants d ON t.parent_id=d.id)
        UPDATE tasks SET deadline_at=min(deadline_at,?),updated_at=? WHERE id IN (SELECT id FROM descendants) AND state NOT IN ('completed','failed','cancelled')`).run(task.id,deadline,Date.now());
      this.#event(task.id,'timeboxed');
    });
    return {deadline_at:deadline};
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
  /** A backup predates possible external effects. Restored work may only reconcile existing intents. */
  protectRestoredWork(actor: Actor): void {
    this.#admin(actor);
    transaction(this.#db, () => {
      this.#db.exec('INSERT OR IGNORE INTO restored_tasks SELECT id FROM tasks; UPDATE settings SET autonomous=0 WHERE id=1; UPDATE quality_settings SET enabled=0; UPDATE initiative_settings SET enabled=0; UPDATE workarea_settings SET enabled=0; UPDATE workareas SET available=0; UPDATE artifact_files SET available=0; DELETE FROM task_workareas;');
      this.#db.prepare("UPDATE execution_bindings SET state='cancelled',waiting=0,result=NULL").run();
      this.#db.prepare('UPDATE workarea_settings SET epoch=?').run(randomUUID());
      this.#db.prepare("UPDATE schedules SET enabled=0,wait_reason=? WHERE deleted=0")
        .run('バックアップから復元した予定です。実行済みの履歴と次回日時を確認してから再開してください。');
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
  history(actor: Actor, id: string): TaskEvent[] {
    this.get(actor, id);
    return (this.#db.prepare('SELECT * FROM task_events WHERE task_id=? ORDER BY sequence DESC LIMIT 100').all(id) as unknown as TaskEvent[]).reverse();
  }
  events(actor: Actor, after = 0): TaskEvent[] {
    check(Number.isSafeInteger(after) && after >= 0, 'invalid', 'Invalid event cursor');
    const allowed = new Set(this.list(actor).map(task => task.id));
    return (this.#db.prepare('SELECT * FROM task_events WHERE sequence>? ORDER BY sequence').all(after) as unknown as TaskEvent[])
      .filter(event => allowed.has(event.task_id));
  }
}
