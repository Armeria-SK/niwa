// Artificial application + separate real executor. Never opens the live application state.
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
const [mode,root,compiled,image,bridge]=process.argv.slice(2);
assert.ok(root?.includes('/.model-execution-test-'));assert.ok(compiled?.startsWith('/'));assert.ok(bridge?.startsWith('/tmp/niwa-model-bridge-')); 
const load=p=>import(pathToFileURL(join(compiled,p+'.js')).href);
if(mode==='executor'){
 assert.equal(process.getuid(),1001);
 const {WorkareaStore}=await load('tools/workareas/store'),{EnvironmentRegistry}=await load('tools/environments/registry'),{PackageCatalog}=await load('tools/packages/catalog'),{ResourcePool,standardProfile}=await load('sandbox/resources'),{managedProgramRunner}=await load('sandbox/managed'),{configuredProgramRunner}=await load('sandbox/program'),{createProgramServer}=await load('sandbox/server');
 const home='/home/niwa/niwa/runtime/executor/home',uid=process.getuid(),env={workspace:root,image,uid,gid:process.getgid(),home,runtime:`/run/user/${uid}`},run=configuredProgramRunner(env);
 mkdirSync(root+'/catalog',{recursive:true,mode:0o700});writeFileSync(root+'/catalog/catalog.json','[]',{mode:0o600});mkdirSync(root+'/files',{recursive:true,mode:0o711});
 const catalog=new PackageCatalog(root+'/catalog'),registry=new EnvironmentRegistry(root+'/env.db',image,catalog,async()=>{throw Error('No dependency installation in model test');},async id=>(await run.call(['image','exists',id],15)).code===0);
 const pool=new ResourcePool({capacity:{memory_mib:2048,cpu:3,pids:512,disk_mib:1024},reserve:{memory_mib:512,cpu:1,pids:64,disk_mib:128},profiles:{standard:standardProfile}});
 const store=new WorkareaStore(root+'/files',(workspace,request,signal,name,pinned)=>configuredProgramRunner({...env,workspace,image:pinned??image})(request,signal,name),run.cleanup,registry,{pool,runner:managedProgramRunner(env,run.call)});await store.recover();
 const server=createProgramServer({execute:async()=>{throw Error('Only workareas allowed');}},undefined,store);server.server.listen(bridge+'/ipc/executor.sock',()=>{chmodSync(bridge+'/ipc/executor.sock',0o660);console.log('Artificial executor ready');});
 const stop=async()=>{await server.stop();store.close();registry.close();process.exit(0);};process.once('SIGTERM',()=>void stop());process.once('SIGINT',()=>void stop());
}else{
 const {Runtime}=await load('runtime/runtime'),{workareaClient}=await load('tools/workareas/client');
 assert.equal(process.getuid(),1000);
 const app=bridge+'/app',r=new Runtime(app+'/state'),admin=r.administrator(),transport=workareaClient(bridge+'/ipc/executor.sock',1001);
 try{
 if(mode==='model'){
  const {TurnRunner}=await load('runtime/turns'),{FileCredentialStore}=await load('auth/credential-store'),{CodexConnection}=await load('providers/codex/connection');
  const a=r.bootstrap(admin),aa=r.agentSession(a.id),b=r.createAgent(aa,'人工の共同担当'),room=r.createRoom(admin,'人工の実モデル実行');r.workareas.enable(admin,true);
  r.setAgentModel(admin,a.id,'openai_subscription','gpt-5.6-sol','medium');
  const area=(await r.workareas.project(admin,{name:'人工案件',room_id:room.id,members:[a.id,b.id]})).id;
  const scoped=(input)=>r.workareas.execute(admin,area,input,transport);
  const lock='{"synthetic":1}\n',lockHash=createHash('sha256').update(lock).digest('hex');await scoped({operation:'write',path:'lock.json',content:lock,operation_id:randomUUID(),allow_start:true});
  const catalog=await scoped({operation:'environment_list'});
  const definition={name:'人工の待機と再開',base_image:catalog.base_image,catalog_revision:catalog.catalog_revision,dependencies:[],lockfiles:[{path:'lock.json',sha256:lockHash}],workdir:'/workspace',prepare:[],run:['python','-c',"import time,pathlib;print('started',flush=True);time.sleep(90);pathlib.Path('result.txt').write_text('synthetic result: 2+3=5');print('completed',flush=True)"],verify:['python','-c',"import pathlib;assert pathlib.Path('lock.json').is_file()"],profile:'standard'};
  const version=await scoped({operation:'environment_prepare',definition,allow_start:true});assert.equal(version.state,'ready');
  assert.equal((await scoped({operation:'environment_test',environment:version.id,operation_id:randomUUID(),allow_start:true,seconds:10})).code,0);
  await scoped({operation:'environment_activate',environment:version.id,expected_environment:null,operation_id:randomUUID(),allow_start:true});
  const task=r.tasks.create(admin,a.id,room.id,`人工の連続検証です。workspace_selectで案件 ${area} を選び、採用済み環境をexecution_start(seconds=150,preview=false)で一度だけ起動してください。90秒かかります。返された実行IDでexecution_waitを単独で呼び、モデル枠を解放してください。再開後は同じIDのexecution_statusを確認し、result.txtをworkspace_readで読み、結果を短く報告してください。環境を作り直さず、実行を重複起動せず、外部操作は不要です。`);
  const taskId=task.id;const file=new FileCredentialStore('/home/niwa/niwa/secrets/codex.json');const connection=new CodexConnection({experimental_opt_in:true,credential_store:{read:()=>file.read(),write:async()=>{throw Error('Read-only authentication');},clear:async()=>{throw Error('Read-only authentication');}}});
  const model=JSON.parse(readFileSync('/home/niwa/niwa/.local/acceptance/models.json','utf8')).find(m=>m.model_id==='gpt-5.6-sol');
  const allowed=new Set(['workspace_select','workspace_areas','workspace_read','environment_list','execution_start','execution_wait','execution_status','task_plan_update','task_summary_save','conversation_send','work_note','memory_review']);let calls=0;const seen=[];
  const runner=new TurnRunner(r,async()=>{const adapter=connection.create({runtime:'gpt',provider_id:'openai_subscription',provider_model_id:model.model_id,supported_efforts:model.supported_efforts,context_window:model.context_window,max_output_tokens:4096,supports_tool_calls:true,supports_structured_output:false,supports_streaming:true,supports_session_resume:false,supports_parallel_sessions:false,supports_usage_reporting:true});return {...adapter,async *run(request,options){calls++;for await(const event of adapter.run({...request,tools:request.tools.filter(t=>allowed.has(t.name))},options)){if(event.type==='tool_call'){seen.push(event.name);console.log('Tool',event.name);}if(event.type==='failed')console.log('Model error',event.error.code);yield event;}}};},{workareas:transport});
  let syncing=Promise.resolve();const timer=setInterval(()=>{syncing=syncing.then(()=>r.workareas.syncExecutions(transport)).catch(e=>{console.error('Artificial sync',e.message);});},1000);
  let waited=false;
  try{const limit=Date.now()+360000;while(Date.now()<limit){const current=r.tasks.get(admin,taskId);if(current.state==='completed')break;const lease=r.tasks.claim(admin);if(lease){assert.equal(lease.task.id,taskId);await runner.run(lease,AbortSignal.timeout(180000));}else{waited=true;await delay(200);}}
   assert.equal(r.tasks.get(admin,taskId).state,'completed');assert.ok(waited,'Model slot was released');for(const name of ['execution_start','execution_wait','execution_status','workspace_read'])assert.ok(seen.includes(name),name);
   assert.equal(seen.filter(n=>n==='execution_start').length,1);const executions=await transport({area,epoch:r.workareas.epoch(),operation:'execution_list'});assert.equal(executions.executions.length,1);assert.equal(executions.executions[0].state,'completed');
   assert.equal((await scoped({operation:'read',path:'result.txt'})).content,'synthetic result: 2+3=5');
   writeFileSync(app+'/fixture.json',JSON.stringify({area,epoch:r.workareas.epoch(),a:a.id,b:b.id,room:room.id,environment:version.id,image,lockHash,execution:executions.executions[0].id,task:taskId}));
   console.log('PASS actual model + real container: one start, wait released slot, resumed result read',JSON.stringify({calls,model:model.model_id,effort:'medium'}));
  }finally{clearInterval(timer);await syncing;}
 }else if(mode==='reopen'){
  const f=JSON.parse(readFileSync(app+'/fixture.json','utf8')),ba=r.agentSession(f.b),task=r.tasks.create(admin,f.b,f.room,'別参加者による再起動後検証'),lease=r.tasks.claim(admin);assert.equal(lease.task.id,task.id);r.workareas.select(ba,lease,f.area);
  const scoped=input=>r.workareas.execute(ba,f.area,input,transport,lease);
  const info=await scoped({operation:'environment_list'});assert.equal(info.active,f.environment);assert.equal(info.versions.find(v=>v.id===f.environment).definition.lockfiles[0].sha256,f.lockHash);
  const result=await scoped({operation:'run',command:['python','-c',"import pathlib;assert pathlib.Path('result.txt').read_text()=='synthetic result: 2+3=5';print('reopened')"],operation_id:randomUUID(),allow_start:true,seconds:10});assert.equal(result.code,0);assert.equal(result.image,f.image);
  assert.equal((await transport({area:f.area,epoch:f.epoch,operation:'execution_status',execution_id:f.execution})).state,'completed');
  const execution=await r.workareas.execution(ba,f.area,{operation:'execution_start',operation_id:randomUUID(),allow_start:true,seconds:120,preview:false},transport,lease);
  for(let i=0;i<100;i++){await r.workareas.syncExecutions(transport);const status=await transport({area:f.area,epoch:f.epoch,operation:'execution_status',execution_id:execution.id});if(status.logs?.stdout?.includes('started'))break;await delay(200);}
  await r.workareas.project(admin,{id:f.area,name:'人工案件',room_id:f.room,members:[f.a],expected_revision:1});await r.workareas.syncExecutions(transport);
  assert.equal((await transport({area:f.area,epoch:f.epoch,operation:'execution_status',execution_id:execution.id})).state,'cancelled');
  console.log('PASS restart + second participant: pinned image/lockfile, saved result, revoked running container stopped');
 }else throw Error('Unknown mode');
 }finally{r.close();}
}
