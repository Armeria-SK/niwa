import {randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {Actor,Runtime} from './runtime.ts';
import type {TaskLease} from '../domain/task.ts';
import {check,text} from '../domain/types.ts';
import {transaction} from '../storage/database.ts';
import type {JsonObject} from '../contracts/model.ts';
import type {WorkareaRequest} from '../tools/workareas/store.ts';
export type WorkareaTransport=(input:WorkareaRequest,signal?:AbortSignal)=>Promise<JsonObject>;
interface Area {id:string;kind:'personal'|'project';name:string;owner_id:string;room_id:string;available:number;deleted:number;revision:number}

/** Authenticated scope selection. Neither a model nor an HTTP client chooses host paths. */
export class Workareas {
 private gates=new Map<string,Promise<unknown>>();
 private startingExecutions=new Set<string>();
 private executions=new Map<string,Set<{bot:string;controller:AbortController}>>();
 constructor(private db:DatabaseSync,private runtime:Runtime,private principal:(actor:Actor)=>{kind:string;id:string}){
  db.prepare('INSERT OR IGNORE INTO workarea_settings VALUES (1,0,?)').run(randomUUID());
 }
 settings(actor:Actor){this.principal(actor);return this.db.prepare('SELECT enabled FROM workarea_settings WHERE id=1').get()!;}
 enable(actor:Actor,enabled:boolean){check(this.principal(actor).kind==='admin','forbidden','Administrator required');this.db.prepare('UPDATE workarea_settings SET enabled=? WHERE id=1').run(Number(enabled));}
 authorize(actor:Actor,id:string,lease?:TaskLease,ongoing=false):Area{
  const who=this.principal(actor),area=this.db.prepare('SELECT * FROM workareas WHERE id=? AND deleted=0').get(id) as unknown as Area|undefined;
  check(area&&area.available,'not_found','Workarea unavailable');check(this.runtime.rooms(actor).some(room=>room.id===area.room_id),'forbidden','Conversation access required');
  check(who.kind==='admin'||(area.kind==='personal'?area.owner_id===who.id:!!this.db.prepare('SELECT 1 FROM workarea_members WHERE area_id=? AND agent_id=?').get(id,who.id)),'forbidden','Workarea is not shared with this Bot');
  if(who.kind!=='admin'){
   check(lease&&lease.task.agent_id===who.id&&lease.task.room_id===area.room_id&&(this.runtime.tasks.active(actor,lease)||(ongoing&&this.runtime.tasks.executionAllowed(actor,lease.task.id,lease.token,!!this.db.prepare("SELECT 1 FROM execution_bindings WHERE task_id=? AND lease=? AND waiting=1 AND state='pending'").get(lease.task.id,lease.token)))),'forbidden','Current task and conversation required');
  }
  return area;
 }
 list(actor:Actor,lease?:TaskLease){
  const who=this.principal(actor);
  return this.db.prepare('SELECT * FROM workareas WHERE deleted=0 ORDER BY rowid').all().filter(row=>{
   if(who.kind==='admin')return true;
   try{this.authorize(actor,String(row.id),lease);return true;}catch{return false;}
  }).map(row=>({...row,id:String(row.id),members:this.db.prepare('SELECT agent_id FROM workarea_members WHERE area_id=?').all(row.id!).map(m=>m.agent_id),backup:'metadata_only'}));
 }
 personal(actor:Actor,lease:TaskLease){
  const who=this.principal(actor);check(who.kind==='agent'&&this.runtime.tasks.active(actor,lease),'forbidden','Active Bot task required');
  check(this.settings(actor).enabled,'conflict','Workareas are disabled');
  let area=this.db.prepare("SELECT id FROM workareas WHERE owner_id=? AND room_id=? AND kind='personal' AND deleted=0 AND available=1").get(who.id,lease.task.room_id);
  if(!area){const id=randomUUID();this.db.prepare("INSERT INTO workareas(id,kind,name,owner_id,room_id) VALUES (?,'personal','個人作業',?,?)").run(id,who.id,lease.task.room_id);area={id};}
  return this.select(actor,lease,String(area.id));
 }
 select(actor:Actor,lease:TaskLease,id:string|null){
  check(this.runtime.tasks.active(actor,lease),'forbidden','Active task required');
  if(id){check(this.settings(actor).enabled,'conflict','Workareas are disabled');this.authorize(actor,id,lease);this.db.prepare('INSERT INTO task_workareas VALUES (?,?) ON CONFLICT(task_id) DO UPDATE SET area_id=excluded.area_id').run(lease.task.id,id);}
  else this.db.prepare('DELETE FROM task_workareas WHERE task_id=?').run(lease.task.id);
  return {area_id:id,legacy:id===null};
 }
 selected(actor:Actor,lease:TaskLease):string|null{check(this.runtime.tasks.active(actor,lease),'forbidden','Active task required');return this.db.prepare('SELECT area_id FROM task_workareas WHERE task_id=?').get(lease.task.id)?.area_id as string??null;}
 async project(actor:Actor,input:{id?:string;name:string;room_id:string;members:string[];expected_revision?:number}){
  check(this.principal(actor).kind==='admin','forbidden','Administrator manages project membership');text(input.name,100);
  check(input.members.length>0&&input.members.length<=100&&new Set(input.members).size===input.members.length,'invalid','Choose project participants');
  const room=this.runtime.rooms(actor).find(r=>r.id===input.room_id);check(room,'not_found','Conversation not found');
  for(const id of input.members)check(this.runtime.agents(actor).some(a=>a.id===id)&&(room.visibility==='shared'||this.runtime.participants(actor,room.id).includes(id)),'forbidden','Project members must be conversation participants');
  const id=input.id??randomUUID();
  return this.lock(id,()=>transaction(this.db,()=>{
   const prior=this.db.prepare('SELECT * FROM workareas WHERE id=?').get(id);
   if(prior){check(prior.kind==='project'&&prior.room_id===input.room_id&&prior.revision===input.expected_revision&&!prior.deleted,'conflict','Project changed');this.db.prepare('UPDATE workareas SET name=?,revision=revision+1 WHERE id=?').run(input.name,id);}
   else{check(!input.id,'not_found','Project not found');this.db.prepare("INSERT INTO workareas(id,kind,name,owner_id,room_id) VALUES (?,'project',?,?,?)").run(id,input.name,input.members[0]!,input.room_id);}
   this.db.prepare('DELETE FROM workarea_members WHERE area_id=?').run(id);for(const member of input.members)this.db.prepare('INSERT INTO workarea_members VALUES (?,?)').run(id,member);
   for(const run of this.executions.get(id)??[])if(!input.members.includes(run.bot))run.controller.abort();
   return {id};
  }));
 }
 private async lock<T>(id:string,action:()=>T|Promise<T>):Promise<T>{
  const prior=this.gates.get(id)??Promise.resolve();const result=prior.catch(()=>{}).then(action);this.gates.set(id,result);
  try{return await result;}finally{if(this.gates.get(id)===result)this.gates.delete(id);}
 }
 async execution(actor:Actor,id:string,input:Omit<WorkareaRequest,'area'|'epoch'>,transport:WorkareaTransport,lease?:TaskLease){
  this.authorize(actor,id,lease);check(this.settings(actor).enabled,'forbidden','Workareas disabled');
  if(lease)check(!this.runtime.tasks.independentActivity(actor,lease),'forbidden','Independent activity cannot execute');
  check(['execution_start','execution_list','execution_status','execution_stop','execution_preview'].includes(input.operation),'forbidden','Internal operation');
  const epoch=this.epoch();
  if(input.operation==='execution_start'){
   check(lease&&input.operation_id,'forbidden','An active Bot task must own the execution');
   const existing=this.db.prepare('SELECT task_id,area_id FROM execution_bindings WHERE id=?').get(input.operation_id);
   if(existing)check(existing.task_id===lease.task.id&&existing.area_id===id,'conflict','Execution scope changed');
   else this.db.prepare('INSERT INTO execution_bindings(id,task_id,area_id,epoch,lease) VALUES (?,?,?,?,?)').run(input.operation_id,lease.task.id,id,epoch,lease.token);
   this.startingExecutions.add(input.operation_id);
   try{const result=await transport({...input,area:id,epoch,task_id:lease.task.id,deadline:this.runtime.tasks.get(actor,lease.task.id).deadline_at});
    if(result.error)this.db.prepare("UPDATE execution_bindings SET state='failed',result=? WHERE id=?").run(JSON.stringify(result),input.operation_id);
    return result;
   }catch{return {id:input.operation_id,state:'reconciling'};}finally{this.startingExecutions.delete(input.operation_id);}
  }
  if(input.operation==='execution_stop'&&lease){const row=this.db.prepare('SELECT task_id FROM execution_bindings WHERE id=?').get(input.execution_id??'');check(row?.task_id===lease.task.id,'forbidden','Only the owning task or administrator can stop this execution');}
  const result=await transport({...input,area:id,epoch});this.authorize(actor,id,lease);return result;
 }
 async syncExecutions(transport:WorkareaTransport){
  const admin=this.runtime.administrator();
  for(const row of this.db.prepare("SELECT * FROM execution_bindings WHERE state='pending'").all()){
   const area=String(row.area_id),id=String(row.id),epoch=String(row.epoch);
   if(this.startingExecutions.has(id))continue;
   try{
    const actor=this.runtime.agentSession(this.runtime.tasks.get(admin,String(row.task_id)).agent_id),lease={task:this.runtime.tasks.get(admin,String(row.task_id)),token:String(row.lease)};
    const allowed=()=>{this.authorize(actor,area,lease,true);check(this.settings(admin).enabled&&epoch===this.epoch()&&this.selectedForTask(lease.task.id)===area&&this.runtime.tasks.executionAllowed(actor,lease.task.id,lease.token,!!row.waiting),'forbidden','Execution authorization expired');};
    let current:JsonObject;
    try{allowed();current=await transport({operation:'execution_heartbeat',area,epoch,execution_id:id});}
    catch{current=await transport({operation:'execution_stop',area,epoch,execution_id:id});}
    if(current.error){this.db.prepare("UPDATE execution_bindings SET state='outcome_unknown',waiting=0,result=? WHERE id=?").run(JSON.stringify(current),id);continue;}
    if(['queued','running'].includes(String(current.state)))continue;
    await this.lock(area,async()=>{
     let result=current.result as JsonObject??{};
     if(current.state==='completed'&&typeof result.candidate==='string'){
      try{allowed();result={...result,...await transport({operation:'commit',area,epoch,candidate:result.candidate,expected_revision:result.base_revision as string})};}
      catch{result={error:'authorization_expired',candidate:result.candidate};}
     }
     this.db.prepare('UPDATE execution_bindings SET state=?,waiting=0,result=? WHERE id=?').run(String(current.state??'outcome_unknown'),JSON.stringify(result),id);
    });
   }catch{
    // A removed Bot/conversation has no actor; still terminate using the previously recorded protected scope.
    try{await transport({operation:'execution_stop',area,epoch,execution_id:id});this.db.prepare("UPDATE execution_bindings SET state='cancelled',waiting=0 WHERE id=?").run(id);}catch{};
   }
  }
 }
 private selectedForTask(task:string){return this.db.prepare('SELECT area_id FROM task_workareas WHERE task_id=?').get(task)?.area_id;}
 executionResult(actor:Actor,id:string,lease:TaskLease){
  const row=this.db.prepare('SELECT * FROM execution_bindings WHERE id=? AND task_id=?').get(id,lease.task.id);check(row,'not_found','Execution not found');this.authorize(actor,String(row.area_id),lease);
  return {id,state:row.state,result:row.result?JSON.parse(String(row.result)):null};
 }
 async execute(actor:Actor,id:string,input:Omit<WorkareaRequest,'area'|'epoch'>,transport:WorkareaTransport,lease?:TaskLease,signal?:AbortSignal):Promise<JsonObject>{
  check(['list','read','download','write','run','publish','environment_list','environment_prepare','environment_test','environment_activate','environment_run','environment_retire','environment_collect'].includes(input.operation),'forbidden','Internal operation');
  if(['environment_retire','environment_collect'].includes(input.operation))check(this.principal(actor).kind==='admin','forbidden','Administrator manages environment retention');
  const authorized=()=>{
   this.authorize(actor,id,lease);check(this.settings(actor).enabled,'conflict','Workareas are disabled');
   if(lease)check(!this.runtime.tasks.independentActivity(actor,lease),'forbidden','Independent activity remains limited to public reads and new text artifacts; scoped files are unavailable');
   return String(this.db.prepare('SELECT epoch FROM workarea_settings WHERE id=1').get()!.epoch);
  };
  const invoke=()=>{signal?.throwIfAborted();return transport({...input,area:id,epoch:authorized()},signal);};
  if(['run','environment_test','environment_run','environment_prepare'].includes(input.operation)){
   // No canonical files are mounted. Other writes may finish while this copy is running.
   const controller=new AbortController(),entry={bot:this.principal(actor).id,controller};
   const cancellation=AbortSignal.any([controller.signal,...(signal?[signal]:[])]);
   const epoch=await this.lock(id,()=>{const epoch=authorized();let running=this.executions.get(id);if(!running){running=new Set();this.executions.set(id,running);}running.add(entry);return epoch;});
   try{
    const output=await transport({...input,area:id,epoch},cancellation);
    return await this.lock(id,async()=>{
     const current=authorized();cancellation.throwIfAborted();
     if(output.error||typeof output.candidate!=='string')return output;
     const commit=await transport({area:id,epoch:current,operation:'commit',candidate:output.candidate as string,expected_revision:output.base_revision as string},cancellation);return {...output,...commit};
    });
   }finally{const running=this.executions.get(id);running?.delete(entry);if(!running?.size)this.executions.delete(id);}
  }
  return this.lock(id,async()=>{const output=await invoke();authorized();return output;});
 }
 async share(actor:Actor,lease:TaskLease,id:string,path:string,expected:string,transport:WorkareaTransport,operationId:string,firstAttempt:boolean,signal?:AbortSignal,target?:string,parent?:string){
  const area=this.authorize(actor,id,lease);check(!this.runtime.tasks.independentActivity(actor,lease),'forbidden','Independent activity cannot publish held files');
  if(target){const project=this.authorize(actor,target,lease);check(project.kind==='project','invalid','Choose a project audience');}
  if(parent){const prior=this.runtime.artifactVersions.inspect(actor,parent);check(prior.author_id===lease.task.agent_id&&prior.room_id===area.room_id&&!prior.frozen,'forbidden','Only own unfrozen file series can be revised');const audience=this.db.prepare('SELECT area_id FROM artifact_audiences WHERE artifact_id=?').get(parent)?.area_id??null;check(audience===(target??null),'conflict','Version audience must stay unchanged');}
  const file=await this.execute(actor,id,{operation:'download',path},transport,lease,signal);
  check(file.revision===expected,'conflict','Source file changed');const bytes=Buffer.from(file.data as string,'base64');
  let content:string|null=null;try{const value=new TextDecoder('utf8',{fatal:true,ignoreBOM:true}).decode(bytes);if(value.trim()&&!value.includes('\0')&&bytes.length<=100_000)content=value;}catch{}
  let blob:JsonObject|undefined;
  if(content===null)blob=await this.execute(actor,id,{operation:'publish',path,expected_revision:expected,revision:file.area_revision as string,artifact:operationId,operation_id:operationId,allow_start:firstAttempt},transport,lease,signal);
  if(blob?.error)return blob;
  this.authorize(actor,id,lease);
  return this.runtime.tasks.once(actor,lease,`${operationId}:publication`,{area:id,path,expected,target:target??null,parent:parent??null},()=>{
   if(target)this.authorize(actor,target,lease);
   const name=path.split('/').at(-1)!;
   const artifact=this.runtime.createArtifact(actor,area.room_id,name,content===null?'file':'text','作業ファイルから共有した固定版',content??'ファイルの固定版。ダウンロードで取得できます。',lease.task.id);
   if(target)this.db.prepare('INSERT INTO artifact_audiences VALUES (?,?)').run(artifact,target);
   if(parent)this.runtime.artifactVersions.link(actor,parent,artifact);
   if(content===null)this.db.prepare('INSERT INTO artifact_files(artifact_id,blob_id,sha256,size) VALUES (?,?,?,?)').run(artifact,operationId,expected,bytes.length);
   return {artifact_id:artifact,sha256:expected,size:bytes.length};
  });
 }
 file(actor:Actor,id:string){this.runtime.artifact(actor,id);const file=this.db.prepare('SELECT * FROM artifact_files WHERE artifact_id=? AND available=1').get(id);check(file,'not_found','File bytes are not included in application backups');return file;}
 visible(actor:Actor,id:string){
  const who=this.principal(actor),row=this.db.prepare('SELECT area_id FROM artifact_audiences WHERE artifact_id=?').get(id);
  if(!row||who.kind==='admin')return true;
  return !!this.db.prepare('SELECT 1 FROM workarea_members m JOIN workareas w ON w.id=m.area_id WHERE m.area_id=? AND m.agent_id=? AND w.deleted=0 AND w.available=1').get(row.area_id!,who.id);
 }
 async purgeRetired(transport:WorkareaTransport){
  for(const id of this.retired())await transport({operation:'purge',area:id,epoch:this.epoch()});
  for(const row of this.db.prepare('SELECT blob_id FROM retired_workarea_files').all()){
   const result=await transport({operation:'purge_published',area:String(row.blob_id),epoch:this.epoch()});
   if(result.removed)this.db.prepare('DELETE FROM retired_workarea_files WHERE blob_id=?').run(row.blob_id!);
  }
 }
 retired(){return this.db.prepare('SELECT id FROM workareas WHERE deleted=1').all().map(r=>String(r.id));}
 epoch(){return String(this.db.prepare('SELECT epoch FROM workarea_settings WHERE id=1').get()!.epoch);}
}
