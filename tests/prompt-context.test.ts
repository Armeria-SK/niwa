import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Runtime} from '../src/runtime/runtime.ts';
import {TurnRunner} from '../src/runtime/turns.ts';
import {openAISubscriptionAdapterCapabilities} from '../src/providers/codex/adapter.ts';
import type {ModelAdapter} from '../src/providers/shared/adapter.ts';
import type {ModelRequest,ModelEvent} from '../src/contracts/model.ts';
import {scopedPromptTools} from '../src/runtime/context/prompt.ts';
import {turnTools} from '../src/runtime/turn-tools.ts';
const done=(text:string):ModelEvent[]=>[{type:'text_delta',text},{type:'completed',finish_reason:'stop'}];
const call=(name:string,args:Record<string,unknown>):ModelEvent[]=>[{type:'tool_call',tool_call_id:name,name,arguments:args},{type:'completed',finish_reason:'tool_calls'}];
function fixture(t:{after(fn:()=>void):void}){const root=mkdtempSync(join(tmpdir(),'niwa-prompts-')),r=new Runtime(root),admin=r.administrator(),a=r.bootstrap(admin),aa=r.agentSession(a.id),room=r.createRoom(admin,'人工評価');t.after(()=>{r.close();rmSync(root,{recursive:true,force:true});});return {root,r,admin,a,aa,room};}
function model(run:(request:ModelRequest)=>ModelEvent[]):ModelAdapter{return {adapter_id:'artificial',capabilities:openAISubscriptionAdapterCapabilities,async *run(request){yield* run(request);}};}
test('structured instructions separate saved policy and phases; retain administrator requirements outside recent messages',async t=>{
 const {r,admin,a,aa,room}=fixture(t);r.updateCommonRules(admin,r.commonRules(admin).revision,'人工方針をそのまま保持');r.updateProfile(admin,a.id,{name:'人工Bot',persona:'静かな観察者'});
 r.post(admin,room.id,'古いが重要：人数を推測しない');for(let i=0;i<35;i++)r.post(aa,room.id,`古い会話${i}`);
 let phases=0;const runner=new TurnRunner(r,async()=>model(req=>{
  const state=JSON.parse(req.messages.at(-1)!.content!).work_state;
  assert.match(req.system_instructions,/structured-v5/);assert.match(req.system_instructions,/人工方針をそのまま保持/);assert.match(req.system_instructions,/静かな観察者/);assert.doesNotMatch(req.system_instructions,/発言の先頭に「@/);
  assert.match(JSON.stringify(req.messages),/古いが重要/);assert.doesNotMatch(JSON.stringify(req.messages),/古い会話0"/);assert.equal(state.task.prompt,undefined);assert.equal(JSON.stringify(req.messages).split('今回の依頼は人数の根拠照合').length-1,1);
  phases++;if(req.tools.length===1){assert.match(req.system_instructions,/記憶整理/);assert.doesNotMatch(req.system_instructions,/会話はconversation_sendを単独/);return call('memory_review',{memories:[]});}
  assert.match(req.system_instructions,/本文に宛先の@を重ねません/);assert.ok(req.tools.some(t=>t.name==='history_read'));assert.ok(!req.tools.some(t=>t.name==='quality_plan'));return done('人数は未確認です。');
 }),{},{promptVersion:'structured-v5'});
 const task=r.tasks.create(admin,a.id,room.id,'今回の依頼は人数の根拠照合');await runner.run(r.tasks.claim(admin)!);assert.equal(phases,2);const runs=r.tasks.promptRuns(admin,task.id);assert.equal(runs.length,2);assert.ok(runs.every(x=>x.version==='structured-v5'&&Number(x.input_bytes)>0));assert.ok(!JSON.stringify(runs).includes('静かな'));assert.equal(r.commonRules(admin).body,'人工方針をそのまま保持');
});
test('composition binding persists on restart and never replays a committed tool with new instructions',async t=>{
 const f=fixture(t),{r,admin,a,aa,room,root}=f;const task=r.tasks.create(admin,a.id,room.id,'人工再開'),lease=r.tasks.claim(admin)!;
 assert.equal(r.tasks.bindPrompt(aa,lease,'structured-v5'),'structured-v5');r.tasks.saveStep(aa,lease,r.context(aa,room.id).revision,call('artifact_create',{name:'一つだけ',kind:'text',description:'人工',content:'人工の成果物'}));
 await new TurnRunner(r,async()=>model(()=>done('完了')),{},{promptVersion:'legacy-v4'}).run(lease);assert.equal(r.artifacts(admin).length,1);assert.equal(r.tasks.promptRuns(admin,task.id)[0]!.version,'structured-v5');
 const reopen=new Runtime(root);try{assert.equal(reopen.tasks.promptRuns(reopen.administrator(),task.id)[0]!.version,'structured-v5');}finally{reopen.close();}
 // Work that predates composition metadata retains legacy even when the installation opts in.
 const next=r.tasks.create(admin,a.id,room.id,'旧仕事');const l=r.tasks.claim(admin)!;r.tasks.saveStep(aa,l,r.context(aa,room.id).revision,done('保存済み'));assert.equal(r.tasks.bindPrompt(aa,l,'structured-v5'),'legacy-v4');assert.notEqual(next.id,task.id);
});
test('capability filtering advertises current independent boundary without changing runtime authorization',t=>{
 const {r,admin,a,aa,room}=fixture(t);r.tasks.create(admin,a.id,room.id,'人工点検');const lease=r.tasks.claim(admin)!,state=r.tasks.workState(aa,lease),unavailable=async():Promise<never>=>{throw Error('not called');};
 const tools=turnTools(true,{program:unavailable,workspace:unavailable,workspaceWrite:unavailable,workareas:unavailable},true,true,true);
 const scoped=scopedPromptTools(tools,{...state,independent_activity:true},false).map(t=>t.name);
 for(const name of ['program_run','environment_list','execution_start','workspace_write','artifact_download','quality_plan','initiative_list'])assert.ok(!scoped.includes(name),name);
 for(const name of ['history_read','artifact_create','work_note','task_rest'])assert.ok(scoped.includes(name),name);
});

for(const version of ['legacy-v4','structured-v5'] as const)for(let repeat=0;repeat<2;repeat++){
 test(`${version} repetition ${repeat+1}: budget wait, stop and reopening retain one operation`,async t=>{
  const {r,admin,aa,root}=fixture(t),now=Date.now();r.autonomousWakes.dispatch(admin,now);r.autonomousWakes.dispatch(admin,now+60000);const lease=r.tasks.claim(admin)!;
  for(let i=0;i<23;i++)assert.equal(r.tasks.reserveModelCall(aa,lease),true);
  const adapter=model(req=>{
   if(req.tools.length===1&&req.tools[0]!.name==='memory_review')return call('memory_review',{memories:[]});
   if(req.tools.length===1&&req.tools[0]!.name==='task_summary_save'){const s=JSON.parse(req.messages.at(-1)!.content!).work_state;return call('task_summary_save',{conclusion:'一つの成果物',reason:'保存結果',unresolved:[],next_steps:[],sources:s.summary_sources.slice(0,1).map(({kind,source_id,revision}:{kind:string;source_id:string;revision:string})=>({kind,source_id,revision}))});}
   return req.messages.some(m=>m.role==='tool'&&m.name==='artifact_create')?done('保存済みです'):call('artifact_create',{name:'一回だけ',kind:'text',description:'人工',content:'予算の前後で同じ実物'});
  });
  await new TurnRunner(r,async()=>adapter,{},{promptVersion:version}).run(lease);assert.equal(r.artifacts(admin).length,1);const wait=r.tasks.get(admin,lease.task.id);assert.equal(wait.state,'waiting_provider');assert.equal(r.approvals(admin).length,0);
  r.updateSettings(admin,{paused:true});r.tasks.retryProviders(admin,wait.provider_retry_at!);assert.equal(r.tasks.claim(admin),undefined);
  const db=new DatabaseSync(join(root,'control.db'));assert.equal(db.prepare('SELECT model_calls FROM autonomous_wakes LIMIT 1').get()!.model_calls,24);db.prepare('UPDATE autonomous_wakes SET budget_reset_at=?').run(Date.now()-1);db.close();
  const reopen=new Runtime(root);try{const ad=reopen.administrator();reopen.updateSettings(ad,{paused:false});reopen.tasks.retryProviders(ad,wait.provider_retry_at!);const resumed=reopen.tasks.claim(ad)!;assert.equal(resumed.task.id,lease.task.id);await new TurnRunner(reopen,async()=>adapter,{},{promptVersion:version==='legacy-v4'?'structured-v5':'legacy-v4'}).run(resumed);assert.equal(reopen.tasks.get(ad,lease.task.id).state,'completed');assert.equal(reopen.artifacts(ad).length,1);assert.ok(reopen.tasks.promptRuns(ad,lease.task.id).every(x=>x.version===version));}finally{reopen.close();}
 });
 test(`${version} repetition ${repeat+1}: correction invalidates stale model data and private memory stays absent`,async t=>{
  const {r,admin,a,aa,room}=fixture(t),source=r.post(admin,room.id,'人工の共有出所'),memory=r.remember(aa,source.id,'訂正前の固有値');const other=r.createAgent(aa,'人工の別Bot'),ba=r.agentSession(other.id),privateRoom=r.createRoom(admin,'人工の私室',[other.id]),privateSource=r.post(admin,privateRoom.id,'非共有fixture');r.remember(ba,privateSource.id,'他Botだけの固有値');let calls=0;
  const task=r.tasks.create(admin,a.id,room.id,'現在の値を回答');await new TurnRunner(r,async()=>model(req=>{
   assert.doesNotMatch(JSON.stringify(req),/他Botだけの固有値/);
   if(req.tools.length===1)return call('memory_review',{memories:[]});
   if(calls++===0){r.correctMemory(admin,a.id,memory.id,1,'訂正後の値8');return done('破棄される旧回答');}
   assert.doesNotMatch(JSON.stringify(req),/訂正前の固有値/);assert.match(JSON.stringify(req),/訂正後の値8/);return done('現在は8です');
  }),{},{promptVersion:version}).run(r.tasks.claim(admin)!);assert.equal(r.tasks.get(admin,task.id).result,'現在は8です');assert.ok(!r.messages(admin,room.id).some(m=>m.body==='破棄される旧回答'));
 });
}

test('structured no-tool model receives the exact memory-stage JSON schema without work instructions',async t=>{
 const {r,admin,a,aa,room}=fixture(t);r.post(admin,room.id,'人工の会話');let calls=0;
 const adapter={...model(req=>{calls++;if(calls===1){assert.match(req.system_instructions,/返すJSON schema:/);assert.match(req.system_instructions,/source_message_id/);assert.doesNotMatch(req.system_instructions,/会話はconversation_sendを単独/);return done('{"memories":[]}');}return done('現在の会話に回答');}),capabilities:{...openAISubscriptionAdapterCapabilities,supports_tool_calls:false}};
 const task=r.tasks.create(admin,a.id,room.id,'短い返答');await new TurnRunner(r,async()=>adapter,{},{promptVersion:'structured-v5'}).run(r.tasks.claim(admin)!);assert.equal(calls,2);assert.equal(r.tasks.get(aa,task.id).state,'completed');
});
test('structured rolling context keeps complete exchanges and discards opaque continuation',async t=>{
 const {r,admin,a,room}=fixture(t);let calls=0,resolves=0;
 const runner=new TurnRunner(r,async()=>{resolves++;return model(req=>{
  const tools=req.messages.filter(m=>m.role==='tool');assert.ok(tools.length<=8);
  for(let i=0;i<req.messages.length;i++){const message=req.messages[i]!;if(message.role==='tool'){const prior=req.messages[i-1];assert.equal(prior?.role,'assistant');assert.equal(prior?.role==='assistant'&&prior.tool_calls?.[0]?.tool_call_id,message.tool_call_id);}}
  if(calls++<10)return call('work_note',{body:`人工の確認済み結果 ${calls}`});return done('確認を完了');
 });},{},{promptVersion:'structured-v5'});
 r.tasks.create(admin,a.id,room.id,'続く操作の文脈');await runner.run(r.tasks.claim(admin)!);assert.equal(calls,11);assert.ok(resolves>1);
});
