import {createHash,randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {Type,type Static} from '@sinclair/typebox';
import {Value} from '@sinclair/typebox/value';
import type {Runtime,Actor} from './runtime.ts';
import type {TaskLease} from '../domain/task.ts';
import {check,text} from '../domain/types.ts';
import {isAcknowledgment} from '../domain/coordination.ts';
import {transaction} from '../storage/database.ts';
const object=<T extends Parameters<typeof Type.Object>[0]>(p:T)=>Type.Object(p,{additionalProperties:false});
const note=()=>Type.String({minLength:1,maxLength:1000});
export const qualityPlanSchema=object({criteria:Type.Array(object({id:Type.String({pattern:'^[a-z0-9_-]{1,40}$'}),condition:note(),kind:Type.Union([Type.Literal('source'),Type.Literal('execution'),Type.Literal('review')])}),{minItems:1,maxItems:6}),stop_condition:note()});
export const qualityReviewSchema=Type.Array(object({criterion:Type.String({maxLength:40}),verdict:Type.Union([Type.Literal('pass'),Type.Literal('fail'),Type.Literal('unknown')]),note:note()}),{minItems:1,maxItems:6});
export type QualityPlan=Static<typeof qualityPlanSchema>;
export type QualityReview=Static<typeof qualityReviewSchema>;
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
type Evidence={id:string;artifact_id:string;sha256:string;criterion:string;author_id:string;source_task:string;source_operation:string;body:string;created_at:number};
/** Evidence extends the existing fixed-version review; it never authorizes external operations. */
export class ArtifactQuality{
 constructor(private db:DatabaseSync,private runtime:Runtime,private principal:(a:Actor)=>{kind:string;id:string}){}
 enabled(){return this.db.prepare('SELECT enabled FROM quality_settings WHERE id=1').get()!.enabled===1;}
 settings(actor:Actor){check(this.principal(actor).kind==='admin','forbidden','Administrator required');return {enabled:this.enabled()};}
 enable(actor:Actor,enabled:boolean){this.settings(actor);this.db.prepare('UPDATE quality_settings SET enabled=?').run(Number(enabled));}
 plan(actor:Actor,lease:TaskLease,expected:number,body:QualityPlan){
  check(this.enabled()&&this.runtime.tasks.active(actor,lease),'forbidden','Quality checks are disabled or task inactive');
  check(Value.Check(qualityPlanSchema,body)&&new Set(body.criteria.map(c=>c.id)).size===body.criteria.length,'invalid','Choose distinct, concrete completion conditions');
  const prior=this.db.prepare('SELECT revision FROM task_quality WHERE task_id=?').get(lease.task.id);
  check(Number(prior?.revision??0)===expected,'conflict','Completion conditions changed');
  check(!this.db.prepare('SELECT 1 FROM updates WHERE task_id=? AND artifact_id IS NOT NULL').get(lease.task.id),'conflict','Save conditions before creating the artifact; revise the work instead of lowering its checks');
  this.db.prepare('INSERT INTO task_quality VALUES (?,?,?) ON CONFLICT(task_id) DO UPDATE SET revision=excluded.revision,body=excluded.body').run(lease.task.id,expected+1,JSON.stringify(body));return {revision:expected+1};
 }
 attach(artifact:string,task?:string){if(!task||!this.enabled())return;this.db.prepare('INSERT OR IGNORE INTO artifact_quality SELECT ?,body FROM task_quality WHERE task_id=?').run(artifact,task);}
 inherit(parent:string,next:string){this.db.prepare('INSERT INTO artifact_quality SELECT ?,body FROM artifact_quality WHERE artifact_id=? ON CONFLICT(artifact_id) DO UPDATE SET body=excluded.body').run(next,parent);}
 private policy(id:string):QualityPlan|null{const row=this.db.prepare('SELECT body FROM artifact_quality WHERE artifact_id=?').get(id);return row?JSON.parse(String(row.body)):null;}
 private source(actor:Actor,row:Evidence,seen=new Set<string>([row.artifact_id])){
  const task=this.runtime.tasks.get(actor,row.source_task),body=JSON.parse(row.body);
  check(this.runtime.rooms(actor).some(r=>r.id===task.room_id),'forbidden','Evidence scope unavailable');
  if(body.area){const area=this.db.prepare('SELECT * FROM workareas WHERE id=? AND available=1 AND deleted=0').get(body.area);const who=this.principal(actor);check(area&&(who.kind==='admin'||(area.kind==='personal'?area.owner_id===who.id:!!this.db.prepare('SELECT 1 FROM workarea_members WHERE area_id=? AND agent_id=?').get(body.area,who.id))),'forbidden','Evidence workarea unavailable');}
  if(body.source){const s=body.source;const queries:Record<string,string>={artifact:'SELECT room_id,name || char(10) || description || char(10) || content AS body FROM artifacts WHERE id=?',message:'SELECT room_id,body FROM messages WHERE id=?'};
   check(Object.hasOwn(queries,s.kind),'invalid','Unsupported evidence source');const source=this.db.prepare(queries[s.kind]!).get(s.source_id);
   check(source&&this.runtime.rooms(actor).some(r=>r.id===source.room_id),'not_found','Source removed');
   if(s.kind==='artifact')check(this.runtime.workareas.visible(actor,s.source_id)&&this.readable(actor,s.source_id,new Set(seen)),'not_found','Source unavailable');
   check(digest([s.kind,s.source_id,source.room_id,source.body,null])===s.revision,'conflict','Source corrected; review again');
  }
  return body;
 }
 readable(actor:Actor,id:string,seen=new Set<string>()):boolean{
  if(seen.has(id))return false;seen.add(id);
  try{
   for(const child of this.db.prepare('SELECT child_id,sha256 FROM artifact_manifest WHERE artifact_id=?').all(id)){
    const source=this.db.prepare("SELECT a.room_id,COALESCE(f.sha256,'') AS file_hash,a.content FROM artifacts a LEFT JOIN artifact_files f ON f.artifact_id=a.id WHERE a.id=?").get(child.child_id!);if(!source||(source.file_hash||createHash('sha256').update(String(source.content)).digest('hex'))!==child.sha256||!this.runtime.rooms(actor).some(r=>r.id===source.room_id)||!this.runtime.workareas.visible(actor,String(child.child_id))||!this.readable(actor,String(child.child_id),new Set(seen)))return false;
   }
   for(const row of this.db.prepare('SELECT * FROM artifact_evidence WHERE artifact_id=?').all(id) as unknown as Evidence[])this.source(actor,row,seen);
   return true;
  }catch{return false;}
 }
 inspect(actor:Actor,id:string){
  const plan=this.policy(id);if(!plan)return null;
  const evidence=(this.db.prepare('SELECT * FROM artifact_evidence WHERE artifact_id=? ORDER BY rowid').all(id) as unknown as Evidence[]).map(row=>({id:row.id,criterion:row.criterion,sha256:row.sha256,created_at:row.created_at,...this.source(actor,row)}));
  const revision=digest(evidence);return {plan,evidence,revision,manifest:this.db.prepare('SELECT path,sha256 FROM artifact_manifest WHERE artifact_id=? ORDER BY path').all(id)};
 }
 manifest(actor:Actor,lease:TaskLease,name:string,files:{path:string;id:string;sha256:string}[],parent?:string){
  check(this.enabled()&&this.runtime.tasks.active(actor,lease),'forbidden','Active quality task required');check(files.length>0&&files.length<=50&&new Set(files.map(f=>f.path)).size===files.length,'invalid','Choose distinct target files');
  const sorted=[...files].sort((a,b)=>a.path.localeCompare(b.path));
  for(const f of sorted){check(f.path.split('/').every(p=>p&&p!=='.'&&p!=='..')&&!/[\\\x00-\x1f]/.test(f.path)&&!f.path.startsWith('/'),'invalid','Relative target path required');const artifact=this.runtime.artifactVersions.inspect(actor,f.id);check(artifact.author_id===lease.task.agent_id&&artifact.room_id===lease.task.room_id&&artifact.sha256===f.sha256,'forbidden','Use your fixed files in this conversation');}
  const content=JSON.stringify(sorted.map(f=>({path:f.path,sha256:f.sha256})),null,2);
  if(parent){const old=this.runtime.artifactVersions.inspect(actor,parent);check(old.author_id===lease.task.agent_id&&old.room_id===lease.task.room_id,'forbidden','Own manifest required');if(old.content===content)return {id:parent,sha256:old.sha256,reused:true};}
  return transaction(this.db,()=>{const id=this.runtime.createArtifact(actor,lease.task.room_id,name,'manifest','対象ファイルの固定版',content,lease.task.id);
   for(const f of sorted)this.db.prepare('INSERT INTO artifact_manifest VALUES (?,?,?,?)').run(id,f.path,f.id,f.sha256);
   if(parent)this.runtime.artifactVersions.link(actor,parent,id);
   return {id,sha256:this.runtime.artifactVersions.inspect(actor,id).sha256};});
 }
 record(actor:Actor,lease:TaskLease,input:{artifact_id:string;sha256:string;criterion:string;reference:string;method:string;claim:string;excerpt:string;assessment:'supports'|'contradicts'|'uncertain';limits:string}){
  check(this.enabled()&&this.runtime.tasks.active(actor,lease),'forbidden','Active quality task required');const item=this.runtime.artifactVersions.inspect(actor,input.artifact_id),plan=this.policy(item.id);
  check(item.author_id===lease.task.agent_id&&item.room_id===lease.task.room_id&&item.sha256===input.sha256,'forbidden','Use your fixed artifact');
  check(plan?.criteria.some(c=>c.id===input.criterion),'invalid','Unknown completion condition');text(input.method,1000);
  const receipt=this.db.prepare('SELECT input,output FROM tool_receipts WHERE task_id=? AND operation_id=?').get(lease.task.id,input.reference)??this.db.prepare('SELECT output FROM external_operations WHERE task_id=? AND operation_id=?').get(lease.task.id,input.reference);
  const execution=this.db.prepare('SELECT result AS output FROM execution_bindings WHERE task_id=? AND id=?').get(lease.task.id,input.reference);
  const value=JSON.parse(String(receipt?.output??execution?.output??'null'));
  const body:Record<string,unknown>={kind:'self_report',result:'not_executed',method:input.method,claim:input.claim,excerpt:input.excerpt,assessment:input.assessment,limits:input.limits};
  if((receipt||execution)&&(!value||value.error))Object.assign(body,{kind:'unverified_result',result:!value||value?.error==='outcome_unknown'?'unknown':'unavailable'});
  else if(value&&Number.isInteger(value.code)&&!value.verification)Object.assign(body,{kind:'unverified_result',result:value.code===0?'unverifiable':'failed'});
  if(value?.verification){
   const v=value.verification,targets=this.db.prepare('SELECT path,sha256 FROM artifact_manifest WHERE artifact_id=? ORDER BY path').all(item.id);
   const files=targets.length?targets:[{sha256:item.sha256}];
   const matched=files.every(f=>v.files.some((p:{path:string;sha256:string})=>p.sha256===f.sha256&&(!f.path||p.path===f.path)));
   Object.assign(body,{kind:'execution',result:!matched?'wrong_version':!v.image?'unverifiable':value.error?'unknown':value.code===0?'passed':Number.isInteger(value.code)?'failed':'unknown',command_sha256:v.command_sha256,environment:v.environment,image:v.image,executed_at:v.executed_at,code:value.code??null,files:targets.length?targets:[{sha256:item.sha256}],area:v.area});
  }else if(value&&typeof value.url==='string'&&typeof value.text==='string'&&typeof value.fetched_at==='string'){
   check(input.excerpt.trim()&&value.text.includes(input.excerpt),'invalid','Quote the actual fetched text');Object.assign(body,{kind:'source',result:'retrieved',url:value.url,fetched_at:value.fetched_at});
  }else if(value&&['artifact','message'].includes(value.kind)&&typeof value.revision==='string'){
   check(value.source_id!==item.id&&input.excerpt.trim()&&value.text.includes(input.excerpt),'invalid','Use a different, exact source');Object.assign(body,{kind:'source',result:'retrieved',source:{kind:value.kind,source_id:value.source_id,revision:value.revision}});
  }
  const id=randomUUID(),row={id,artifact_id:item.id,sha256:item.sha256,criterion:input.criterion,author_id:lease.task.agent_id,source_task:lease.task.id,source_operation:input.reference,body:JSON.stringify(body),created_at:Date.now()};this.source(actor,row);
  const prior=this.db.prepare('SELECT id FROM artifact_evidence WHERE artifact_id=? AND criterion=? AND source_operation=? AND source_task=? AND body=?').get(item.id,input.criterion,input.reference,lease.task.id,row.body);if(prior)return {id:prior.id,reused:true};
  this.db.prepare('INSERT INTO artifact_evidence VALUES (?,?,?,?,?,?,?,?,?)').run(...Object.values(row));return {id,kind:body.kind,result:body.result};
 }
 ready(actor:Actor,id:string){const quality=this.inspect(actor,id);if(!quality)return;
  for(const c of quality.plan.criteria){if(c.kind==='review')continue;check(c.kind==='execution'?quality.evidence.filter(e=>e.criterion===c.id).at(-1)?.result==='passed':quality.evidence.some(e=>e.criterion===c.id&&e.kind==='source'&&e.result==='retrieved'),'conflict',`Evidence missing or unsuccessful: ${c.condition}`);}
 }
 review(actor:Actor,id:string,verdict:string,note:string,checks?:QualityReview){const quality=this.inspect(actor,id);if(!quality)return null;
  check(!isAcknowledgment(note)&&note.trim().length>=12,'invalid','Record concrete findings, not acknowledgment');
  check(Value.Check(qualityReviewSchema,checks)&&checks.length===quality.plan.criteria.length&&new Set(checks.map(c=>c.criterion)).size===checks.length&&checks.every(c=>quality.plan.criteria.some(p=>p.id===c.criterion)&&c.note.trim().length>=12&&!isAcknowledgment(c.note)),'invalid','Review each completion condition with concrete findings');
  if(verdict==='approved'){this.ready(actor,id);check(checks.every(c=>c.verdict==='pass'),'conflict','Unresolved conditions cannot be approved');check(!quality.evidence.some(e=>e.assessment==='contradicts'||e.assessment==='uncertain'),'conflict','Resolve source contradictions and uncertainty before approval');}
  return {checks:JSON.stringify(checks),revision:quality.revision};
 }
 verified(actor:Actor,id:string){const quality=this.inspect(actor,id);if(!quality)return;this.ready(actor,id);
  const reviews=this.db.prepare('SELECT verdict,evidence_revision FROM artifact_reviews WHERE artifact_id=?').all(id);
  check(reviews.some(r=>r.verdict==='approved'&&r.evidence_revision===quality.revision)&&!reviews.some(r=>r.verdict==='changes_requested'),'conflict','Current evidence and content review required');
 }
}
