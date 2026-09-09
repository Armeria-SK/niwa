// Real executor attestation on bounded, artificial workareas; no image build/removal.
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
const [root,compiled,image]=process.argv.slice(2);assert.ok(root?.includes('/.flow-verification-'));assert.equal(process.getuid(),1001);
const load=p=>import(pathToFileURL(join(compiled,p+'.js')).href),sha=s=>createHash('sha256').update(s).digest('hex');
const {Runtime}=await load('runtime/runtime'),{WorkareaStore}=await load('tools/workareas/store'),{EnvironmentRegistry}=await load('tools/environments/registry'),{PackageCatalog}=await load('tools/packages/catalog'),{configuredProgramRunner}=await load('sandbox/program');
const env={workspace:root,image,uid:process.getuid(),gid:process.getgid(),home:'/home/niwa/niwa/runtime/executor/home',runtime:'/run/user/1001'},base=configuredProgramRunner(env);
mkdirSync(root+'/catalog',{mode:0o700});writeFileSync(root+'/catalog/catalog.json','[]',{mode:0o600});mkdirSync(root+'/files',{mode:0o711});
let catalog=new PackageCatalog(root+'/catalog'),registry=new EnvironmentRegistry(root+'/env.db',image,catalog,async()=>{throw Error('No installation');},async id=>(await base.call(['image','exists',id],15)).code===0);let store=new WorkareaStore(root+'/files',(workspace,request,signal,name,pinned)=>configuredProgramRunner({...env,workspace,image:pinned??image})(request,signal,name),base.cleanup,registry);const transport=input=>store.execute(input);
let r=new Runtime(root+'/state'),admin=r.administrator();const a=r.bootstrap(admin),aa=r.agentSession(a.id),b=r.createAgent(aa,'人工の確認担当'),room=r.createRoom(admin,'人工の一連作業');
const report={image,steps:[]};
try{
 r.quality.enable(admin,true);r.workareas.enable(admin,true);r.initiatives.enable(admin,true);r.tasks.create(admin,a.id,room.id,'個人試作から案件の固定版まで');let lease=r.tasks.claim(admin);
 const personal=r.workareas.personal(aa,lease).area_id,project=(await r.workareas.project(admin,{name:'人工の共同制作',room_id:room.id,members:[a.id,b.id]})).id;
 const body={purpose:'計算例を再現可能な形で改善する',reason:'前日の実物を引き継ぎたい',completion:'実行確認した固定版を共有し再起動後に同じ版を使える',next_action:'個人試作を案件へ明示共有する',method:'固定ファイルとassertの照合',last_result:'未着手',participants:[a.id,b.id],workarea:null,artifacts:[],wait:{kind:'none',detail:'',task_id:null}};
 const initiative=r.initiatives.save(aa,lease,{id:null,expected_revision:0,body,state:'active',review_at:0});
 const content='assert sum([2,3,4])/3 == 3\nprint("mean=3")\n';await r.workareas.execute(aa,personal,{operation:'write',path:'main.py',content,expected_revision:null,operation_id:randomUUID(),allow_start:true},transport,lease);
 assert.throws(()=>r.workareas.authorize(r.agentSession(b.id),personal,lease));
 const draft=await r.workareas.share(aa,lease,personal,'main.py',sha(content),transport,randomUUID(),true,undefined,project);assert.equal(r.artifactVersions.inspect(r.agentSession(b.id),draft.artifact_id).sha256,sha(content));report.steps.push('initiative -> private draft -> explicit project share');
 r.workareas.select(aa,lease,project);const exec=input=>r.workareas.execute(aa,project,input,transport,lease);
 await exec({operation:'write',path:'main.py',content:r.artifact(aa,draft.artifact_id).content,expected_revision:null,operation_id:randomUUID(),allow_start:true});const lock='{"fixture":"mean-v1"}\n';await exec({operation:'write',path:'lock.json',content:lock,expected_revision:null,operation_id:randomUUID(),allow_start:true});
 r.tasks.finish(aa,lease,'個人試作を案件へ共有');r.tasks.create(admin,a.id,room.id,'案件の検査と引渡し');lease=r.tasks.claim(admin);r.initiatives.select(aa,lease,initiative.id);r.workareas.select(aa,lease,project);
 r.quality.plan(aa,lease,0,{criteria:[{id:'test',kind:'execution',condition:'平均3のassertが固定環境で成功する'}],stop_condition:'期待値と実行結果が一致したら終了'});
 const fixed=await r.workareas.share(aa,lease,project,'main.py',sha(content),transport,randomUUID(),true),manifest=r.quality.manifest(aa,lease,'再現対象',[{path:'main.py',id:fixed.artifact_id,sha256:sha(content)}]);
 const definition={name:'人工平均環境',base_image:image,catalog_revision:catalog.revision,dependencies:[],lockfiles:[{path:'lock.json',sha256:sha(lock)}],workdir:'/workspace',prepare:[],run:['python','main.py'],verify:['python','main.py'],profile:'standard'};
 const environment=await exec({operation:'environment_prepare',definition,allow_start:true});const output=await r.tasks.externalOnce(aa,lease,'checked',{name:'environment_test'},id=>exec({operation:'environment_test',environment:environment.id,operation_id:id,allow_start:true,seconds:20}));assert.equal(output.code,0);
 await exec({operation:'environment_activate',environment:environment.id,expected_environment:null,operation_id:randomUUID(),allow_start:true});
 r.quality.record(aa,lease,{artifact_id:manifest.id,sha256:manifest.sha256,criterion:'test',reference:'checked',method:'固定imageでassertを実行',claim:'平均3',excerpt:'',assessment:'supports',limits:'人工の一例のみ'});
 r.artifactVersions.review(r.agentSession(b.id),manifest.id,manifest.sha256,'approved','整数リストの平均3という条件と実行結果が一致しています。',[{criterion:'test',verdict:'pass',note:'固定環境と対象ファイルのassert成功を確認しました。'}]);r.artifactVersions.freeze(aa,manifest.id,manifest.sha256);
 const updated=r.initiatives.save(aa,lease,{id:initiative.id,expected_revision:initiative.revision,body:{...body,workarea:project,artifacts:[manifest.id],last_result:'固定版のassert成功と内容レビューを確認',next_action:'再起動後に同じ固定環境とlockfileで計算を継続する'},state:'active',review_at:0});
 r.updateCoordination(aa,lease,{expected_revision:0,completion_condition:'固定版の再利用',stop_condition:'同じ成果物を重複生成しない',blocker:'',waiting_for:null,next_agent_id:b.id,notify:'none'});r.reviewReady(aa,lease,manifest.id,manifest.sha256);const child=r.handoff(aa,lease,'確認済みの固定版を参照し、次周期も同じ案件で使ってください');
 const childLease=r.tasks.claim(admin);assert.equal(childLease.task.id,child.task_id);r.tasks.finish(r.agentSession(b.id),childLease,'固定版を受け取りました');const parentLease=r.tasks.claim(admin);r.tasks.finish(aa,parentLease,'次周期へ保存済み');report.steps.push('project -> pinned execution -> evidence/review/freeze -> one delivery');
 r.close();store.close();registry.close();
 r=new Runtime(root+'/state');admin=r.administrator();catalog=new PackageCatalog(root+'/catalog');registry=new EnvironmentRegistry(root+'/env.db',image,catalog,async()=>{throw Error('No installation');},async id=>(await base.call(['image','exists',id],15)).code===0);store=new WorkareaStore(root+'/files',(workspace,request,signal,name,pinned)=>configuredProgramRunner({...env,workspace,image:pinned??image})(request,signal,name),base.cleanup,registry);await store.recover();
 const actor=r.agentSession(a.id),again=r.initiatives.get(actor,initiative.id);assert.equal(again.revision,updated.revision);assert.equal(again.body.artifacts[0],manifest.id);assert.equal(r.artifactVersions.inspect(actor,manifest.id).quality.verified,true);
 r.tasks.create(admin,a.id,room.id,'前回の実物と固定環境を確認して同じ計算を継続');const resumed=r.tasks.claim(admin);r.initiatives.select(actor,resumed,initiative.id);
 const {TurnRunner}=await load('runtime/turns'),{openAISubscriptionAdapterCapabilities}=await load('providers/codex/adapter');let step=0;
 const runner=new TurnRunner(r,async()=>({adapter_id:'artificial',capabilities:openAISubscriptionAdapterCapabilities,async *run(request){assert.match(request.system_instructions,/structured-v5/);const state=JSON.parse(request.messages.at(-1).content).work_state;assert.equal(state.initiative.id,initiative.id);let name,args;
 if(request.tools.length===1&&request.tools[0].name==='memory_review'){name='memory_review';args={memories:[]};}
 else if(request.tools.length===1&&request.tools[0].name==='task_summary_save'){name='task_summary_save';args={conclusion:'同じ環境で再実行',reason:'固定版の結果',unresolved:[],next_steps:[],sources:state.summary_sources.slice(0,1).map(({kind,source_id,revision})=>({kind,source_id,revision}))};}
 else if(step++===0){name='environment_list';args={};}
 else if(step===2){const result=JSON.parse(request.messages.findLast(m=>m.role==='tool').content);assert.equal(result.active,environment.id);name='program_run';args={command:['python','main.py'],seconds:20};}
 else{const result=JSON.parse(request.messages.findLast(m=>m.role==='tool').content);assert.equal(result.code,0);assert.match(result.stdout,/mean=3/);yield {type:'text_delta',text:'同じ固定環境と前回の計算を再確認しました。'};yield {type:'completed',finish_reason:'stop'};return;}
 yield {type:'tool_call',tool_call_id:name,name,arguments:args};yield {type:'completed',finish_reason:'tool_calls'};
 }}),{workareas:transport},{promptVersion:'structured-v5'});
 await runner.run(resumed,AbortSignal.timeout(120000));assert.equal(r.tasks.get(admin,resumed.task.id).state,'completed');assert.equal(r.initiatives.list(admin).length,1);report.steps.push('restart -> same initiative/files/lock/image -> structured prompt -> real execution');report.result='PASS';console.log(JSON.stringify(report));
}finally{r.close();store.close();registry.close();writeFileSync(root+'/receipt.json',JSON.stringify(report,null,2),{mode:0o600});}
