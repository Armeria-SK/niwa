// Bounded artificial review/fix acceptance; credentials are read-only, no external tools.
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const [compiled,credentialFile,modelFile,receiptFile]=process.argv.slice(2);
assert.ok(compiled&&credentialFile&&modelFile&&receiptFile,'Usage: node verify-quality-model.mjs STAGED_BUILD CREDENTIAL MODELS_JSON RECEIPT');
assert.ok(!resolve(compiled).startsWith('/home/niwa/niwa/dist'),'Use a staged build');
const load=p=>import(pathToFileURL(join(resolve(compiled),p+'.js')).href);
const {Runtime}=await load('runtime/runtime'),{TurnRunner}=await load('runtime/turns'),{executeTurnTool}=await load('runtime/turn-tools'),{FileCredentialStore}=await load('auth/credential-store'),{CodexConnection}=await load('providers/codex/connection');
const root=mkdtempSync('/tmp/niwa-quality-model-'),r=new Runtime(root),admin=r.administrator(),a=r.bootstrap(admin),aa=r.agentSession(a.id),b=r.createAgent(aa,'人工の確認担当'),room=r.createRoom(admin,'人工の出所照合');
const report={model:'gpt-5.6-sol',reasoning:'medium',calls:0,tools:[],result:'incomplete'};
try{
 for(const bot of [a,b])r.setAgentModel(admin,bot.id,'openai_subscription',report.model,report.reasoning);
 r.quality.enable(admin,true);r.tasks.create(admin,a.id,room.id,'人工資料の準備');const setup=r.tasks.claim(admin);
 r.quality.plan(aa,setup,0,{criteria:[{id:'source',kind:'source',condition:'対象期間・人数・確実性について主張と原文を照合し、未確認点を区別する'}],stop_condition:'具体的な不整合を解消したら終了。文体だけの修正往復は行わない。'});
 const source=r.post(admin,room.id,'人工調査の原文：この四半期に利用したのは10人。年間の需要および支払意思は調査していない。');
 executeTurnTool(r,aa,setup,{tool_call_id:'read',name:'history_read',arguments:{kind:'message',source_id:source.id,offset:0,revision:null}},'source');
 const id=r.createArtifact(aa,room.id,'人工需要調査','text','原文に基づく調査','年間の需要は100人で確認済み。支払意思も確定している。',setup.task.id),first=r.artifactVersions.inspect(aa,id);
 r.quality.record(aa,setup,{artifact_id:id,sha256:first.sha256,criterion:'source',reference:'source',method:'原文照合',claim:first.content,excerpt:'この四半期に利用したのは10人。年間の需要および支払意思は調査していない。',assessment:'supports',limits:'人工の資料だけを使用'});
 r.tasks.finish(aa,setup,'初稿');
 const file=new FileCredentialStore(credentialFile),connection=new CodexConnection({experimental_opt_in:true,credential_store:{read:()=>file.read(),write:async()=>{throw Error('Read-only credentials; refresh requires user action');},clear:async()=>{throw Error('Read-only credentials');}}});
 const model=JSON.parse(readFileSync(modelFile,'utf8')).find(m=>m.model_id===report.model);assert.ok(model);
 const allowed=new Set(['artifact_inspect','artifact_review','artifact_revise','artifact_evidence','history_read','task_plan_update','task_summary_save','work_note','memory_review']);
 const runner=new TurnRunner(r,async()=>{const adapter=connection.create({runtime:'gpt',provider_id:'openai_subscription',provider_model_id:model.model_id,supported_efforts:model.supported_efforts,context_window:model.context_window,max_output_tokens:4096,supports_tool_calls:true,supports_structured_output:false,supports_streaming:true,supports_session_resume:false,supports_parallel_sessions:false,supports_usage_reporting:true});return {...adapter,async *run(request,options){report.calls++;for await(const event of adapter.run({...request,tools:request.tools.filter(t=>allowed.has(t.name))},options)){if(event.type==='tool_call'){report.tools.push(event.name);console.log('Tool',event.name);}yield event;}}};});
 const run=async(bot,prompt)=>{const task=r.tasks.create(admin,bot.id,room.id,prompt),lease=r.tasks.claim(admin);assert.equal(lease.task.id,task.id);await runner.run(lease,AbortSignal.timeout(180000));assert.equal(r.tasks.get(admin,task.id).state,'completed');};
 await run(b,`人工の品質検査です。成果物 ${id} をartifact_inspectで読み、完成条件に沿って原文と照合してください。資料取得と内容の妥当性を区別し、artifact_reviewに具体的な判定とchecksを記録してください。別Botへの委任や外部操作は不要です。`);
 const reviewed=r.artifactVersions.inspect(admin,id);assert.ok(reviewed.reviews.some(x=>x.verdict==='changes_requested'),'Real reviewer must identify the seeded defect');report.initial_review=reviewed.reviews.map(x=>({verdict:x.verdict,note:x.note,checks:x.checks}));
 await run(a,`人工の品質修正です。成果物 ${id} の確認記録を読み、原文 ${source.id} をhistory_readで確認して、指摘された欠陥をartifact_reviseで修正してください。新しい版には現在の仕事でhistory_readが返すreceiptをreferenceとしてartifact_evidenceを登録し、主張・正確な抜粋・限界を記載してください。criterionはsourceです。原文は改変せず、旧版の証拠や承認を引き継いだと扱わないでください。自己レビューや外部操作は不要です。`);
 const latest=r.artifactVersions.inspect(admin,id).versions[0];assert.notEqual(latest.id,id);const revised=r.artifactVersions.inspect(admin,latest.id);assert.ok(revised.quality.evidence.some(e=>e.kind==='source'));assert.equal(revised.quality.verified,false);
 await run(b,`人工の修正後検査です。成果物 ${latest.id} を原文と完成条件に照合し、artifact_reviewで具体的なchecksと判定を記録してください。旧版の確認ではなく今回の版を確認し、文体だけの好みで往復を増やさないでください。`);
 const final=r.artifactVersions.inspect(admin,latest.id);assert.equal(final.quality.verified,true);report.revised_content=final.content;report.final_review=final.reviews.map(x=>({verdict:x.verdict,note:x.note,checks:x.checks}));report.result='PASS';
 console.log('PASS: real model found seeded source mismatch, author revised, fresh evidence reviewed; separate Bots using the same model, no detection-rate claim');
}finally{r.close();rmSync(root,{recursive:true,force:true});writeFileSync(receiptFile,JSON.stringify(report,null,2),{mode:0o600});}
