import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {Runtime} from '../src/runtime/runtime.ts';
import {TurnRunner} from '../src/runtime/turns.ts';
import {openAISubscriptionAdapterCapabilities} from '../src/providers/codex/adapter.ts';
import type {ModelEvent,ModelRequest} from '../src/contracts/model.ts';
import type {ModelAdapter} from '../src/providers/shared/adapter.ts';

const tool=(name:string,args:Record<string,unknown>):ModelEvent[]=>[
 {type:'tool_call',tool_call_id:'synthetic',name,arguments:args},{type:'completed',finish_reason:'tool_calls'},
];
const done:ModelEvent[]=[{type:'text_delta',text:'確認できた範囲の結果です。'},{type:'completed',finish_reason:'stop'}];
function adapter(reply:(request:ModelRequest)=>ModelEvent[]):ModelAdapter {
 return {adapter_id:'artificial',capabilities:openAISubscriptionAdapterCapabilities,async *run(request){
  if(request.tools.length===1&&request.tools[0]!.name==='memory_review'){yield* tool('memory_review',{memories:[]});return;}
  if(request.tools.length===1&&request.tools[0]!.name==='task_summary_save'){
   const state=JSON.parse(request.messages.at(-1)!.content!).work_state;
   yield* tool('task_summary_save',{conclusion:'人工の結果',reason:'保存した出所を確認',unresolved:[],next_steps:[],sources:state.summary_sources.slice(0,1).map(({kind,source_id,revision}:{kind:string;source_id:string;revision:string})=>({kind,source_id,revision}))});return;
  }
  yield* reply(request);
 }};
}
function fixture(t:{after(fn:()=>void):void}) {
 const root=mkdtempSync('/tmp/niwa-relay-'),r=new Runtime(root),admin=r.administrator(),a=r.bootstrap(admin),aa=r.agentSession(a.id),b=r.createAgent(aa,'人工の担当'),ba=r.agentSession(b.id),room=r.createRoom(admin,'人工の調査');
 const parent=r.tasks.create(admin,a.id,room.id,'資料を比較する'),pl=r.tasks.claim(admin)!,child=r.tasks.delegate(aa,pl,b.id,'資料を調べて結果を返す'),lease=r.tasks.claim(admin)!;
 r.reviewMemory(ba,lease,{memories:[]});
 for(let i=0;i<18;i++){const step=i<10?i:i-10;r.tasks.observe(ba,lease,'seed:'+i,'task_history_read',{step,offset:0,revision:null},{revision:String(step),text:'人工資料'+step});}
 t.after(()=>{r.close();rmSync(root,{recursive:true,force:true});});
 return {root,r,admin,a,aa,b,ba,room,parent,child,lease};
}

test('a persisted stalled child gets a recovery response and completion summary, waking its parent once',async t=>{
 const {r,root,admin,ba,room,parent,child,lease}=fixture(t);
 r.tasks.updatePlan(ba,lease,'plan',0,['確認できた範囲を報告する']);
 r.tasks.wait(ba,lease,'waiting_provider','旧版の停滞待機',true);r.tasks.waitKind(ba,lease,'stalled');
 r.close();const reopened=new Runtime(root);t.after(()=>reopened.close());const ad=reopened.administrator();
 reopened.tasks.retryProviders(ad,reopened.tasks.get(ad,child.id).provider_retry_at!+1);
 let calls=0;
 const runner=new TurnRunner(reopened,async()=>adapter(request=>{calls++;const state=JSON.parse(request.messages.at(-1)!.content!).work_state;assert.equal(state.read_observations.repeated_reads,8);return calls<3?tool('coordination_read',{}):done;}),{},{promptVersion:'structured-v5'});
 const resumed=reopened.tasks.claim(ad)!;await runner.run(resumed);await runner.run(resumed);
 assert.equal(calls,3);assert.equal(reopened.tasks.get(ad,child.id).state,'completed');assert.equal(reopened.tasks.get(ad,parent.id).state,'queued');
 assert.equal(reopened.messages(ad,room.id).filter(m=>m.body==='確認できた範囲の結果です。').length,1);
 assert.ok(reopened.tasks.promptRuns(ad,child.id).some(p=>p.phase==='task_summary_save'));
});

test('unsuccessful recovery is bounded across resumes and reopening, with a meaningful retry time',async t=>{
 const {r,root,admin,child,parent,lease}=fixture(t);let calls=0;
 const run=(runtime:Runtime)=>new TurnRunner(runtime,async()=>adapter(()=>{calls++;return tool('coordination_read',{});}),{},{promptVersion:'structured-v5'});
 await run(r).run(lease);
 assert.equal(calls,4);let held=r.tasks.get(admin,child.id);
 assert.equal(r.tasks.promptRuns(admin,child.id).filter(p=>p.phase==='read_recovery').length,3);
 assert.equal(r.tasks.promptRuns(admin,child.id).filter(p=>p.phase==='read_recovery_report').length,1);
 assert.equal(held.state,'waiting_provider');assert.equal(r.tasks.progress(admin,child.id).kind,'stalled');
 assert.ok(held.provider_retry_at!>Date.now()+25*60_000);
 r.tasks.resume(admin,child.id);await run(r).run(r.tasks.claim(admin)!);assert.equal(calls,4);
 r.close();const reopened=new Runtime(root);t.after(()=>reopened.close());const ad=reopened.administrator();
 reopened.tasks.resume(ad,child.id);await run(reopened).run(reopened.tasks.claim(ad)!);assert.equal(calls,4);
 held=reopened.tasks.get(ad,child.id);reopened.tasks.retryProviders(ad,Date.now()+60_000);assert.equal(reopened.tasks.get(ad,child.id).state,'waiting_provider');
 assert.equal(reopened.tasks.get(ad,parent.id).state,'waiting_child');
 const db=new DatabaseSync(root+'/control.db');db.prepare('UPDATE task_observations SET created_at=? WHERE task_id=?').run(Date.now()-31*60_000,child.id);db.close();
 reopened.tasks.retryProviders(ad,held.provider_retry_at!+1);
 await new TurnRunner(reopened,async()=>adapter(()=>done),{},{promptVersion:'structured-v5'}).run(reopened.tasks.claim(ad)!);
 assert.equal(reopened.tasks.get(ad,child.id).state,'completed');
});

test('a different source can end recovery and continue the existing task without replaying a read',async t=>{
 const {r,admin,child,lease}=fixture(t);let calls=0,reads=0;
 const runner=new TurnRunner(r,async()=>adapter(request=>{
  calls++;const state=JSON.parse(request.messages.at(-1)!.content!).work_state;
  if(calls===1)return tool('web_read',{url:'https://example.com/new-source'});
  assert.equal(state.read_observations.repeated_reads,0);
  assert.equal(state.observations.at(-1).step,0);
  return done;
 }),{readPage:async()=>{reads++;return {url:'https://example.com/new-source',text:'新たに得た人工の根拠',content_type:'text/plain',truncated:false,fetched_at:new Date().toISOString(),untrusted:true};}},{promptVersion:'structured-v5'});
 await runner.run(lease);await runner.run(lease);
 assert.equal(r.tasks.get(admin,child.id).state,'completed');assert.equal(calls,2);assert.equal(reads,1);
});

test('recovery still respects global pause, individual pause and archived conversations',async t=>{
 const {r,admin,room,child,lease}=fixture(t);let calls=0;
 const runner=new TurnRunner(r,async()=>adapter(()=>{calls++;return done;}));
 r.tasks.wait(r.agentSession(child.agent_id),lease,'waiting_provider','人工の待機',true);r.tasks.waitKind(r.agentSession(child.agent_id),lease,'stalled');
 const due=r.tasks.get(admin,child.id).provider_retry_at!;
 r.updateSettings(admin,{paused:true});r.tasks.retryProviders(admin,due+1);assert.equal(r.tasks.claim(admin),undefined);
 r.updateSettings(admin,{paused:false});r.tasks.pause(admin,child.id);r.tasks.retryProviders(admin,due+1);assert.equal(r.tasks.claim(admin),undefined);
 r.tasks.resume(admin,child.id);r.organizeRoom(admin,room.id,{archived:true});r.tasks.retryProviders(admin,due+1);assert.equal(r.tasks.claim(admin),undefined);
 await runner.run(lease);assert.equal(calls,0);
 r.organizeRoom(admin,room.id,{archived:false});r.tasks.retryProviders(admin,due+1);await runner.run(r.tasks.claim(admin)!);assert.equal(calls,1);
});

test('interim reports keep the recovery budget and are not repeated while replaying saved steps',async t=>{
 const {r,admin,room,child,lease}=fixture(t);let calls=0;
 const runner=new TurnRunner(r,async()=>adapter(request=>{
  calls++;const state=JSON.parse(request.messages.at(-1)!.content!).work_state;
  return tool('task_report',{body:'人工の途中報告'+calls,next_action:'別の方法を確認する',expected_revision:state.remaining_plan.revision});
 }),{},{promptVersion:'structured-v5'});
 await runner.run(lease);
 for(let i=0;i<4;i++)await runner.run(r.tasks.claim(admin)!);
 assert.equal(calls,4);assert.equal(r.tasks.get(admin,child.id).state,'waiting_provider');
 assert.equal(r.tasks.promptRuns(admin,child.id).filter(p=>p.phase==='read_recovery_report').length,1);
 assert.equal(r.messages(admin,room.id).filter(m=>m.body.startsWith('人工の途中報告')).length,4);
});
