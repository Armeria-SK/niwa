// Bounded artificial acceptance. No production Runtime, image adoption, or external tools.
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
const [compiled,credentialFile,modelFile,receiptFile,clock='shortened',minutes='10']=process.argv.slice(2);
assert.ok(compiled&&credentialFile&&modelFile&&receiptFile,'Usage: node verify-initiative-model.mjs STAGED_BUILD CREDENTIAL_FILE MODELS_JSON RECEIPT [shortened|real-time] [minutes]');
assert.ok(['shortened','real-time'].includes(clock));const duration=Number(minutes);assert.ok(Number.isInteger(duration)&&duration>=1&&duration<=720);
assert.ok(!resolve(compiled).startsWith('/home/niwa/niwa/dist'),'Use a staged build');
const load=p=>import(pathToFileURL(join(resolve(compiled),p+'.js')).href);
const {Runtime}=await load('runtime/runtime'),{TurnRunner}=await load('runtime/turns'),{FileCredentialStore}=await load('auth/credential-store'),{CodexConnection}=await load('providers/codex/connection');
const root=mkdtempSync(join(tmpdir(),'niwa-initiative-model-'));let r=new Runtime(root),admin=r.administrator();
const report={clock,model:'gpt-5.6-sol',reasoning:'medium',cycles:0,model_calls:0,tools:[],reused:false,revised:false,restarted:false};
const deadline=Date.now()+duration*60000,controller=new AbortController();const stop=()=>controller.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);
const timer=setTimeout(stop,duration*60000);timer.unref();
try{
 const bot=r.bootstrap(admin),actor=r.agentSession(bot.id),room=r.createRoom(admin,'人工の継続制作');r.setAgentModel(admin,bot.id,'openai_subscription',report.model,report.reasoning);r.initiatives.enable(admin,true);
 r.updateProfile(admin,bot.id,{name:'継続検証Bot',persona:'人工の文章と表を検証する。実在人物・営業・外部操作・Bot作成は不要。異なる周期で同じ成果物を改善する。'});
 r.tasks.create(admin,bot.id,room.id,'人工検証の設定');const setup=r.tasks.claim(admin);
 const item=r.initiatives.save(actor,setup,{id:null,expected_revision:0,state:'active',review_at:0,body:{purpose:'整数リストの平均の説明を二つの周期で改善する',reason:'誤解しない検証付き説明を探究したい',completion:'例・空配列・負数・端数・誤った方法の棄却を含む一つの改訂済み成果物',next_action:'第1周期：平均の初稿をテキスト成果物に保存する。例[2,3]の合計と件数を記載。まだ端数・空配列・負数は検証せず、次周期の改善項目として残す。成果物IDをinitiative_saveのartifactsへ保存し、activity_checkpointで15分休息する。',method:'初稿から境界条件の検証へ',last_result:'未着手',participants:[bot.id],workarea:null,artifacts:[],wait:{kind:'none',detail:'',task_id:null}}});r.tasks.finish(actor,setup,'準備済み');
 const file=new FileCredentialStore(credentialFile),connection=new CodexConnection({experimental_opt_in:true,credential_store:{read:()=>file.read(),write:async()=>{throw Error('Credential refresh requires user action');},clear:async()=>{throw Error('Credential deletion prohibited');}}});
 const model=JSON.parse(readFileSync(modelFile,'utf8')).find(m=>m.model_id===report.model);assert.ok(model);
 const allowed=new Set(['initiative_list','initiative_select','initiative_save','history_read','history_search','artifact_inspect','artifact_create','artifact_revise','activity_checkpoint','task_rest','task_plan_update','task_summary_save','memory_review','work_note']);
 let firstArtifact;const started=Date.now();
 while(Date.now()<deadline&&!controller.signal.aborted){
  const now=clock==='shortened'?started+report.cycles*7200000:Date.now();r.autonomousWakes.dispatch(admin,now);const lease=r.tasks.claim(admin);
  if(!lease){await delay(1000,undefined,{signal:controller.signal}).catch(()=>{});continue;}
  assert.equal(r.initiatives.current(r.agentSession(bot.id),lease.task.id)?.id,item.id);
  const runner=new TurnRunner(r,async()=>{
   const adapter=connection.create({runtime:'gpt',provider_id:'openai_subscription',provider_model_id:model.model_id,supported_efforts:model.supported_efforts,context_window:model.context_window,max_output_tokens:4096,supports_tool_calls:true,supports_structured_output:false,supports_streaming:true,supports_session_resume:false,supports_parallel_sessions:false,supports_usage_reporting:true});
   return {...adapter,async *run(request,options){report.model_calls++;for await(const event of adapter.run({...request,tools:request.tools.filter(t=>allowed.has(t.name))},options)){if(event.type==='tool_call'){report.tools.push({cycle:report.cycles+1,name:event.name});console.log('Tool:',report.cycles+1,event.name);if(report.cycles>0&&['history_read','artifact_inspect'].includes(event.name))report.reused=true;}yield event;}}};
  });
  await runner.run(lease,controller.signal);const state=r.tasks.get(admin,lease.task.id).state;
  if(state==='waiting_provider')break;assert.equal(state,'completed');report.cycles++;
  const artifacts=r.artifacts(admin).filter(a=>a.room_id===room.id).map(a=>r.artifact(admin,a.id));
  report.artifacts=artifacts.map(a=>({name:a.name,content:a.content}));
  if(report.cycles===1){assert.ok(artifacts.length);firstArtifact=artifacts[0];assert.ok(r.initiatives.get(admin,item.id).body.artifacts.length,'Persist the existing artifact reference');r.close();r=new Runtime(root);admin=r.administrator();report.restarted=true;}
  else{report.revised=artifacts.some(a=>a.id!==firstArtifact.id&&a.content!==firstArtifact.content)&&report.tools.some(t=>t.cycle>1&&t.name==='artifact_revise');if(report.reused&&report.revised)break;}
  if(clock==='shortened'&&report.cycles>=3)break;
 }
 assert.ok(report.cycles>=2&&report.reused&&report.revised&&report.restarted,'Require a later cycle to read and revise the previous artifact after restart');
 assert.equal(r.initiatives.list(admin).length,1);assert.equal(r.schedules.list(admin).length,0);
 report.result='PASS';console.log('PASS: previous artifact read and revised in a subsequent wake after restart; no schedules or external tools');
}finally{
 clearTimeout(timer);r.close();rmSync(root,{recursive:true,force:true});writeFileSync(receiptFile,JSON.stringify(report,null,2),{mode:0o600});process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);
}
