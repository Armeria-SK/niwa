import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {Runtime} from '../src/runtime/runtime.ts';
import {WorkareaStore} from '../src/tools/workareas/store.ts';
import {EnvironmentRegistry} from '../src/tools/environments/registry.ts';
import {PackageCatalog} from '../src/tools/packages/catalog.ts';
import {executeTurnTool} from '../src/runtime/turn-tools.ts';
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
function setup(t:{after(fn:()=>void):void}){
 const root=mkdtempSync(join(tmpdir(),'niwa-quality-')),r=new Runtime(root+'/state'),admin=r.administrator(),a=r.bootstrap(admin),aa=r.agentSession(a.id),b=r.createAgent(aa,'確認担当'),ba=r.agentSession(b.id),room=r.createRoom(admin,'人工の品質確認');
 r.quality.enable(admin,true);r.workareas.enable(admin,true);r.tasks.create(admin,a.id,room.id,'制作');const lease=r.tasks.claim(admin)!;
 const db=new DatabaseSync(root+'/state/control.db');t.after(()=>{db.close();r.close();rmSync(root,{recursive:true,force:true});});return {root,r,admin,a,aa,b,ba,room,lease,db};
}
const plan=(kind:'source'|'execution'|'review')=>({criteria:[{id:'check',condition:'説明と根拠を照合し不整合を修正する',kind}],stop_condition:'具体的な欠陥がなければ終了。解消不能は限界を残す'});
const reviews=[{criterion:'check',verdict:'pass' as const,note:'固定された対象の内容と保存された検査結果を照合しました。'}];
function record(f:ReturnType<typeof setup>,id:string,reference:string,assessment:'supports'|'contradicts'|'uncertain'='supports',excerpt=''){
 return f.r.quality.record(f.aa,f.lease,{artifact_id:id,sha256:f.r.artifactVersions.inspect(f.aa,id).sha256,criterion:'check',reference,method:'人工fixtureとの照合',claim:'対象の挙動を確認',excerpt,assessment,limits:'人工データだけの検査'});
}
test('important artifacts require fixed evidence and concrete review, while ordinary text stays lightweight',t=>{
 const f=setup(t),{r,aa,ba,admin,room,lease}=f;r.quality.plan(aa,lease,0,plan('execution'));const id=r.createArtifact(aa,room.id,'動かないコード','text','テスト成功と自己申告','raise Exception()',lease.task.id),hash=sha('raise Exception()');
 assert.equal(record(f,id,'I said tests passed').result,'not_executed');assert.throws(()=>r.reviewReady(aa,lease,id,hash));assert.throws(()=>r.artifactVersions.review(ba,id,hash,'approved','すべてのテストが成功しました。',reviews));
 assert.throws(()=>r.artifactVersions.review(ba,id,hash,'changes_requested','確認しました',reviews));
 r.artifactVersions.review(ba,id,hash,'changes_requested','起動時に必ず例外を送出するコードなので修正が必要です。',[{...reviews[0]!,verdict:'fail'}]);assert.throws(()=>r.artifactVersions.freeze(aa,id,hash));
 assert.throws(()=>r.quality.plan(aa,lease,1,plan('review')));r.tasks.finish(aa,lease,'未検証を残した');
 r.tasks.create(admin,lease.task.agent_id,room.id,'短い挨拶');const light=r.tasks.claim(admin)!;const small=r.createArtifact(aa,room.id,'軽いメモ','text','低影響','こんにちは',light.task.id);assert.equal(r.artifactVersions.inspect(aa,small).quality,null);
});
test('retrieval, content contradiction, source correction/deletion and private evidence are distinct',t=>{
 const f=setup(t),{r,aa,ba,admin,room,lease,db,root}=f;r.quality.plan(aa,lease,0,plan('source'));
 const source=r.post(admin,room.id,'調査対象は四半期の利用者10人。年間の需要は未確認。');
 const call={tool_call_id:'read',name:'history_read',arguments:{kind:'message',source_id:source.id,offset:0,revision:null}};executeTurnTool(r,aa,lease,call,'source');
 const id=r.createArtifact(aa,room.id,'出典と不一致','text','需要調査','年間の需要は100人で確定した。',lease.task.id);
 assert.equal(record(f,id,'source','contradicts','四半期の利用者10人').result,'retrieved');assert.throws(()=>r.artifactVersions.review(ba,id,sha('年間の需要は100人で確定した。'),'approved','取得できたため正しいと判断しました。',reviews));
 r.artifactVersions.review(ba,id,sha('年間の需要は100人で確定した。'),'changes_requested','原文は四半期10人であり年間100人を根拠付けていません。',[{...reviews[0]!,verdict:'fail'}]);
 db.prepare('UPDATE messages SET body=? WHERE id=?').run('訂正：利用者は8人',source.id);assert.throws(()=>r.artifact(ba,id));assert.ok(!r.searchHistory(ba,room.id,'年間').some(x=>x.source_id===id));
 assert.ok('error' in executeTurnTool(r,aa,lease,call,'source'));
 const reopen=new Runtime(root+'/state');try{assert.throws(()=>reopen.artifact(reopen.administrator(),id));}finally{reopen.close();}
 db.prepare('DELETE FROM messages WHERE id=?').run(source.id);assert.throws(()=>r.artifactVersions.inspect(admin,id));
});
test('execution service snapshots bind exact target files; failed code and changed files do not pass',async t=>{
 const f=setup(t),{r,aa,ba,admin,room,lease,root,a,b}=f;r.quality.plan(aa,lease,0,plan('execution'));
 mkdirSync(root+'/catalog',{mode:0o700});writeFileSync(root+'/catalog/catalog.json','[]',{mode:0o600});mkdirSync(root+'/files');const catalog=new PackageCatalog(root+'/catalog'),base='sha256:'+'a'.repeat(64),registry=new EnvironmentRegistry(root+'/environment.db',base,catalog,async()=>{throw Error('unused');},async()=>true);
 let code=1,mutate=false,revert=false;const store=new WorkareaStore(root+'/files',async(path)=>{if(mutate)writeFileSync(join(path,'main.py'),'changed during inspection');if(revert)writeFileSync(join(path,'main.py'),'print(2+3)');return {code,stdout:'tests passed (untrusted stdout)',stderr:''};},async()=>{},registry);t.after(()=>{store.close();registry.close();});
 const transport=(input:Parameters<typeof store.execute>[0])=>store.execute(input),area=(await r.workareas.project(admin,{name:'人工案件',room_id:room.id,members:[a.id,b.id]})).id;r.workareas.select(aa,lease,area);
 await r.workareas.execute(aa,area,{operation:'write',path:'main.py',content:'print(2+3)',expected_revision:null,operation_id:randomUUID(),allow_start:true},transport,lease);
 const published=await r.workareas.share(aa,lease,area,'main.py',sha('print(2+3)'),transport,randomUUID(),true);const file=String(published.artifact_id);
 const manifest=r.quality.manifest(aa,lease,'対象ファイル',[{path:'main.py',id:file,sha256:sha('print(2+3)')}]);
 const definition={name:'固定試験環境',base_image:base,catalog_revision:catalog.revision,dependencies:[],lockfiles:[],workdir:'/workspace' as const,prepare:[],run:['python','main.py'],verify:['python','main.py'],profile:'standard'};
 const version=await r.workareas.execute(aa,area,{operation:'environment_prepare',definition,allow_start:true},transport,lease);
 const run=async(op:string)=>r.tasks.externalOnce(aa,lease,op,{name:'environment_test'},id=>r.workareas.execute(aa,area,{operation:'environment_test',environment:String(version.id),operation_id:id,allow_start:true,seconds:30},transport,lease));
 await run('failed');assert.equal(record(f,manifest.id,'failed').result,'failed');assert.throws(()=>r.quality.ready(aa,manifest.id));
 code=0;await run('passed');assert.equal(record(f,manifest.id,'passed').result,'passed');r.quality.ready(ba,manifest.id);
 r.artifactVersions.review(ba,manifest.id,manifest.sha256,'approved','対象ファイルと固定環境の成功結果を照合し、条件を満たしました。',reviews);
 // A different fixed file is a new target and inherits conditions, never the old approval.
 const changed=r.artifactVersions.revise(aa,file,sha('print(2+3)'),'print(2+4)',lease.task.id);const next=r.quality.manifest(aa,lease,'対象ファイル',[{path:'main.py',id:changed.id,sha256:changed.sha256}],manifest.id);
 assert.equal(record(f,next.id,'passed').result,'wrong_version');assert.throws(()=>r.artifactVersions.freeze(aa,next.id,next.sha256));
 mutate=true;revert=true;await run('reverted');assert.equal(record(f,manifest.id,'reverted').result,'wrong_version');revert=false;await run('mutated');assert.equal(record(f,next.id,'mutated').result,'wrong_version');
 // Revoking the reviewer's project access also revokes saved evidence and dependent artifacts.
 await r.workareas.project(admin,{id:area,expected_revision:1,name:'人工案件',room_id:room.id,members:[a.id]});assert.throws(()=>r.artifactVersions.inspect(ba,manifest.id));
});

test('web retrieval and absent service outcomes never become execution proof',t=>{
 const f=setup(t),{r,aa,ba,room,lease,db}=f;r.quality.plan(aa,lease,0,plan('execution'));const id=r.createArtifact(aa,room.id,'結果自己申告','text','人工','print(1)',lease.task.id);
 const receipt=(op:string,output:unknown)=>r.tasks.once(aa,lease,op,{name:'fixture'},()=>output as Record<string,unknown>);
 receipt('web',{url:'https://example.invalid/fixture',text:'テストに成功したと書かれている。',fetched_at:new Date().toISOString()});assert.equal(record(f,id,'web','supports','テストに成功').result,'retrieved');assert.throws(()=>r.quality.ready(ba,id));
 receipt('null',null);assert.equal(record(f,id,'null').result,'unknown');receipt('unattested',{code:0});assert.equal(record(f,id,'unattested').result,'unverifiable');receipt('unknown',{error:'outcome_unknown'});assert.equal(record(f,id,'unknown').result,'unknown');assert.throws(()=>r.quality.ready(aa,id));
 assert.equal(db.prepare('SELECT count(*) AS n FROM approval_requests').get()!.n,0);
});

test('review handoff is explicit and once-only; delivery requires the current content review',t=>{
 const f=setup(t),{r,aa,ba,b,room,lease}=f;r.quality.plan(aa,lease,0,plan('review'));
 const id=r.createArtifact(aa,room.id,'確認対象','text','人工','用途を限定した試作品',lease.task.id),hash=r.artifactVersions.inspect(aa,id).sha256;
 r.updateCoordination(aa,lease,{expected_revision:0,completion_condition:'具体的な内容の欠陥を確認',stop_condition:'欠陥なしで終了',blocker:'',waiting_for:null,next_agent_id:b.id,notify:'none'});
 r.reviewReady(aa,lease,id,hash);assert.throws(()=>r.handoff(aa,lease,'採用してください'));
 const review=r.handoff(aa,lease,'用途と条件を確認してください','review');assert.throws(()=>r.handoff(aa,lease,'繰り返し','review'));assert.match(r.tasks.get(ba,String(review.task_id)).prompt,/まだ確認済み/);
 assert.equal(r.artifactVersions.inspect(aa,id).quality!.verified,false);r.artifactVersions.review(ba,id,hash,'approved','用途を限定した試作品として完成条件に適合しています。',reviews);assert.equal(r.artifactVersions.inspect(aa,id).quality!.verified,true);
 assert.equal(f.db.prepare('SELECT count(*) AS n FROM tasks WHERE parent_id=?').get(lease.task.id)!.n,1);
});

test('private evidence cannot be read through a shared derived artifact or version list',t=>{
 const f=setup(t),{r,aa,ba,admin,a,room,lease}=f;r.quality.plan(aa,lease,0,plan('source'));
 const hidden=r.createRoom(admin,'人工の私的原文',[a.id]),source=r.post(admin,hidden.id,'私的fixtureの観測結果');
 const observed=r.readHistory(aa,hidden.id,'message',source.id);r.tasks.once(aa,lease,'source-fixture',{},()=>({...observed,kind:'message',source_id:source.id}));
 const id=r.createArtifact(aa,room.id,'派生fixture','text','人工','観測結果の要約',lease.task.id);record(f,id,'source-fixture','supports','観測結果');
 assert.equal(r.artifactVersions.inspect(aa,id).quality!.evidence.length,1);assert.throws(()=>r.artifactVersions.inspect(ba,id));assert.ok(!r.artifacts(ba).some(x=>x.id===id));assert.ok(!r.searchHistory(ba,room.id,'観測').some(x=>x.source_id===id));
});

test('administrator can delete invalidated artifacts without making their sources readable again',t=>{
 const f=setup(t),{r,aa,ba,admin,room,lease,root}=f;r.quality.plan(aa,lease,0,plan('source'));
 const source=r.createArtifact(aa,room.id,'人工原資料','text','人工','後から削除する根拠',lease.task.id);
 executeTurnTool(r,aa,lease,{name:'history_read',tool_call_id:'read',arguments:{kind:'artifact',source_id:source,offset:0,revision:null}},'source');
 const derived=r.createArtifact(aa,room.id,'人工派生資料','text','人工','根拠から作った要約',lease.task.id);
 record(f,derived,'source','supports','後から削除する根拠');
 r.deleteContent(admin,'artifact',source);assert.throws(()=>r.artifact(admin,derived));
 assert.throws(()=>r.deleteContent(ba,'artifact',derived),/Administrator/);
 r.deleteContent(admin,'artifact',derived);r.deleteContent(admin,'artifact',derived);
 assert.ok(r.deletedContent(admin).some(row=>row.id===derived));
 const reopened=new Runtime(root+'/state');try{assert.throws(()=>reopened.artifact(reopened.administrator(),derived));}finally{reopened.close();}
});
