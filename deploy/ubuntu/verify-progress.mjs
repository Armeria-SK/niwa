// Artificial deterministic recovery comparison. Never opens production state or a model connection.
import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';import {pathToFileURL} from 'node:url';import {join} from 'node:path';import {setTimeout as delay} from 'node:timers/promises';
const [before,after,receipt]=process.argv.slice(2);assert.ok(before&&after&&receipt);
async function run(compiled){const load=p=>import(pathToFileURL(join(compiled,p+'.js')).href),{Runtime}=await load('runtime/runtime'),{TurnRunner}=await load('runtime/turns'),{openAISubscriptionAdapterCapabilities}=await load('providers/codex/adapter');const root=mkdtempSync('/tmp/niwa-recovery-'),r=new Runtime(root),admin=r.administrator(),a=r.bootstrap(admin),actor=r.agentSession(a.id),room=r.createRoom(admin,'人工の履歴巡回');r.tasks.create(admin,a.id,room.id,'公開資料の取得失敗を調べ、分かった範囲と未確認点を返す');const lease=r.tasks.claim(admin),started=Date.now(),report={model_calls:0,history_reads:0,failures:0,tool_ms:0,first_progress_ms:null,first_model_event_ms:null,model_ms:0,answer_ms:null};let step=0;const abort=new AbortController();
try{const runner=new TurnRunner(r,async()=>({adapter_id:'synthetic',capabilities:openAISubscriptionAdapterCapabilities,async *run(request){report.model_calls++;const modelStarted=Date.now();if(report.first_progress_ms===null&&r.tasks.progress)report.first_progress_ms=Date.now()-started;await delay(5);report.first_model_event_ms??=Date.now()-started;const state=JSON.parse(request.messages.at(-1).content).work_state;let name,args;
if(request.tools.length===1&&request.tools[0].name==='memory_review'){name='memory_review';args={memories:[]};}
else if(request.tools.length===1&&request.tools[0].name==='task_summary_save'){name='task_summary_save';args={conclusion:'取得失敗のため内容は未確認',reason:'観測の再利用',unresolved:['原資料'],next_steps:['別の情報源を確認する'],sources:state.summary_sources.slice(0,1).map(({kind,source_id,revision})=>({kind,source_id,revision}))};}
else if(state.read_observations?.recovery){yield {type:'text_delta',text:'取得が失敗したため原資料の内容は未確認です。別の情報源で確認する必要があります。'};yield {type:'completed',finish_reason:'stop'};report.model_ms+=Date.now()-modelStarted;return;}
else if(step<2){name='web_read';args={url:'https://example.test/'+step++};}
else {name='task_history_read';args={step:1+(step++%2),offset:0,revision:null};report.history_reads++;}
if(report.model_calls>16){abort.abort();return;}
yield {type:'tool_call',tool_call_id:String(report.model_calls),name,arguments:args};yield {type:'completed',finish_reason:'tool_calls'};report.model_ms+=Date.now()-modelStarted;
}}),{readPage:async()=>{const time=Date.now();await delay(2);report.tool_ms+=Date.now()-time;report.failures++;throw Object.assign(Error('artificial'),{code:'ECONNREFUSED'});}},{promptVersion:'structured-v5'});
await runner.run(lease,abort.signal);report.state=r.tasks.get(admin,lease.task.id).state;if(report.state==='completed')report.answer_ms=Date.now()-started;return report;
}finally{r.close();rmSync(root,{recursive:true,force:true});}}
async function inquiry(compiled){
 const load=p=>import(pathToFileURL(join(compiled,p+'.js')).href),{Runtime}=await load('runtime/runtime'),{TurnRunner}=await load('runtime/turns'),{openAISubscriptionAdapterCapabilities}=await load('providers/codex/adapter');
 const root=mkdtempSync('/tmp/niwa-inquiry-'),r=new Runtime(root),admin=r.administrator(),a=r.bootstrap(admin),actor=r.agentSession(a.id),b=r.createAgent(actor,'人工担当'),room=r.createRoom(admin,'人工の照会');let model_calls=0;
 try {const parent=r.tasks.create(admin,a.id,room.id,'元の制作'),lease=r.tasks.claim(admin),child=r.tasks.delegate(actor,lease,b.id,'資料を照合');r.tasks.claim(admin);const started=Date.now();const request=r.submit(admin,randomUUID(),room.id,'今誰が担当しているか？',a.id);
 if(request.task.state!=='completed')await new TurnRunner(r,async()=>({adapter_id:'artificial',capabilities:openAISubscriptionAdapterCapabilities,async *run(){model_calls++;await delay(5);yield {type:'text_delta',text:'INVALID_MEMORY_FORMAT'};yield {type:'completed',finish_reason:'stop'};}})).run(r.tasks.claim(admin));
 const task=r.tasks.get(admin,request.task.id),elapsed=Date.now()-started;
 return {state:task.state,model_calls,first_response_ms:task.state==='completed'?elapsed:null,final_response_ms:task.state==='completed'?elapsed:null,parent_state:r.tasks.get(admin,parent.id).state,child_state:r.tasks.get(admin,child.id).state};
 }finally{r.close();rmSync(root,{recursive:true,force:true});}
}
const result={fixture:'two failed reads followed by alternating history pages; artificial adapter reacts to recovery context',before:await run(before),after:await run(after),inquiry:{before:await inquiry(before),after:await inquiry(after)}};assert.equal(result.after.state,'completed');assert.ok(result.after.history_reads<result.before.history_reads);writeFileSync(receipt,JSON.stringify(result,null,2));console.log(JSON.stringify(result));
