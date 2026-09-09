// Real executor attestation on bounded, artificial workareas; no image build/removal.
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
const [root,compiled,image]=process.argv.slice(2);assert.ok(root?.includes('/.quality-verification-'));assert.equal(process.getuid(),1001);
const load=p=>import(pathToFileURL(join(compiled,p+'.js')).href),sha=s=>createHash('sha256').update(s).digest('hex');
const {Runtime}=await load('runtime/runtime'),{WorkareaStore}=await load('tools/workareas/store'),{EnvironmentRegistry}=await load('tools/environments/registry'),{PackageCatalog}=await load('tools/packages/catalog'),{configuredProgramRunner}=await load('sandbox/program');
const env={workspace:root,image,uid:process.getuid(),gid:process.getgid(),home:'/home/niwa/niwa/runtime/executor/home',runtime:'/run/user/1001'},base=configuredProgramRunner(env);
mkdirSync(root+'/catalog',{mode:0o700});writeFileSync(root+'/catalog/catalog.json','[]',{mode:0o600});mkdirSync(root+'/files',{mode:0o711});
const catalog=new PackageCatalog(root+'/catalog'),registry=new EnvironmentRegistry(root+'/env.db',image,catalog,async()=>{throw Error('No installation');},async id=>(await base.call(['image','exists',id],15)).code===0),store=new WorkareaStore(root+'/files',(workspace,request,signal,name,pinned)=>configuredProgramRunner({...env,workspace,image:pinned??image})(request,signal,name),base.cleanup,registry),transport=input=>store.execute(input);
const r=new Runtime(root+'/state'),admin=r.administrator(),a=r.bootstrap(admin),aa=r.agentSession(a.id),b=r.createAgent(aa,'人工確認担当'),ba=r.agentSession(b.id),room=r.createRoom(admin,'人工実行証拠');
const report={image,checks:[]};
try{
 r.quality.enable(admin,true);r.workareas.enable(admin,true);r.tasks.create(admin,a.id,room.id,'人工コード検査');const lease=r.tasks.claim(admin);r.quality.plan(aa,lease,0,{criteria:[{id:'test',kind:'execution',condition:'固定版の計算が期待値5を返す'}],stop_condition:'具体的な誤りを直して実行結果を確認したら終了'});
 const area=(await r.workareas.project(admin,{name:'人工コード',room_id:room.id,members:[a.id,b.id]})).id;r.workareas.select(aa,lease,area);const exec=input=>r.workareas.execute(aa,area,input,transport,lease);
 const inspect=async(content,parent)=>{
  const old=parent?await exec({operation:'read',path:'main.py'}):{};await exec({operation:'write',path:'main.py',content,expected_revision:old.revision??null,operation_id:randomUUID(),allow_start:true});
  const file=await r.workareas.share(aa,lease,area,'main.py',sha(content),transport,randomUUID(),true);return r.quality.manifest(aa,lease,'人工の対象ファイル',[{path:'main.py',id:file.artifact_id,sha256:sha(content)}],parent);
 };
 const run=async(target,command,op)=>{
  const result=await r.tasks.externalOnce(aa,lease,op,{command},id=>exec({operation:'run',command,seconds:20,operation_id:id,allow_start:true}));
  const evidence=r.quality.record(aa,lease,{artifact_id:target.id,sha256:target.sha256,criterion:'test',reference:op,method:'隔離Pythonの実行と期待値assert',claim:'期待値5',excerpt:'',assessment:'supports',limits:'人工の一例。網羅的な品質保証ではない'});return {result,evidence};
 };
 const broken=await inspect('assert 2+3 == 6\n');assert.equal((await run(broken,['python','main.py'],'bad')).evidence.result,'failed');assert.throws(()=>r.quality.ready(aa,broken.id));report.checks.push('failed assertion rejected');
 const fixed=await inspect('assert 2+3 == 5\n',broken.id);const good=await run(fixed,['python','main.py'],'good');assert.equal(good.evidence.result,'passed');assert.equal(good.result.verification.image,image);assert.ok(good.result.verification.command_sha256);r.artifactVersions.review(ba,fixed.id,fixed.sha256,'approved','固定ファイルのassertと保存された実行成功を照合しました。',[{criterion:'test',verdict:'pass',note:'2+3の期待値5をassertした固定版が実コンテナで正常終了しています。'}]);assert.equal(r.artifactVersions.inspect(admin,fixed.id).quality.verified,true);report.checks.push('fixed file/image/command attested and reviewed');
 const reverted=await run(fixed,['python','-c',"from pathlib import Path;p=Path('main.py');s=p.read_text();p.write_text('changed');p.write_text(s)"],'reverted');assert.equal(reverted.evidence.result,'wrong_version');assert.throws(()=>r.artifactVersions.freeze(aa,fixed.id,fixed.sha256));report.checks.push('mutate and revert rejected; prior review stale');
 report.result='PASS';console.log('PASS',JSON.stringify(report));
}finally{r.close();store.close();registry.close();writeFileSync(root+'/receipt.json',JSON.stringify(report,null,2),{mode:0o600});}
