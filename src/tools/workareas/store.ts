import type {EnvironmentRegistry} from '../environments/registry.ts';
import {createHash,randomUUID} from 'node:crypto';
import {chmodSync,closeSync,writeFileSync,fstatSync,fsyncSync,lstatSync,mkdirSync,openSync,readFileSync,readdirSync,renameSync,rmSync,constants} from 'node:fs';
import {join} from 'node:path';
import {openDatabase,transaction} from '../../storage/database.ts';
import {assertDirectoryPath} from '../../config/paths.ts';
import {Workspace,WorkspaceError} from '../files/workspace.ts';
import type {JsonObject} from '../../contracts/model.ts';
import type {ProgramRequest,ProgramOutput} from '../../sandbox/program.ts';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const hash=/^[a-f0-9]{64}$/;
const digest=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
export interface WorkareaRequest {area:string;epoch:string;operation:string;path?:string;revision?:string;expected_revision?:string|null;content?:string;encoding?:'utf8'|'base64';operation_id?:string;allow_start?:boolean;command?:string[];seconds?:number;candidate?:string;artifact?:string;definition?:unknown;environment?:string;expected_environment?:string|null}
type Run=(root:string,request:ProgramRequest,signal:AbortSignal|undefined,name:string,image?:string)=>Promise<ProgramOutput>;

/** Only the protected executor owns canonical generations. Programs mount disposable copies. */
export class WorkareaStore {
 private db; private busy=new Set<string>();
 constructor(private root:string,private run:Run,private cleanup:(name:string)=>Promise<void>,private environments?:EnvironmentRegistry){
  assertDirectoryPath(root);
  for(const name of ['areas','runs','published']){mkdirSync(join(root,name),{recursive:true,mode:0o711});chmodSync(join(root,name),0o711);}
  this.db=openDatabase(join(root,'index.db'),`CREATE TABLE areas(id TEXT PRIMARY KEY,epoch TEXT NOT NULL,revision TEXT NOT NULL) STRICT;
   CREATE TABLE receipts(id TEXT PRIMARY KEY,area TEXT NOT NULL,input TEXT NOT NULL,container TEXT,result TEXT) STRICT;`);
  this.db.exec('PRAGMA synchronous=FULL');
 }
 close(){this.db.close();}
 async recover(){for(const row of this.db.prepare('SELECT id,container FROM receipts WHERE result IS NULL').all()){
  if(row.container)await this.cleanup(String(row.container));
  rmSync(join(this.root,'runs',String(row.id)),{recursive:true,force:true});
  this.db.prepare('UPDATE receipts SET result=? WHERE id=?').run(JSON.stringify({error:'outcome_unknown'}),row.id!);
 }}
 private tree(root:string,destination?:string,sync=false):string {
  assertDirectoryPath(root);const device=lstatSync(root).dev;const entries:string[]=[];let bytes=0,count=0;
  const walk=(dir:string,relative:string)=>{for(const item of readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
   const name=relative?`${relative}/${item.name}`:item.name,path=join(dir,item.name),stat=lstatSync(path);
   if(++count>1000 || stat.dev!==device || stat.isSymbolicLink())throw new WorkspaceError('invalid_path');
   if(stat.isDirectory()){entries.push(`d:${name}`);if(destination)mkdirSync(join(destination,name),{mode:0o700});walk(path,name);}
   else {
    if(!stat.isFile() || stat.nlink!==1 || stat.size>8*1024*1024 || (bytes+=stat.size)>64*1024*1024)throw new WorkspaceError('unsupported');
    const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try{const current=fstatSync(fd);if(current.ino!==stat.ino||current.dev!==device||current.nlink!==1)throw new WorkspaceError('invalid_path');
     const data=readFileSync(fd);if(sync){chmodSync(path,stat.mode&0o100?0o700:0o600);fsyncSync(fd);}entries.push(`f:${name}:${digest(data)}:${Number(!!(stat.mode&0o100))}`);
     if(destination)writeFileSync(join(destination,name),data,{flag:'wx',mode:stat.mode&0o100?0o700:0o600});
    }finally{closeSync(fd);}
   }
  }if(sync){chmodSync(dir,0o700);const fd=openSync(dir,constants.O_RDONLY|constants.O_DIRECTORY);try{fsyncSync(fd);}finally{closeSync(fd);}}};walk(root,'');return digest(JSON.stringify(entries));
 }
 private area(input:WorkareaRequest){
  if(!uuid.test(input.area)||!uuid.test(input.epoch))throw new WorkspaceError('invalid_path');
  const base=join(this.root,'areas',input.area);let row=this.db.prepare('SELECT * FROM areas WHERE id=?').get(input.area);
  if(!row){mkdirSync(base,{recursive:true,mode:0o711});const empty=join(base,'empty');mkdirSync(empty,{mode:0o700});const revision=this.tree(empty);renameSync(empty,join(base,revision));
   this.db.prepare('INSERT INTO areas VALUES (?,?,?)').run(input.area,input.epoch,revision);row={revision,epoch:input.epoch};}
  if(row.epoch!==input.epoch)throw new WorkspaceError('invalid_path');
  const revision=input.revision??String(row.revision);if(!hash.test(revision))throw new WorkspaceError('invalid_path');
  const path=join(base,revision);assertDirectoryPath(path);return {base,path,revision,current:String(row.revision)};
 }
 private save(base:string,stage:string){const revision=this.tree(stage,undefined,true),target=join(base,revision);
  try{renameSync(stage,target);}catch(error){if(!['EEXIST','ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code??''))throw error;rmSync(stage,{recursive:true});}
  const fd=openSync(base,constants.O_RDONLY|constants.O_DIRECTORY);try{fsyncSync(fd);}finally{closeSync(fd);}
  return revision;
 }
 async execute(input:WorkareaRequest,signal?:AbortSignal):Promise<JsonObject>{
  signal?.throwIfAborted();
  if(input.operation==='purge_published'){if(!uuid.test(input.area))throw new WorkspaceError('invalid_path');rmSync(join(this.root,'published',input.area),{recursive:true,force:true});return {removed:true};}
  if(input.operation==='purge'){
   if(!uuid.test(input.area))throw new WorkspaceError('invalid_path');
   if(this.busy.has(input.area)||this.environments?.pendingArea(input.area))return {error:'busy'};
   this.environments?.purgeArea(input.area);
   rmSync(join(this.root,'areas',input.area),{recursive:true,force:true});this.db.prepare('DELETE FROM areas WHERE id=?').run(input.area);this.db.prepare('DELETE FROM receipts WHERE area=?').run(input.area);return {removed:true};
  }
  const area=this.area(input);
  if(input.operation==='environment_list')return this.environments?this.environments.list(input.area,input.epoch):{error:'environments_disabled'};
  if(input.operation==='environment_prepare'){
   if(!this.environments)return {error:'environments_disabled'};
   return {...await this.environments.prepare(input.area,input.epoch,input.definition,input.allow_start===true,signal)};
  }
  if(input.operation==='environment_activate'){
   if(!this.environments||!input.environment)return {error:'environments_disabled'};
   const version=await this.environments.resolve(input.area,input.epoch,input.environment);
   if(version.tested_revision!==area.current)return {error:'workarea_changed_retest_required'};
   return this.environments.activate(input.area,input.epoch,input.environment,input.expected_environment??null);
  }
  if(input.operation==='list'||input.operation==='read'||input.operation==='download'){
   const workspace=new Workspace(area.path);return {...(input.operation==='list'?workspace.list(input.path??''):input.operation==='read'?workspace.read(input.path??''):workspace.download(input.path??'')),area_revision:area.revision,shared:false};
  }
  if(input.operation==='commit'){
   if(!input.candidate||!hash.test(input.candidate))throw new WorkspaceError('invalid_path');
   assertDirectoryPath(join(area.base,input.candidate));
   if(area.current!==input.candidate&&area.current!==input.expected_revision)return {error:'conflict',candidate:input.candidate,area_revision:area.current};
   this.db.prepare('UPDATE areas SET revision=? WHERE id=?').run(input.candidate,input.area);return {area_revision:input.candidate};
  }
  if(!['write','run','publish','environment_test','environment_run'].includes(input.operation)||!input.operation_id||!uuid.test(input.operation_id))throw new WorkspaceError('unsupported');
  const id=input.operation_id,encoded=digest(JSON.stringify({...input,allow_start:undefined}));
  const prior=this.db.prepare('SELECT input,result FROM receipts WHERE id=?').get(id);
  if(prior){if(prior.input!==encoded)throw new WorkspaceError('conflict');return prior.result===null?{error:'outcome_unknown'}:JSON.parse(String(prior.result));}
  if(!input.allow_start)return {error:'outcome_unknown'};
  const isRun=['run','environment_test','environment_run'].includes(input.operation);
  if(isRun&&this.busy.has(input.area))return {error:'busy'};
  const container=`niwa-program-${randomUUID()}`,stage=join(this.root,'runs',id);
  this.db.prepare('INSERT INTO receipts VALUES (?,?,?,?,NULL)').run(id,input.area,encoded,isRun?container:null);
  let result:JsonObject;
  try{
   if(input.operation==='publish'){
    if(!input.artifact||!uuid.test(input.artifact))throw new WorkspaceError('invalid_path');
    const file=new Workspace(area.path).download(input.path??'');
    if(file.revision!==input.expected_revision)throw new WorkspaceError('conflict');
    const target=join(this.root,'published',input.artifact);mkdirSync(target,{mode:0o700});
    new Workspace(target).write('content',file.data,null,'base64');result={revision:file.revision,size:Buffer.from(file.data,'base64').length};
   }else{
    mkdirSync(stage,{mode:0o711});chmodSync(stage,0o711);this.tree(area.path,stage);
    if(input.operation==='write'){
     const file=new Workspace(stage).write(input.path??'',input.content??'',input.expected_revision??null,input.encoding??'utf8');
     const revision=this.save(area.base,stage);
     result=transaction(this.db,()=>{if(this.area(input).current!==area.current)return {error:'conflict',candidate:revision};this.db.prepare('UPDATE areas SET revision=? WHERE id=?').run(revision,input.area);return {...file,shared:false,area_revision:revision};});
    }else{
     this.busy.add(input.area);
     const selected=input.environment??this.environments?.active(input.area,input.epoch);
     const version=selected?await this.environments?.resolve(input.area,input.epoch,selected):undefined;
     if(input.operation!=='run'&&!version)throw new WorkspaceError('unsupported');
     const checkLocks=()=>{for(const file of version?.definition.lockfiles??[])if(new Workspace(stage).download(file.path).revision!==file.sha256)throw new WorkspaceError('conflict');};
     checkLocks();
     const commands=input.operation==='environment_test'?[...version!.definition.prepare,version!.definition.verify]:input.operation==='environment_run'?[...version!.definition.prepare,version!.definition.run,version!.definition.verify]:[input.command??[]];
     const seconds=input.seconds??300;
     if(!Number.isSafeInteger(seconds)||seconds<1||seconds>300)throw new WorkspaceError('unsupported');
     const deadline=Date.now()+seconds*1000,cancellation=AbortSignal.any([AbortSignal.timeout(seconds*1000),...(signal?[signal]:[])]);
     let output:ProgramOutput={code:0,stdout:'',stderr:''};
     for(const command of commands){
      cancellation.throwIfAborted();
      const step=await this.run(stage,{command,seconds:Math.max(1,Math.ceil((deadline-Date.now())/1000))},cancellation,container,version?.image);
      output={code:step.code,stdout:(output.stdout+step.stdout).slice(-32768),stderr:(output.stderr+step.stderr).slice(-32768)};
      if(step.code!==0)break;
     }
     signal?.throwIfAborted();checkLocks();const candidate=this.save(area.base,stage);
     if(input.operation==='environment_test'){
      // Validation runs on a disposable snapshot; preparing never publishes its files or changes the active version.
      if(output.code===0)this.environments!.tested(input.area,input.epoch,version!.id,area.revision);
      result={...output,environment:version!.id,image:version!.image,tested_revision:area.revision};
     }else result={...output,candidate,base_revision:area.revision,...(version?{environment:version.id,image:version.image}: {})}; // Authorization and CAS happen separately after execution.
    }
   }
  }catch(error){result={error:error instanceof WorkspaceError?error.code:'outcome_unknown'};}
  finally{if(isRun)this.busy.delete(input.area);rmSync(stage,{recursive:true,force:true});}
  this.db.prepare('UPDATE receipts SET result=? WHERE id=?').run(JSON.stringify(result),id);return result;
 }
 published(id:string){if(!uuid.test(id))throw new WorkspaceError('invalid_path');return new Workspace(join(this.root,'published',id)).download('content');}
}
