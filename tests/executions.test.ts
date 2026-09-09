import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {ResourcePool,standardProfile} from '../src/sandbox/resources.ts';
import {Executions,type ExecutionInput} from '../src/tools/environments/executions.ts';
import {Runtime} from '../src/runtime/runtime.ts';
import {EnvironmentRegistry} from '../src/tools/environments/registry.ts';
import {PackageCatalog} from '../src/tools/packages/catalog.ts';
import {WorkareaStore} from '../src/tools/workareas/store.ts';
import type {ManagedRunner} from '../src/sandbox/managed.ts';
const config={capacity:{memory_mib:1024,cpu:2,pids:128,disk_mib:128},reserve:{memory_mib:512,cpu:1,pids:64,disk_mib:64},profiles:{standard:standardProfile}};
const image=`sha256:${'a'.repeat(64)}`;
const tick=()=>delay(10);
test('FIFO resource waits cancel without taking capacity or changing standard limits',async()=>{
 const pool=new ResourcePool(config),release=await pool.acquire(standardProfile);let started=false;const cancelled=new AbortController();
 const wait=pool.acquire(standardProfile,cancelled.signal);const rejected=assert.rejects(wait);cancelled.abort();await rejected;
 const next=pool.acquire(standardProfile).then(r=>{started=true;return r;});await tick();assert.equal(started,false);assert.equal(pool.status().waiting,1);
 release();(await next)();assert.equal(pool.status().used.memory_mib,0);
 assert.throws(()=>new ResourcePool({...config,profiles:{standard:{...standardProfile,memory_mib:1024}}}));
});
test('durable async IDs queue, cancel, reuse results and recover without executing a new attempt',async t=>{
 const root=mkdtempSync(join(tmpdir(),'niwa-execution-'));t.after(()=>rmSync(root,{recursive:true,force:true}));let calls=0;
 const pool=new ResourcePool(config),hold=await pool.acquire(standardProfile);
 let runs=new Executions(join(root,'runs.db'),pool,async()=>{calls++;return {code:0,stdout:'synthetic'};});
 const input:ExecutionInput={id:randomUUID(),area:randomUUID(),epoch:randomUUID(),task:randomUUID(),environment:'a'.repeat(64),revision:'b'.repeat(64),seconds:10,deadline:Date.now()+60000,resources:standardProfile,preview:false};
 assert.equal((runs.start(input,true) as {state:string}).state,'queued');assert.equal(calls,0);
 assert.equal((await runs.stop(input.id,input.area,input.epoch)).state,'cancelled');assert.equal(calls,0);hold();
 const next={...input,id:randomUUID()};runs.start(next,true);await tick();assert.equal(runs.get(next.id,next.area,next.epoch).state,'completed');assert.equal(calls,1);
 await runs.close();runs=new Executions(join(root,'runs.db'),pool,async()=>{calls++;return {};});
 assert.equal((runs.start(next,false) as {state:string}).state,'completed');assert.equal(calls,1);assert.equal((runs.start({...next,id:randomUUID()},false) as {error:string}).error,'outcome_unknown');await runs.close();
});
test('task execution wait frees model slot, commits with CAS, and membership removal stops an active process',async t=>{
 const root=mkdtempSync(join(tmpdir(),'niwa-execution-runtime-'));mkdirSync(join(root,'files'));mkdirSync(join(root,'catalog'),{mode:0o700});writeFileSync(join(root,'catalog','catalog.json'),'[]',{mode:0o600});
 const r=new Runtime(join(root,'state')),admin=r.administrator(),a=r.bootstrap(admin),aa=r.agentSession(a.id),b=r.createAgent(aa,'B'),ba=r.agentSession(b.id),room=r.createRoom(admin,'人工案件');
 r.workareas.enable(admin,true);r.tasks.create(admin,a.id,room.id,'A');const al=r.tasks.claim(admin)!;
 const project=await r.workareas.project(admin,{name:'共同制作',room_id:room.id,members:[a.id,b.id]});r.workareas.select(aa,al,project.id);
 const catalog=new PackageCatalog(join(root,'catalog')),registry=new EnvironmentRegistry(join(root,'env.db'),image,catalog,async()=>{throw Error('unused');},async()=>true);
 let finish!:()=>void,aborted=false;const gate=()=>new Promise<void>(r=>finish=r);let waiting=gate();
 const runner:ManagedRunner={run:async(root,_image,_commands,_profile,_seconds,_name,signal)=>{await Promise.race([waiting,new Promise<never>((_,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(Error('stopped'));},{once:true}))]);writeFileSync(join(root,'result.txt'),'result');return {code:0,stdout:'ok',stderr:''};},status:async()=>null,cleanup:async()=>{},preview:async()=>{throw Error('unused');}};
 const store=new WorkareaStore(join(root,'files'),async()=>({code:0,stdout:'',stderr:''}),async()=>{},registry,{runner,pool:new ResourcePool(config)});
 const transport=(input:import('../src/tools/workareas/store.ts').WorkareaRequest,signal?:AbortSignal)=>store.execute(input,signal);
 t.after(async()=>{await store.stop();store.close();registry.close();r.close();rmSync(root,{recursive:true,force:true});});
 const definition={name:'test',base_image:image,catalog_revision:catalog.revision,dependencies:[],lockfiles:[],workdir:'/workspace',prepare:[],run:['true'],verify:['true'],profile:'standard'};
 const version=await r.workareas.execute(aa,project.id,{operation:'environment_prepare',definition,allow_start:true},transport,al);
 await r.workareas.execute(aa,project.id,{operation:'environment_test',environment:version.id as string,operation_id:randomUUID(),allow_start:true},transport,al);
 await r.workareas.execute(aa,project.id,{operation:'environment_activate',environment:version.id as string,operation_id:randomUUID(),allow_start:true},transport,al);
 const id=randomUUID();await r.workareas.execution(aa,project.id,{operation:'execution_start',operation_id:id,allow_start:true,seconds:20,preview:false},transport,al);await tick();
 assert.deepEqual(r.tasks.waitExecution(aa,al,id),{waiting:true});assert.equal(r.tasks.claim(admin),undefined);
 r.tasks.create(admin,b.id,room.id,'ordinary request');const bl=r.tasks.claim(admin)!;assert.equal(bl.task.agent_id,b.id);
 await r.workareas.syncExecutions(transport);assert.equal(aborted,false);finish();await tick();await r.workareas.syncExecutions(transport);
 const resumed=r.tasks.claim(admin)!;assert.equal(resumed.task.id,al.task.id);assert.equal(r.workareas.executionResult(aa,id,resumed).state,'completed');
 assert.equal((await r.workareas.execute(aa,project.id,{operation:'read',path:'result.txt'},transport,resumed)).content,'result');
 waiting=gate();const second=randomUUID();await r.workareas.execution(aa,project.id,{operation:'execution_start',operation_id:second,allow_start:true,seconds:20,preview:false},transport,resumed);await tick();
 await r.workareas.project(admin,{id:project.id,name:'共同制作',room_id:room.id,members:[b.id],expected_revision:1});await r.workareas.syncExecutions(transport);assert.equal(aborted,true);
 assert.equal((await store.execute({operation:'execution_status',area:project.id,epoch:r.workareas.epoch(),execution_id:second})).state,'cancelled');
});

test('disk pressure holds admission and remains cancellable without invoking work',async()=>{
 const pool=new ResourcePool(config,()=>false),cancel=new AbortController();
 const wait=pool.acquire(standardProfile,cancel.signal);const rejected=assert.rejects(wait);
 assert.equal(pool.status().waiting,1);assert.equal(pool.status().used.memory_mib,0);cancel.abort();await rejected;assert.equal(pool.status().waiting,0);
});

test('lost status and inspect replies do not restart a managed execution',async t=>{
 const {managedProgramRunner}=await import('../src/sandbox/managed.ts');const root=mkdtempSync(join(tmpdir(),'niwa-status-reconcile-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 let starts=0,reads=0,removed=0;
 const runner=managedProgramRunner({uid:1001,gid:1001,home:'/tmp',runtime:'/run/user/1001'},async args=>{
  if(args[0]==='run'){starts++;return {code:0,stdout:'container',stderr:''};}
  if(args[0]==='inspect')throw Error('lost read reply');
  if(args[0]==='rm'){removed++;return {code:0,stdout:'',stderr:''};}
  if(args.includes("import pathlib;print(pathlib.Path('/tmp/niwa-status').read_text())")){if(++reads===1)throw Error('lost read reply');return {code:0,stdout:JSON.stringify({done:true,code:0,stdout:'kept',stderr:''}),stderr:''};}
  return {code:0,stdout:'[]',stderr:''};
 });
 assert.equal((await runner.run(root,image,[['true']],standardProfile,10,`niwa-program-${randomUUID()}`,AbortSignal.timeout(5000))).stdout,'kept');assert.equal(starts,1);assert.equal(removed,1);assert.equal(reads,2);
});
