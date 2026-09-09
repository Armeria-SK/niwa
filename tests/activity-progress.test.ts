import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {Runtime} from '../src/runtime/runtime.ts';
import {OpenAISubscriptionAdapter,toSubscriptionRequest} from '../src/providers/codex/adapter.ts';
import {MemoryCredentialStore} from '../src/auth/credential-store.ts';
import {collectModelEvents} from '../src/providers/shared/adapter.ts';
import {credential,profile,request,frame} from './fixtures/model.ts';
function fixture(t:{after(fn:()=>void):void}){const root=mkdtempSync('/tmp/niwa-progress-'),r=new Runtime(root),admin=r.administrator(),a=r.bootstrap(admin),aa=r.agentSession(a.id),room=r.createRoom(admin,'人工の進捗');r.tasks.create(admin,a.id,room.id,'資料を確認して答える');const lease=r.tasks.claim(admin)!;t.after(()=>{r.close();rmSync(root,{recursive:true,force:true});});return {r,admin,a,aa,room,lease};}
test('runtime facts appear without work_note; internal budget differs from connection wait',t=>{
 const {r,admin,aa,room,lease}=fixture(t);const rev=r.context(aa,room.id).revision;
 r.tasks.activity(aa,lease,'call','model');assert.equal(r.workNotes(admin,room.id).length,0);assert.equal(r.tasks.progress(admin,lease.task.id).label,'返答を考え中');
 r.tasks.summary(aa,lease,'call',rev,'公開用の要約');assert.equal(r.tasks.progress(admin,lease.task.id).summary,'公開用の要約');
 r.tasks.wait(aa,lease,'waiting_provider','自由文',true);r.tasks.waitKind(aa,lease,'budget');const result=r.tasks.progress(admin,lease.task.id);assert.equal(result.label,'自発活動の利用枠待ち');assert.ok(result.retry_at);assert.equal(result.summary,null);
});
test('display is conversation-authorized and stopped calls cannot restore a summary',t=>{
 const {r,admin,a,aa,lease,room}=fixture(t),b=r.createAgent(aa,'別のBot'),privateRoom=r.createRoom(admin,'個別',[a.id]);r.tasks.create(admin,a.id,privateRoom.id,'私的確認');
 const privateTask=r.tasks.list(admin).at(-1)!;assert.throws(()=>r.tasks.progress(r.agentSession(b.id),privateTask.id));
 r.tasks.activity(aa,lease,'old','model');const revision=r.context(aa,room.id).revision;r.tasks.pause(admin,lease.task.id);r.tasks.summary(aa,lease,'old',revision,'遅れた要約');assert.equal(r.tasks.progress(admin,lease.task.id).summary,null);
});
test('window detects alternating rereads but permits new pages and changed versions',t=>{
 const {r,aa,lease}=fixture(t);
 for(let i=0;i<9;i++)r.tasks.observe(aa,lease,String(i),'task_history_read',{step:i%2,offset:0},{revision:'a',text:'同じ観測'});
 assert.ok(r.tasks.observations(aa,lease).repeated_reads>=3);
 r.tasks.observe(aa,lease,'new','task_history_read',{step:0,offset:20000},{revision:'a',text:'新しいページ'});assert.equal(r.tasks.observations(aa,lease).repeated_reads,0);
 r.tasks.observe(aa,lease,'version','web_read',{url:'https://example.test'},{revision:'b',text:'更新'});assert.equal(r.tasks.observations(aa,lease).repeated_reads,0);
});
test('history read contains references instead of recursively copied history pages',t=>{
 const {r,aa,lease,room}=fixture(t),revision=r.context(aa,room.id).revision;
 const step=r.tasks.saveStep(aa,lease,revision,[{type:'tool_call',tool_call_id:'h',name:'task_history_read',arguments:{step:0,offset:0,revision:null}},{type:'completed',finish_reason:'tool_calls'}]);
 r.tasks.observe(aa,lease,`${step}:0`,'task_history_read',{step:0,offset:0},{text:'recursive-body-must-not-be-stored',revision:'a'});
 const output=r.tasks.readStep(aa,lease,step);assert.ok(String(output.text).includes('history_reference'));assert.ok(!JSON.stringify(output).includes('recursive-body-must-not-be-stored'));
});
test('subscription delivers a provided summary before terminal, while tool execution still awaits validation',async()=>{
 const store=new MemoryCredentialStore();await store.write(credential);let controller!:ReadableStreamDefaultController<Uint8Array>;
 const adapter=new OpenAISubscriptionAdapter({model_profile:profile,experimental_opt_in:true,credential_store:store,fetch:async()=>new Response(new ReadableStream({start(c){controller=c;}}),{headers:{'content-type':'text/event-stream'}})});
 const observed:string[]=[];let finished=false;
 const result=collectModelEvents(adapter.run(request,{timeout_ms:3000}),{on_summary:text=>{if(text)observed.push(text);}}).then(value=>{finished=true;return value;});
 while(!controller)await new Promise(r=>setTimeout(r,1));
 controller.enqueue(new TextEncoder().encode(frame({type:'response.reasoning_summary_text.delta',delta:'公開の根拠を確認しています。'})+frame({type:'response.reasoning_summary_text.done'})));
 await new Promise(r=>setTimeout(r,30));assert.equal(finished,false);assert.deepEqual(observed,['公開の根拠を確認しています。']);
 controller.enqueue(new TextEncoder().encode(frame({type:'response.completed',response:{output:[]}})));controller.close();assert.ok((await result).some(e=>e.type==='completed'));
});
test('split summary secrets are joined before display redaction and unsupported summary request stays off',async()=>{
 const snapshots:string[]=[];
 async function* source(){yield {type:'reasoning_summary' as const,summary:'確認 sk-'};yield {type:'reasoning_summary' as const,summary:'abcdefghijklmno を確認。'};yield {type:'completed' as const,finish_reason:'stop' as const};}
 await collectModelEvents(source(),{on_summary:s=>snapshots.push(s)});assert.ok(!snapshots.some(s=>s.includes('abcdefghijklmno')));assert.ok(snapshots.at(-1)?.includes('[REDACTED]'));
 assert.equal((toSubscriptionRequest({...request,reasoning_effort:'medium'},'test').reasoning as {summary?:string}).summary,undefined);
 assert.equal((toSubscriptionRequest({...request,reasoning_effort:'medium'},'test',undefined,'auto').reasoning as {summary?:string}).summary,'auto');
});
test('interrupted and malformed streams remain failures after provisional display',async()=>{
 for(const kind of ['failed','missing-terminal'] as const){let observed='';async function* source(){yield {type:'reasoning_summary' as const,summary:'照合を開始しました。'};if(kind==='failed')yield {type:'failed' as const,error:{code:'NETWORK_ERROR' as const,message:'interrupted',retryable:true}};}
 const events=await collectModelEvents(source(),{on_summary:s=>observed=s});assert.ok(observed);assert.ok(events.some(e=>e.type==='failed'));assert.ok(!events.some(e=>e.type==='completed'));
 }
});
test('old call ids and corrected memory cannot restore display content',t=>{
 const {r,aa,admin,room,lease}=fixture(t),revision=r.context(aa,room.id).revision;
 r.tasks.activity(aa,lease,'old','model');r.tasks.activity(aa,lease,'new','model');r.tasks.summary(aa,lease,'old',revision,'遅延');assert.equal(r.tasks.progress(admin,lease.task.id).summary,null);
 r.tasks.summary(aa,lease,'new',revision+1,'別の文脈');assert.equal(r.tasks.progress(admin,lease.task.id).summary,null);
});
test('read observations ignore retrieval clock but preserve changed content; history indirection cannot evade recovery',t=>{
 const {r,aa,lease}=fixture(t);
 for(let i=0;i<6;i++)r.tasks.observe(aa,lease,'clock'+i,'web_read',{url:'https://example.com'},{text:'同じ内容',fetched_at:String(i)});
 assert.ok(r.tasks.observations(aa,lease).repeated_reads>=3);
 r.tasks.observe(aa,lease,'changed','web_read',{url:'https://example.com'},{text:'内容更新',fetched_at:'7'});assert.equal(r.tasks.observations(aa,lease).repeated_reads,0);
 for(let i=0;i<6;i++)r.tasks.observe(aa,lease,'indirect'+i,'task_history_read',{step:i,offset:0},{history_indirection:true,text:'参照'+i});assert.ok(r.tasks.observations(aa,lease).repeated_reads>=3);
});
test('correction and deletion invalidate display and observation cache without reviving old callbacks',t=>{
 const {r,aa,admin,a,room,lease}=fixture(t);const msg=r.post(admin,room.id,'人工の旧情報'),memory=r.remember(aa,msg.id,'旧情報'),rev=r.context(aa,room.id).revision;
 r.tasks.activity(aa,lease,'call','model');r.tasks.summary(aa,lease,'call',rev,'旧情報の要約');r.tasks.observe(aa,lease,'read','workspace_read',{path:'draft'},{content:'旧情報'});
 r.correctMemory(admin,a.id,memory.id,1,'訂正情報');r.tasks.summary(aa,lease,'call',rev,'遅い旧情報');assert.equal(r.tasks.progress(admin,lease.task.id).summary,null);assert.deepEqual(r.tasks.observations(aa,lease).recent,[]);
 r.deleteMemory(admin,a.id,memory.id,2);assert.equal(r.tasks.progress(admin,lease.task.id).summary,null);
});
test('quoted secrets spanning whitespace and multiple summary events remain hidden',async()=>{
 const snapshots:string[]=[];async function* source(){for(const summary of ['確認 api_key="alpha secret ', 'second fragment ', 'last" を照合。'])yield {type:'reasoning_summary' as const,summary};yield {type:'completed' as const,finish_reason:'stop' as const};}
 await collectModelEvents(source(),{on_summary:s=>snapshots.push(s)});for(const text of snapshots)assert.ok(!/alpha|secret|second|fragment|last/.test(text));
});
test('collector forwards provided summary to runtime before a slow model completes and keeps it out of saved steps',async t=>{
 const {TurnRunner}=await import('../src/runtime/turns.ts');const {openAISubscriptionAdapterCapabilities}=await import('../src/providers/codex/adapter.ts');
 const {r,admin,aa,lease}=fixture(t);let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);
 const runner=new TurnRunner(r,async()=>({adapter_id:'artificial',capabilities:openAISubscriptionAdapterCapabilities,async *run(){yield {type:'reasoning_summary' as const,summary:'公開資料の対象を照合しています。'};await gate;yield {type:'text_delta' as const,text:'確認できた範囲を報告します。'};yield {type:'completed' as const,finish_reason:'stop' as const};}}));
 const running=runner.run(lease);try{for(let i=0;i<100&&!r.tasks.progress(admin,lease.task.id).summary;i++)await new Promise(resolve=>setTimeout(resolve,2));assert.equal(r.tasks.get(admin,lease.task.id).state,'running');assert.match(r.tasks.progress(admin,lease.task.id).summary??'',/照合/);}finally{release();await running;}
 assert.equal(r.tasks.get(admin,lease.task.id).state,'completed');assert.ok(!JSON.stringify(r.tasks.steps(aa,lease.task.id)).includes('reasoning_summary'));assert.equal(r.tasks.progress(admin,lease.task.id).summary,null);
});
test('deleted rooms reject late display events and do not expose progress to another room',t=>{
 const {r,aa,admin,room,lease}=fixture(t),revision=r.context(aa,room.id).revision;r.tasks.activity(aa,lease,'call','model');r.tasks.summary(aa,lease,'call',revision,'削除予定');r.deleteContent(admin,'room',room.id);
 r.tasks.summary(aa,lease,'call',revision,'遅延');assert.throws(()=>r.tasks.progress(admin,lease.task.id),/deleted/i);
});
