import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';
import {Runtime} from '../src/runtime/runtime.ts';import {TurnRunner} from '../src/runtime/turns.ts';import {isStatusInquiry} from '../src/runtime/conversation-work.ts';
import {OpenAISubscriptionAdapter,openAISubscriptionAdapterCapabilities} from '../src/providers/codex/adapter.ts';import {MemoryCredentialStore} from '../src/auth/credential-store.ts';
import {credential,profile,request,response} from './fixtures/model.ts';
function fixture(t:{after(fn:()=>void):void}){const root=mkdtempSync('/tmp/niwa-thinking-'),r=new Runtime(root),admin=r.administrator(),a=r.bootstrap(admin),aa=r.agentSession(a.id),room=r.createRoom(admin,'人工会話');t.after(()=>{r.close();rmSync(root,{recursive:true,force:true});});return {root,r,admin,a,aa,room};}
test('natural status grammar accepts colloquial inquiry but never consumes appended commands',()=>{
 for(const s of ['反応なくね？','今誰かに仕事投げてる？','反応がない','返事なくない？','現在誰が担当しているの？','誰かに依頼してる？','今誰に仕事を投げてる？','進捗を教えて','状況は？','今どうなってる？'])assert.equal(isStatusInquiry(s),true,s);
 for(const s of ['誰が担当している？ その仕事を止めて','進捗を確認して、この条件も追加して','「進捗を教えて」と伝えて','反応がないサイトを調査して','今誰かに仕事投げてるなら止めて','進捗資料を作成して','誰が担当しているか調べて別のBotへ依頼して'])assert.equal(isStatusInquiry(s),false,s);
});
test('response spans remain stable across calls, bind exact reply, and restart after report creates new span',t=>{
 const {r,admin,a,aa,room}=fixture(t);const input=r.submit(admin,crypto.randomUUID(),room.id,'資料を調べて',a.id),lease=r.tasks.claim(admin)!;
 r.tasks.activity(aa,lease,'1','model');const rev=r.context(aa,room.id).revision;r.tasks.summary(aa,lease,'1',rev,'人工資料を比較しています。');const first=r.tasks.responseProgress(admin,room.id)[0]!;
 assert.equal(first.anchor_id,input.message.id);r.tasks.activity(aa,lease,'2','read');assert.equal(r.tasks.responseProgress(admin,room.id)[0]!.id,first.id);
 r.tasks.summary(aa,lease,'2',rev,'照合を終えました。');r.reportAndContinue(aa,lease,'途中報告','検証する',0,'report');const closed=r.tasks.responseProgress(admin,room.id)[0]!;assert.ok(closed.finished_at);assert.equal(closed.summary,'照合を終えました。');assert.ok(closed.reply_id);
 const next=r.tasks.claim(admin)!;r.tasks.activity(aa,next,'3','model');const second=r.tasks.responseProgress(admin,room.id)[0]!;assert.notEqual(second.id,first.id);assert.equal(second.anchor_id,closed.reply_id);
 r.tasks.summary(aa,lease,'1',rev,'遅延した古い出力');assert.equal(r.tasks.responseProgress(admin,room.id)[0]!.summary,null);
 r.respond(aa,next,'検証完了',[]);assert.equal(r.tasks.responseProgress(admin,room.id).length,2);
});
test('paused and private response displays remain protected',t=>{
 const {r,admin,a,aa,room}=fixture(t),b=r.createAgent(aa,'別Bot'),privateRoom=r.createRoom(admin,'個別',[a.id]);
 r.tasks.create(admin,a.id,privateRoom.id,'人工の私的作業');const lease=r.tasks.claim(admin)!;r.tasks.activity(aa,lease,'1','model');r.tasks.summary(aa,lease,'1',r.context(aa,privateRoom.id).revision,'私的な人工要約');
 assert.throws(()=>r.tasks.responseProgress(r.agentSession(b.id),privateRoom.id));assert.equal(r.tasks.responseProgress(admin,room.id).length,0);
 r.tasks.pause(admin,lease.task.id);assert.equal(r.tasks.responseProgress(admin,privateRoom.id)[0]!.summary,null);assert.equal(r.tasks.responseProgress(admin,privateRoom.id)[0]!.kind,'paused');
});
test('normal request retries transient failures with backoff, retaining task and respecting pause/cancel/deadline',t=>{
 const {r,admin,a,aa,room}=fixture(t);const task=r.tasks.create(admin,a.id,room.id,'人工依頼'),lease=r.tasks.claim(admin)!;
 r.tasks.providerFailure(aa,lease,{code:'PROVIDER_UNAVAILABLE',message:'503',retryable:true});const due=r.tasks.get(admin,task.id).provider_retry_at!;assert.ok(due>Date.now());assert.equal(r.tasks.progress(admin,task.id).kind,'network');
 r.tasks.pause(admin,task.id);r.tasks.retryProviders(admin,due+1);assert.equal(r.tasks.get(admin,task.id).state,'waiting_provider');r.tasks.resume(admin,task.id);r.tasks.retryProviders(admin,due+1);const second=r.tasks.claim(admin)!;assert.equal(second.task.id,task.id);
 r.tasks.providerFailure(aa,second,{code:'NETWORK_ERROR',message:'network',retryable:true});assert.ok(r.tasks.get(admin,task.id).provider_retry_at!>=Date.now()+119000);r.tasks.cancel(admin,task.id);r.tasks.retryProviders(admin,Date.now()+9999999);assert.equal(r.tasks.get(admin,task.id).state,'cancelled');
 const short=r.tasks.create(admin,a.id,room.id,'期限',Date.now()+1000),sl=r.tasks.claim(admin)!;r.tasks.providerFailure(aa,sl,{code:'TIMED_OUT',message:'timeout',retryable:true});r.tasks.retryProviders(admin,Date.now()+120000);assert.notEqual(r.tasks.get(admin,short.id).state,'queued');
});
test('authentication and invalid requests do not retry even for autonomous work',t=>{
 const {r,admin,a,aa,room}=fixture(t);for(const code of ['AUTHENTICATION_FAILED','PERMISSION_DENIED','INVALID_REQUEST'] as const){const task=r.tasks.create(admin,a.id,room.id,'人工依頼'),lease=r.tasks.claim(admin)!;r.tasks.providerFailure(aa,lease,{code,message:'unavailable',retryable:true});assert.equal(r.tasks.get(admin,task.id).provider_retry_at,null);r.tasks.cancel(admin,task.id);}
});
test('503 adapter failure leads normal TurnRunner back to same task and one final reply',async t=>{
 const {r,admin,a,aa,room}=fixture(t);const task=r.tasks.create(admin,a.id,room.id,'計算結果を返す');let unavailable=true;
 const runner=new TurnRunner(r,async()=>({adapter_id:'artificial',capabilities:openAISubscriptionAdapterCapabilities,async *run(){if(unavailable){yield {type:'failed' as const,error:{code:'PROVIDER_UNAVAILABLE' as const,message:'503',retryable:true}};}else{yield {type:'text_delta' as const,text:'結果は5です。'};yield {type:'completed' as const,finish_reason:'stop' as const};}}}));
 await runner.run(r.tasks.claim(admin)!);const retry=r.tasks.get(admin,task.id).provider_retry_at!;assert.ok(retry);unavailable=false;r.tasks.retryProviders(admin,retry+1);const resumed=r.tasks.claim(admin)!;assert.equal(resumed.task.id,task.id);await runner.run(resumed);assert.equal(r.tasks.get(admin,task.id).state,'completed');assert.equal(r.messages(admin,room.id).length,1);
});
test('summary option fallback only retries a specific rejected parameter; 503 retains retry-after',async()=>{
 const store=new MemoryCredentialStore();await store.write(credential);let calls=0;const bodies:any[]=[];
 const adapter=new OpenAISubscriptionAdapter({model_profile:profile,experimental_opt_in:true,reasoning_summary:'auto',credential_store:store,fetch:async(_url,init)=>{bodies.push(JSON.parse(String(init?.body)));calls++;return calls===1?new Response(JSON.stringify({error:{param:'reasoning.summary',code:'unsupported_parameter'}}),{status:400}):response();}});
 const result=await adapter.runDetailed(request,{timeout_ms:1000});assert.ok(result.events.some(e=>e.type==='completed'));assert.equal(calls,2);assert.equal(bodies[0].reasoning.summary,'auto');assert.equal(bodies[1].reasoning.summary,undefined);
 for(const status of [400,503]){let count=0;const a=new OpenAISubscriptionAdapter({model_profile:profile,experimental_opt_in:true,reasoning_summary:'auto',credential_store:store,fetch:async()=>{count++;return new Response('{"error":{"param":"input","code":"invalid_request"}}',{status,headers:{'retry-after':'300'}});}});const r=await a.runDetailed(request,{timeout_ms:1000});assert.equal(count,1);const e=r.events.find(e=>e.type==='failed')!;assert.equal(e.type,'failed');if(status===503){assert.equal(e.error.retryable,true);assert.ok(e.error.reset_at!>=Date.now()/1000+298);}}
});
test('legacy 5xx repair is narrow, keeps parent relation and survives reopen without duplicating work',()=>{
 const root=mkdtempSync('/tmp/niwa-legacy-retry-');let r=new Runtime(root);
 try{let admin=r.administrator();const a=r.bootstrap(admin),aa=r.agentSession(a.id),b=r.createAgent(aa,'人工の子'),room=r.createRoom(admin,'復帰試験');const parent=r.tasks.create(admin,a.id,room.id,'親の依頼'),p=r.tasks.claim(admin)!,child=r.tasks.delegate(aa,p,b.id,'子の仕事'),lease=r.tasks.claim(admin)!,ba=r.agentSession(b.id);
 const id=r.tasks.recordPrompt(ba,lease,{version:'structured-v5',phase:'work',rules_revision:0,memory_revision:0,input_bytes:10,estimated_input_tokens:3,removed_messages:0});r.tasks.finishPrompt(ba,lease,id,[{type:'failed',error:{code:'PROVIDER_UNAVAILABLE',message:'503',retryable:true}}]);r.tasks.wait(ba,lease,'waiting_provider','モデル応答を完了できませんでした (PROVIDER_UNAVAILABLE)。');
 const unknown=r.tasks.create(admin,a.id,room.id,'理由不明');r.tasks.wait(aa,r.tasks.claim(admin)!,'waiting_provider','理由不明');
 assert.deepEqual(r.tasks.recoverProviderWaits(admin),[child.id]);assert.equal(r.tasks.get(admin,child.id).provider_retry_at,null);r.tasks.recoverProviderWaits(admin,true);assert.deepEqual(r.tasks.recoverProviderWaits(admin),[]);const due=r.tasks.get(admin,child.id).provider_retry_at!;
 r.close();r=new Runtime(root);admin=r.administrator();r.tasks.recover(admin);r.tasks.retryProviders(admin,due+1);const next=r.tasks.claim(admin)!;assert.equal(next.task.id,child.id);assert.equal(next.task.parent_id,parent.id);assert.equal(r.tasks.get(admin,parent.id).state,'waiting_child');assert.equal(r.tasks.get(admin,unknown.id).state,'waiting_provider');assert.equal(r.tasks.list(admin).length,3);
 }finally{r.close();rmSync(root,{recursive:true,force:true});}
});
test('concurrent bot responses and old work resume keep separate anchors; correction discards displays',t=>{
 const {r,admin,a,aa,room}=fixture(t),b=r.createAgent(aa,'第二Bot'),ba=r.agentSession(b.id);
 const first=r.submit(admin,crypto.randomUUID(),room.id,'第一依頼',a.id),la=r.tasks.claim(admin)!;r.tasks.activity(aa,la,'a','model');
 const second=r.submit(admin,crypto.randomUUID(),room.id,'別依頼',b.id),lb=r.tasks.claim(admin)!;r.tasks.activity(ba,lb,'b','model');
 r.tasks.summary(aa,la,'a',r.context(aa,room.id).revision,'第一の要約');r.tasks.summary(ba,lb,'b',r.context(ba,room.id).revision,'第二の要約');
 const spans=r.tasks.responseProgress(admin,room.id);assert.equal(spans.length,2);assert.equal(spans.find(p=>p.agent_id===a.id)!.anchor_id,first.message.id);assert.equal(spans.find(p=>p.agent_id===b.id)!.anchor_id,second.message.id);
 r.tasks.wait(aa,la,'waiting_provider','人工通信',true);r.respond(ba,lb,'第二の回答',[]);r.tasks.retryProviders(admin,Date.now()+61000);const again=r.tasks.claim(admin)!;r.tasks.activity(aa,again,'new','model');assert.equal(r.tasks.responseProgress(admin,room.id).find(p=>p.agent_id===a.id)!.anchor_id,first.message.id);
 r.updateCommonRules(admin,r.commonRules(admin).revision,'人工の訂正指示');assert.equal(r.tasks.responseProgress(admin,room.id).length,0);
});
