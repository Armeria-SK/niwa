import {randomUUID,createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {Type,type Static} from '@sinclair/typebox';
import {Value} from '@sinclair/typebox/value';
import {check} from '../domain/types.ts';
import {transaction} from '../storage/database.ts';
import type {Runtime,Actor} from './runtime.ts';
import type {TaskLease} from '../domain/task.ts';
const text=()=>Type.String({minLength:1,maxLength:2000});const id=Type.String({maxLength:100});
const object=<T extends Parameters<typeof Type.Object>[0]>(p:T)=>Type.Object(p,{additionalProperties:false});
export const initiativeBodySchema=object({purpose:text(),reason:text(),completion:text(),next_action:text(),method:text(),last_result:Type.String({maxLength:2000}),
 participants:Type.Array(id,{minItems:1,maxItems:100,uniqueItems:true}),workarea:Type.Union([id,Type.Null()]),artifacts:Type.Array(id,{maxItems:20,uniqueItems:true}),
 wait:object({kind:Type.Union([Type.Literal('none'),Type.Literal('search_failed'),Type.Literal('approval'),Type.Literal('user_input'),Type.Literal('child'),Type.Literal('model'),Type.Literal('rest')]),detail:Type.String({maxLength:2000}),task_id:Type.Union([id,Type.Null()])})});
export type InitiativeBody=Static<typeof initiativeBodySchema>;
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value??null)).digest('hex');
type Row={id:string;owner_id:string;room_id:string;revision:number;body:string;state:string;review_at:number;review_reason:string;signal:string;last_checked:number;stagnant:number};
/** Long-lived references to existing tasks, plans and artifacts, never another job queue or authority. */
export class Initiatives{
 constructor(private db:DatabaseSync,private runtime:Runtime,private principal:(actor:Actor)=>{kind:string;id:string}){}
 enabled(){return this.db.prepare('SELECT enabled FROM initiative_settings WHERE id=1').get()!.enabled===1;}
 settings(actor:Actor){check(this.principal(actor).kind==='admin','forbidden','Administrator required');return {enabled:this.enabled()};}
 enable(actor:Actor,value:boolean){this.settings(actor);this.db.prepare('UPDATE initiative_settings SET enabled=? WHERE id=1').run(Number(value));}
 private row(id:string){const row=this.db.prepare('SELECT * FROM initiatives WHERE id=?').get(id) as unknown as Row|undefined;check(row,'not_found','Initiative unavailable');return row;}
 private access(actor:Actor,row:Row){const who=this.principal(actor);check(this.runtime.rooms(actor).some(r=>r.id===row.room_id),'forbidden','Conversation access required');
  const body=JSON.parse(row.body) as InitiativeBody;
  check(who.kind==='admin'||body.participants.includes(who.id),'forbidden','Not an initiative participant');return body;}
 get(actor:Actor,id:string){const row=this.row(id),body=this.access(actor,row);const {signal:_signal,...metadata}=row;return {...metadata,body,
  tasks:this.db.prepare('SELECT t.id,t.state,t.wait_reason FROM tasks t JOIN initiative_tasks i ON i.task_id=t.id WHERE i.initiative_id=? ORDER BY t.created_at DESC LIMIT 30').all(id),
  waits:this.db.prepare(`SELECT t.id,t.wait_reason,CASE WHEN EXISTS(SELECT 1 FROM approval_requests a WHERE a.task_id=t.id AND a.status='pending') THEN '操作の承認'
   WHEN t.state='waiting_child' THEN '子タスクの結果' WHEN t.state='waiting_provider' THEN 'モデル接続・利用枠'
   WHEN EXISTS(SELECT 1 FROM updates u WHERE u.task_id=t.id AND u.kind='question') THEN '質問への回答' ELSE '仕事の見直し' END AS reason
   FROM tasks t WHERE (t.id IN (SELECT task_id FROM initiative_tasks WHERE initiative_id=?) OR t.id=?) AND t.state IN ('waiting_user','waiting_child','waiting_provider')`).all(id,body.wait.task_id),
  evidence:this.db.prepare('SELECT reference,conclusion,kind FROM initiative_evidence WHERE initiative_id=?').all(id)};}
 list(actor:Actor){this.principal(actor);return this.db.prepare('SELECT id FROM initiatives ORDER BY rowid DESC').all().flatMap(r=>{try{return [this.get(actor,String(r.id))];}catch{return [];}});}
 current(actor:Actor,task:string){const row=this.db.prepare('SELECT initiative_id FROM initiative_tasks WHERE task_id=?').get(task);if(!row)return null;try{return this.get(actor,String(row.initiative_id));}catch{return null;}}
 select(actor:Actor,lease:TaskLease,id:string){check(this.enabled()&&!this.db.prepare('SELECT paused FROM settings WHERE id=1').get()!.paused&&this.runtime.tasks.active(actor,lease),'forbidden','Active task and enabled initiatives required');
  const row=this.row(id),body=this.access(actor,row);check(row.room_id===lease.task.room_id,'forbidden','Do not cross conversation scopes');
  const existing=this.db.prepare('SELECT initiative_id FROM initiative_tasks WHERE task_id=?').get(lease.task.id);check(!existing||existing.initiative_id===id,'conflict','This task already belongs to another initiative');
  check(existing||!lease.task.internal_autonomous||row.review_at<=Date.now(),'conflict','This initiative is resting until its review time; choose independent work');
  check(row.state!=='paused'&&row.state!=='completed','conflict','Initiative is stopped');
  // Selecting a stored workarea still runs the ordinary task/participant checks.
  if(body.workarea&&!this.runtime.tasks.independentActivity(actor,lease))this.runtime.workareas.select(actor,lease,body.workarea);
  this.db.prepare('INSERT OR IGNORE INTO initiative_tasks VALUES (?,?)').run(lease.task.id,id);
  return this.get(actor,id);
 }
 save(actor:Actor,lease:TaskLease,input:{id:string|null;expected_revision:number;body:InitiativeBody;state:'active'|'resting'|'completed';review_at:number}){
  check(this.enabled()&&!this.db.prepare('SELECT paused FROM settings WHERE id=1').get()!.paused&&this.runtime.tasks.active(actor,lease),'forbidden','Active task required');
  check(Value.Check(initiativeBodySchema,input.body),'invalid','Invalid initiative');
  check(['active','resting','completed'].includes(input.state)&&Number.isSafeInteger(input.review_at)&&input.review_at>=0,'invalid','Invalid review time');
  check(Number.isSafeInteger(input.expected_revision)&&input.expected_revision>=0,'invalid','Invalid revision');
  const who=this.principal(actor);check(who.kind==='agent','forbidden','Bot task required');
  const existing=input.id?this.row(input.id):undefined;
  if(existing){this.access(actor,existing);check(existing.state!=='paused','forbidden','Administrator-paused initiative cannot be resumed by a Bot');check(existing.owner_id===who.id,'forbidden','Only the owner changes the initiative');check(existing.room_id===lease.task.room_id&&existing.revision===input.expected_revision,'conflict','Initiative changed');}
  else check(input.expected_revision===0,'conflict','New initiative requires revision zero');
  const body=input.body,available=this.runtime.agents(actor);check(body.participants.includes(who.id)&&body.participants.every(id=>available.some(a=>a.id===id)&&this.runtime.rooms(this.runtime.agentSession(id)).some(r=>r.id===lease.task.room_id)),'forbidden','Participants must have conversation access');
  if(body.workarea){const area=this.runtime.workareas.authorize(actor,body.workarea,lease);check(area.room_id===lease.task.room_id,'forbidden','Workarea scope mismatch');}
  for(const id of body.artifacts)check(this.runtime.artifacts(actor).some(a=>a.id===id&&a.room_id===lease.task.room_id),'forbidden','Artifact scope mismatch');
  this.validateWait(actor,lease,body);
  const id=existing?.id??randomUUID();
  if(!existing){const prior=this.list(actor).find(v=>v.room_id===lease.task.room_id&&v.owner_id===who.id&&v.body.purpose.trim()===body.purpose.trim()&&!['completed','paused'].includes(v.state));check(!prior,'conflict','Continue the existing initiative');}
  transaction(this.db,()=>{if(existing)this.db.prepare('UPDATE initiatives SET revision=revision+1,body=?,state=?,review_at=? WHERE id=?').run(JSON.stringify(body),input.state,Math.max(input.review_at,existing.last_checked+900000),id);
   else this.db.prepare('INSERT INTO initiatives(id,owner_id,room_id,revision,body,state,review_at) VALUES (?,?,?,1,?,?,?)').run(id,who.id,lease.task.room_id,JSON.stringify(body),input.state,input.review_at);
   if(!['completed','paused'].includes(input.state)){const link=this.db.prepare('SELECT initiative_id FROM initiative_tasks WHERE task_id=?').get(lease.task.id);check(!link||link.initiative_id===id,'conflict','Task already linked');this.db.prepare('INSERT OR IGNORE INTO initiative_tasks VALUES (?,?)').run(lease.task.id,id);this.select(actor,lease,id);}
   else {const link=this.db.prepare('SELECT initiative_id FROM initiative_tasks WHERE task_id=?').get(lease.task.id);check(!link||link.initiative_id===id,'conflict','Task already linked');this.db.prepare('INSERT OR IGNORE INTO initiative_tasks VALUES (?,?)').run(lease.task.id,id);}
  });return this.get(actor,id);
 }
 private validateWait(actor:Actor,lease:TaskLease,body:InitiativeBody){
  const wait=body.wait;if(['none','search_failed','rest'].includes(wait.kind))return;
  check(wait.task_id&&wait.detail.trim(),'invalid','Concrete waiting task and question/reason required');
  const task=this.runtime.tasks.get(actor,wait.task_id);check(task.room_id===lease.task.room_id,'forbidden','Waiting task scope mismatch');
  check(task.agent_id===lease.task.agent_id||!!this.db.prepare('SELECT 1 FROM initiative_tasks WHERE task_id=? AND initiative_id IN (SELECT initiative_id FROM initiative_tasks WHERE task_id=?)').get(task.id,lease.task.id),'forbidden','Wait belongs to unrelated work');
  if(wait.kind==='approval')check(this.db.prepare("SELECT 1 FROM approval_requests WHERE task_id=? AND status='pending'").get(task.id),'conflict','Submit an actual approval request before calling it approval waiting');
  if(wait.kind==='user_input')check(task.state==='waiting_user'&&this.db.prepare("SELECT 1 FROM updates WHERE task_id=? AND kind='question'").get(task.id),'conflict','Concrete submitted user question required');
  if(wait.kind==='child')check(task.state==='waiting_child'&&this.db.prepare('SELECT 1 FROM tasks WHERE parent_id=?').get(task.id),'conflict','Actual child task required');
  if(wait.kind==='model')check(task.state==='waiting_provider','conflict','Actual model wait required');
 }
 evidence(actor:Actor,lease:TaskLease,kind:'finding'|'validation'|'rejected_hypothesis',reference:string,conclusion:string){
  check(this.runtime.tasks.active(actor,lease)&&conclusion.trim().length>0&&conclusion.length<=2000,'invalid','Active task and reasoned conclusion required');
  const current=this.current(actor,lease.task.id);check(this.enabled()&&current,'forbidden','Select an initiative');
  // Only actual tool observations/results can support progress, not file counts or a rewritten artifact.
  const receipt=this.db.prepare('SELECT output FROM tool_receipts WHERE task_id=? AND operation_id=?').get(lease.task.id,reference);
  const external=this.db.prepare('SELECT output FROM external_operations WHERE task_id=? AND operation_id=?').get(lease.task.id,reference);
  const execution=this.db.prepare("SELECT result FROM execution_bindings WHERE task_id=? AND id=? AND state='completed'").get(lease.task.id,reference);
  const value=JSON.parse(String(receipt?.output??external?.output??execution?.result??'null'));
  check(value&&((typeof value.url==='string'&&typeof value.fetched_at==='string'&&typeof value.text==='string')||Number.isInteger(value.code)),'invalid','Use a saved observation or execution result');
  check(['finding','validation','rejected_hypothesis'].includes(kind),'invalid','Invalid evidence kind');
  check(kind==='finding'?typeof value.url==='string':Number.isInteger(value.code),'invalid','Evidence kind does not match the result');
  const fingerprint=hash(typeof value.url==='string'?[value.url,value.text]:[value.environment??value.image,value.code,value.stdout,value.stderr]);
  const result=this.db.prepare('INSERT OR IGNORE INTO initiative_evidence VALUES (?,?,?,?,?)').run(current.id,fingerprint,conclusion,kind,lease.task.id);
  if(result.changes)this.db.prepare('UPDATE initiatives SET stagnant=0 WHERE id=?').run(current.id);
  return {recorded:!!result.changes,assessment:'supported_conclusion_not_automatic_quality_score'};
 }
 private signal(row:Row){const body=JSON.parse(row.body) as InitiativeBody;
  const tasks=this.db.prepare(`SELECT t.id,t.state,t.result,a.status FROM tasks t LEFT JOIN approval_requests a ON a.task_id=t.id WHERE t.id IN (SELECT task_id FROM initiative_tasks WHERE initiative_id=?) OR t.parent_id IN (SELECT task_id FROM initiative_tasks WHERE initiative_id=?) ORDER BY t.id`).all(row.id,row.id);
  const artifacts=body.artifacts.map(id=>this.db.prepare('SELECT v.artifact_id,v.version FROM artifact_versions v WHERE v.series_id=(SELECT series_id FROM artifact_versions WHERE artifact_id=?) ORDER BY v.version').all(id));
  const waiting=body.wait.task_id?this.db.prepare('SELECT t.state,t.result,a.status FROM tasks t LEFT JOIN approval_requests a ON a.task_id=t.id WHERE t.id=?').all(body.wait.task_id):[];
  // Other participants/user messages only; own status chatter must not keep waking itself.
  const messages=this.db.prepare('SELECT id FROM messages WHERE room_id=? AND (author_id IS NULL OR author_id<>?) ORDER BY rowid DESC LIMIT 1').get(row.room_id,row.owner_id);
  return JSON.stringify({子タスクと結果:hash(tasks),成果物の改訂:hash(artifacts),関連する発言:hash(messages),待ち条件の変化:hash(waiting)});
 }
 candidate(actor:Actor,agent:string,now:number){if(!this.enabled())return null;
  return this.list(actor).filter(r=>r.owner_id===agent&&r.state==='active'&&r.review_at<=now&&!this.runtime.roomPreferences(actor,r.room_id).archived).find(r=>!this.db.prepare("SELECT 1 FROM initiative_tasks i JOIN tasks t ON t.id=i.task_id WHERE i.initiative_id=? AND t.state IN ('queued','running') AND t.paused=0").get(r.id))??null;
 }
 observe(actor:Actor,now:number){check(this.principal(actor).kind==='admin','forbidden','Administrator required');if(!this.enabled())return;
  for(const row of this.db.prepare("SELECT * FROM initiatives WHERE state IN ('active','resting')").all() as unknown as Row[]){
   try{this.access(this.runtime.agentSession(row.owner_id),row);if(this.runtime.roomPreferences(actor,row.room_id).archived)continue;}catch{continue;}
   const signal=this.signal(row);
   if(signal!==row.signal){this.db.prepare('UPDATE initiatives SET signal=? WHERE id=?').run(signal,row.id);
    if(row.state==='active'){const previous=JSON.parse(row.signal||'{}'),current=JSON.parse(signal);const reason=Object.keys(current).filter(key=>current[key]!==previous[key]).join('・');this.db.prepare('UPDATE initiatives SET review_at=min(review_at,?),review_reason=? WHERE id=?').run(Math.max(now,row.last_checked+900000),reason,row.id);}
   }
   if(row.state==='resting'&&row.review_at<=now)this.db.prepare("UPDATE initiatives SET state='active' WHERE id=?").run(row.id);
  }
 }
 checkpoint(actor:Actor,lease:TaskLease,input:{tried:string;result:string;next_action:string;resume_condition:string;rest_minutes:number}){
  const current=this.current(actor,lease.task.id);if(!this.enabled()||!current||current.owner_id!==this.principal(actor).id||['paused','completed'].includes(current.state))return;
  const body={...current.body,method:input.tried,last_result:input.result,next_action:input.next_action};
  if(input.rest_minutes)body.wait={kind:'rest',detail:input.resume_condition,task_id:null};
  this.db.prepare('UPDATE initiatives SET body=?,revision=revision+1,state=?,review_at=? WHERE id=?').run(JSON.stringify(body),input.rest_minutes?'resting':current.state,input.rest_minutes?Date.now()+input.rest_minutes*60000:current.review_at,current.id);
 }
 due(actor:Actor,now:number){return this.list(actor).filter(r=>r.state==='active'&&r.review_at<=now);}
 prompt(actor:Actor,id:string){const row=this.get(actor,id);return `継続する取り組み：${JSON.stringify(row)}。既存の実物・方法と結果を引き継ぎ、次の具体的行動を選びます。保留操作は解除しません。停滞回数は見直し回数であり品質評価ではありません。新しい根拠のない言い換えを進展と扱わず方法を変えるか休息してください。`;}
 bind(task:string,id:string,now:number){const row=this.row(id);this.db.prepare('INSERT INTO initiative_tasks VALUES (?,?)').run(task,id);
  this.db.prepare(`UPDATE initiatives SET last_checked=?,review_at=?,signal=?,review_reason='見直し時刻',stagnant=stagnant+1 WHERE id=?`).run(now,now+Math.min(1440,15*2**Math.min(row.stagnant,6))*60000,this.signal(row),id);
 }
 pause(actor:Actor,id:string,expected:number,paused:boolean){check(this.principal(actor).kind==='admin','forbidden','Administrator required');const row=this.row(id);this.access(actor,row);check(row.revision===expected,'conflict','Initiative changed');transaction(this.db,()=>{this.db.prepare('UPDATE initiatives SET state=?,revision=revision+1 WHERE id=?').run(paused?'paused':'active',id);
   if(paused)for(const task of this.db.prepare("SELECT t.id FROM tasks t JOIN initiative_tasks l ON l.task_id=t.id WHERE l.initiative_id=? AND t.state NOT IN ('completed','failed','cancelled')").all(id))this.runtime.tasks.pause(actor,String(task.id));
  });}
}
