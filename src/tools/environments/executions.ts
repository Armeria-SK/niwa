import {createHash} from 'node:crypto';
import {openDatabase} from '../../storage/database.ts';
import type {JsonObject} from '../../contracts/model.ts';
import type {ResourcePool,ResourceProfile} from '../../sandbox/resources.ts';
export interface ExecutionInput {id:string;area:string;epoch:string;task:string;environment:string;revision:string;seconds:number;deadline:number;resources:ResourceProfile;preview:boolean}
export class Executions {
 private db;private active=new Map<string,{controller:AbortController;done:Promise<void>}>();private timer:ReturnType<typeof setInterval>;
 constructor(path:string,private pool:ResourcePool,private execute:(input:ExecutionInput,signal:AbortSignal)=>Promise<JsonObject>){
  this.db=openDatabase(path,`CREATE TABLE executions(id TEXT PRIMARY KEY,area TEXT NOT NULL,epoch TEXT NOT NULL,task TEXT NOT NULL,input TEXT NOT NULL,hash TEXT NOT NULL,state TEXT NOT NULL,heartbeat INTEGER NOT NULL,result TEXT,created INTEGER NOT NULL) STRICT;`);
  this.db.exec('PRAGMA synchronous=FULL');
  // WorkareaStore.recover terminates unfinished saved containers first. Unknown executions never restart.
  this.db.prepare("UPDATE executions SET state='outcome_unknown',result=? WHERE state IN ('queued','running')").run(JSON.stringify({error:'outcome_unknown'}));
  this.timer=setInterval(()=>{for(const row of this.db.prepare("SELECT id,input,heartbeat FROM executions WHERE state IN ('queued','running')").all()){
   const input=JSON.parse(String(row.input)) as ExecutionInput;if(Number(row.heartbeat)<Date.now()-15000||input.deadline<=Date.now())this.cancel(String(row.id),input.deadline<=Date.now()?'deadline':'authorization_expired');
  }},500);this.timer.unref();
 }
 async close(){clearInterval(this.timer);for(const id of this.active.keys())this.cancel(id,'service_stopped');await Promise.all([...this.active.values()].map(j=>j.done));this.db.close();}
 lookup(id:string,area:string,epoch:string,task:string,seconds:number,preview:boolean){
  const row=this.db.prepare('SELECT input FROM executions WHERE id=?').get(id);if(!row)return null;
  const saved=JSON.parse(String(row.input)) as ExecutionInput;
  if(saved.area!==area||saved.epoch!==epoch||saved.task!==task||saved.seconds!==seconds||saved.preview!==preview)throw Error('Execution request conflict');
  return this.get(id,area,epoch);
 }
 start(input:ExecutionInput,allowStart:boolean){
  const encoded=JSON.stringify(input),hash=createHash('sha256').update(encoded).digest('hex');
  const prior=this.db.prepare('SELECT hash FROM executions WHERE id=?').get(input.id);
  if(prior){if(prior.hash!==hash)throw Error('Execution ID conflict');return this.get(input.id,input.area,input.epoch);}
  if(!allowStart)return {error:'outcome_unknown'};
  const resources=input.preview?{...input.resources,memory_mib:input.resources.memory_mib+1024,cpu:input.resources.cpu+1,pids:input.resources.pids+256,disk_mib:input.resources.disk_mib+320}:input.resources;
  if(!this.pool.fits(resources))return {error:'resource_profile_cannot_fit',required:resources};
  if(this.db.prepare("SELECT 1 FROM executions WHERE (task=? OR area=?) AND state IN ('queued','running')").get(input.task,input.area))return {error:'execution_already_pending'};
  if(this.active.size>=100)return {error:'execution_queue_full'};
  this.db.prepare("INSERT INTO executions VALUES (?,?,?,?,?,?,'queued',?,NULL,?)").run(input.id,input.area,input.epoch,input.task,encoded,hash,Date.now(),Date.now());
  const controller=new AbortController();
  const done=(async()=>{let release:(()=>void)|undefined;
   try{
    release=await this.pool.acquire(resources,controller.signal);controller.signal.throwIfAborted();
    if(input.deadline<=Date.now())throw Error('Deadline');this.db.prepare("UPDATE executions SET state='running' WHERE id=?").run(input.id);
    const remaining=Math.min(input.seconds,Math.ceil((input.deadline-Date.now())/1000));
    const result=await this.execute({...input,seconds:remaining},AbortSignal.any([controller.signal,AbortSignal.timeout(remaining*1000)]));
    if(!controller.signal.aborted)this.db.prepare('UPDATE executions SET state=?,result=? WHERE id=?').run(result.error?'failed':'completed',JSON.stringify(result),input.id);
   }catch{if(!controller.signal.aborted)this.db.prepare("UPDATE executions SET state='outcome_unknown',result=? WHERE id=?").run(JSON.stringify({error:'outcome_unknown'}),input.id);}
   finally{controller.abort();release?.();this.active.delete(input.id);}
  })();this.active.set(input.id,{controller,done});return this.get(input.id,input.area,input.epoch);
 }
 get(id:string,area:string,epoch:string){const row=this.db.prepare('SELECT * FROM executions WHERE id=? AND area=? AND epoch=?').get(id,area,epoch);if(!row)throw Error('Execution not found');
  const input=JSON.parse(String(row.input)) as ExecutionInput;return {id,state:String(row.state),task:input.task,environment:input.environment,preview:input.preview,deadline:input.deadline,result:row.result?JSON.parse(String(row.result)) as JsonObject:null,wait_reason:row.state==='queued'?'resource_capacity':null};}
 list(area:string,epoch:string){return this.db.prepare('SELECT id FROM executions WHERE area=? AND epoch=? ORDER BY created DESC LIMIT 30').all(area,epoch).map(row=>this.get(String(row.id),area,epoch));}
 heartbeat(id:string,area:string,epoch:string){this.get(id,area,epoch);this.db.prepare('UPDATE executions SET heartbeat=? WHERE id=?').run(Date.now(),id);}
 cancel(id:string,reason='cancelled'){
  const row=this.db.prepare('SELECT state FROM executions WHERE id=?').get(id);if(!row||!['queued','running'].includes(String(row.state)))return;
  this.db.prepare("UPDATE executions SET state='cancelled',result=? WHERE id=?").run(JSON.stringify({error:reason}),id);this.active.get(id)?.controller.abort();
 }
 async stop(id:string,area:string,epoch:string){this.get(id,area,epoch);this.cancel(id);await this.active.get(id)?.done;return this.get(id,area,epoch);}
 references(environment:string){return this.db.prepare("SELECT 1 FROM executions WHERE json_extract(input,'$.environment')=? AND state IN ('queued','running')").get(environment)!==undefined;}
 signal(id:string){return this.active.get(id)?.controller.signal??AbortSignal.abort();}
}
