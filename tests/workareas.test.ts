import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {Runtime} from '../src/runtime/runtime.ts';
import {WorkareaStore} from '../src/tools/workareas/store.ts';
import type {WorkareaTransport} from '../src/runtime/workareas.ts';
function fixture(t:{after(fn:()=>void):void},run?:ConstructorParameters<typeof WorkareaStore>[1]){
 const root=mkdtempSync(join(tmpdir(),'niwa-workareas-'));mkdirSync(join(root,'files'));
 const r=new Runtime(join(root,'state')),admin=r.administrator(),a=r.bootstrap(admin),aa=r.agentSession(a.id),b=r.createAgent(aa,'B'),ba=r.agentSession(b.id),room=r.createRoom(admin,'共同制作'),privateRoom=r.createRoom(admin,'個別',[a.id]);
 const store=new WorkareaStore(join(root,'files'),run??(async()=>({code:0,stdout:'',stderr:''})),async()=>{});
 const transport:WorkareaTransport=(input,signal)=>input.operation==='published'?Promise.resolve(store.published(input.artifact!)):store.execute(input,signal);
 r.workareas.enable(admin,true);
 const at=r.tasks.create(admin,a.id,room.id,'Aの作業'),al=r.tasks.claim(admin)!;
 const bt=r.tasks.create(admin,b.id,room.id,'Bの作業'),bl=r.tasks.claim(admin)!;
 assert.equal(al.task.id,at.id);assert.equal(bl.task.id,bt.id);
 t.after(()=>{store.close();r.close();rmSync(root,{recursive:true,force:true});});
 return {root,r,admin,a,aa,b,ba,room,privateRoom,al,bl,store,transport};
}
const write=(path:string,content:string,expected_revision:string|null=null)=>({operation:'write',path,content,expected_revision,operation_id:randomUUID(),allow_start:true});
test('queued project changes recheck deleted participants and conversations at commit time',async t=>{
 const {r,admin,a,b,room}=fixture(t);
 const existing=await r.workareas.project(admin,{name:'既存案件',room_id:room.id,members:[a.id,b.id]});
 const pending=r.workareas.project(admin,{id:existing.id,name:'変更後',room_id:room.id,members:[b.id],expected_revision:1});
 r.deleteAgent(admin,b.id);
 await assert.rejects(pending,/participants/);
 const area=r.workareas.list(admin).find(item=>item.id===existing.id)!;
 assert.deepEqual(area.members,[a.id]);const metadata=r.workareas.authorize(admin,existing.id);
 assert.equal(metadata.name,'既存案件');assert.equal(metadata.revision,1);
 const created=r.workareas.project(admin,{name:'削除後に作られてはいけない案件',room_id:room.id,members:[a.id]});
 r.deleteContent(admin,'room',room.id);
 await assert.rejects(created,/Conversation not found/);assert.equal(r.workareas.list(admin).length,0);
});
test('personal ownership, explicit project membership, private conversation and stopped activity use one boundary',async t=>{
 const f=fixture(t),{r,admin,aa,ba,al,bl,transport}=f;
 const a=r.workareas.personal(aa,al).area_id!,b=r.workareas.personal(ba,bl).area_id!;
 await r.workareas.execute(aa,a,write('a.txt','private A'),transport,al);
 await r.workareas.execute(ba,b,write('b.txt','private B'),transport,bl);
 await assert.rejects(r.workareas.execute(ba,a,{operation:'read',path:'a.txt'},transport,bl));
 assert.throws(()=>r.workareas.select(aa,al,b));
 assert.equal(r.workareas.list(aa,al).length,1);assert.equal(r.workareas.list(admin).length,2);
 const project=await r.workareas.project(admin,{name:'案件',room_id:f.room.id,members:[f.a.id,f.b.id]});
 await r.workareas.execute(aa,project.id,write('joint.txt','v1'),transport,al);
 assert.equal((await r.workareas.execute(ba,project.id,{operation:'read',path:'joint.txt'},transport,bl)).content,'v1');
 r.tasks.finish(aa,al,'完了');r.tasks.create(admin,f.a.id,f.privateRoom.id,'別会話');const secret=r.tasks.claim(admin)!;
 await assert.rejects(r.workareas.execute(aa,a,{operation:'read',path:'a.txt'},transport,secret));
 r.updateSettings(admin,{paused:true});await assert.rejects(r.workareas.execute(ba,b,{operation:'read',path:'b.txt'},transport,bl));
});
test('file CAS and program snapshot CAS preserve both edits; publication is independent of later draft edits',async t=>{
 let release!:()=>void,started!:()=>void;const ready=new Promise<void>(r=>started=r),wait=new Promise<void>(r=>release=r);
 const f=fixture(t,async root=>{writeFileSync(join(root,'program.txt'),'program result');started();await wait;return {code:0,stdout:'ok',stderr:''};});
 const {r,admin,aa,ba,al,bl,transport}=f;
 const project=await r.workareas.project(admin,{name:'案件',room_id:f.room.id,members:[f.a.id,f.b.id]});
 const first=await r.workareas.execute(aa,project.id,write('joint.txt','base'),transport,al);
 const program=r.workareas.execute(aa,project.id,{operation:'run',operation_id:randomUUID(),allow_start:true,command:['python','-c','pass'],seconds:10},transport,al);
 await ready;
 await r.workareas.execute(ba,project.id,write('joint.txt','B edit',first.revision as string),transport,bl);
 const stale=await r.workareas.execute(aa,project.id,write('joint.txt','A stale',first.revision as string),transport,al);assert.equal(stale.error,'conflict');
 release();const conflict=await program;assert.equal(conflict.error,'conflict');assert.equal(typeof conflict.candidate,'string');
 assert.equal((await r.workareas.execute(aa,project.id,{operation:'read',path:'program.txt',revision:conflict.candidate as string},transport,al)).content,'program result');
 assert.equal((await r.workareas.execute(ba,project.id,{operation:'read',path:'joint.txt'},transport,bl)).content,'B edit');
 const personal=r.workareas.personal(aa,al).area_id!,draft=await r.workareas.execute(aa,personal,write('draft.txt','fixed content'),transport,al);
 const share=await r.workareas.share(aa,al,personal,'draft.txt',draft.revision as string,transport,randomUUID(),true);
 await r.workareas.execute(aa,personal,write('draft.txt','changed',draft.revision as string),transport,al);
 assert.equal(r.artifact(ba,String(share.artifact_id)).content,'fixed content');
 assert.equal(r.artifactVersions.inspect(ba,String(share.artifact_id)).sha256,share.sha256);
});
test('revocation while a program runs prevents commit; dormancy retains data and deletion retires only personal work',async t=>{
 let release!:()=>void,started!:()=>void;const ready=new Promise<void>(r=>started=r),wait=new Promise<void>(r=>release=r);
 let aborted=false;const f=fixture(t,async(root,_request,signal)=>{signal?.addEventListener('abort',()=>{aborted=true;},{once:true});writeFileSync(join(root,'out'),'uncommitted');started();await wait;return {code:0,stdout:'',stderr:''};});
 const {r,admin,aa,ba,al,bl,transport}=f,personal=r.workareas.personal(ba,bl).area_id!;
 await r.workareas.execute(ba,personal,write('keep','kept'),transport,bl);
 const project=await r.workareas.project(admin,{name:'案件',room_id:f.room.id,members:[f.a.id,f.b.id]});
 const program=r.workareas.execute(ba,project.id,{operation:'run',operation_id:randomUUID(),allow_start:true,command:['true'],seconds:10},transport,bl);await ready;
 await r.workareas.project(admin,{id:project.id,name:'案件',room_id:f.room.id,members:[f.a.id],expected_revision:1});assert.equal(aborted,true);release();await assert.rejects(program);
 r.setDormant(admin,f.b.id,true);await assert.rejects(r.workareas.execute(ba,personal,{operation:'read',path:'keep'},transport,bl));
 assert.equal((await r.workareas.execute(admin,personal,{operation:'read',path:'keep'},transport)).content,'kept');
 r.setDormant(admin,f.b.id,false);assert.ok(r.workareas.list(admin).some(w=>w.id===personal));
 r.deleteAgent(admin,f.b.id);assert.ok(r.workareas.retired().includes(personal));assert.ok(r.workareas.list(admin).some(w=>w.id===project.id));
});
test('program-produced links are rejected and crash receipts never rerun an unknown operation',async t=>{
 const f=fixture(t,async root=>{symlinkSync(f.root,join(root,'escape'));return {code:0,stdout:'',stderr:''};});
 const id=f.r.workareas.personal(f.aa,f.al).area_id!,input={operation:'run',operation_id:randomUUID(),allow_start:true,command:['true'],seconds:10};
 const first=await f.r.workareas.execute(f.aa,id,input,f.transport,f.al);assert.equal(first.error,'invalid_path');
 assert.deepEqual(await f.r.workareas.execute(f.aa,id,input,f.transport,f.al),first);
 for(const path of ['../state/control.db','/etc/passwd','a/../../secrets/key'])await assert.rejects(f.r.workareas.execute(f.aa,id,{operation:'read',path},f.transport,f.al));
});

test('project publications, binary revisions, search and removal enforce the current audience',async t=>{
 const f=fixture(t),{r,aa,ba,admin,al,bl,transport}=f;
 const personal=r.workareas.personal(aa,al).area_id!;
 const project=await r.workareas.project(admin,{name:'限定案件',room_id:f.room.id,members:[f.a.id]});
 const file=await r.workareas.execute(aa,personal,write('restricted.txt','limited-synthetic-content'),transport,al);
 const shared=await r.workareas.share(aa,al,personal,'restricted.txt',file.revision as string,transport,randomUUID(),true,undefined,project.id);
 assert.throws(()=>r.artifact(ba,String(shared.artifact_id)));
 assert.equal(r.artifacts(ba,'limited-synthetic').length,0);
 assert.equal(r.searchHistory(ba,f.room.id,'limited-synthetic').length,0);
 assert.throws(()=>r.readHistory(ba,f.room.id,'artifact',String(shared.artifact_id)));
 await r.workareas.project(admin,{id:project.id,name:'限定案件',room_id:f.room.id,members:[f.a.id,f.b.id],expected_revision:1});
 assert.equal(r.artifact(ba,String(shared.artifact_id)).content,'limited-synthetic-content');
 const binary=await r.workareas.execute(aa,personal,{...write('data.bin',Buffer.from([0,1,2]).toString('base64')),encoding:'base64'},transport,al);
 const v1=await r.workareas.share(aa,al,personal,'data.bin',binary.revision as string,transport,randomUUID(),true,undefined,project.id);
 const next=await r.workareas.execute(aa,personal,{...write('data.bin',Buffer.from([0,1,3]).toString('base64'),binary.revision as string),encoding:'base64'},transport,al);
 const v2=await r.workareas.share(aa,al,personal,'data.bin',next.revision as string,transport,randomUUID(),true,undefined,project.id,String(v1.artifact_id));
 const {executeAsyncTurnTool}=await import('../src/runtime/turn-tools.ts');
 const downloaded=await executeAsyncTurnTool(r,ba,bl,{name:'artifact_download',tool_call_id:'binary',arguments:{id:String(v1.artifact_id)}},'binary',undefined,{workareas:transport});
 assert.deepEqual(Buffer.from(downloaded.data as string,'base64'),Buffer.from([0,1,2]));
 const inspected=r.artifactVersions.inspect(ba,String(v2.artifact_id));assert.equal(inspected.version,2);assert.equal(inspected.versions.length,2);
 assert.deepEqual(Buffer.from(f.store.published(String(r.workareas.file(ba,String(v1.artifact_id)).blob_id)).data,'base64'),Buffer.from([0,1,2]));
 await r.workareas.project(admin,{id:project.id,name:'限定案件',room_id:f.room.id,members:[f.a.id],expected_revision:2});
 assert.throws(()=>r.workareas.file(ba,String(v1.artifact_id)));
 assert.ok((await executeAsyncTurnTool(r,ba,bl,{name:'artifact_download',tool_call_id:'binary',arguments:{id:String(v1.artifact_id)}},'binary',undefined,{workareas:transport})).error);
 r.deleteAgent(admin,f.b.id);assert.ok(r.artifact(admin,String(v1.artifact_id)));
});

test('tool selection uses task-bound area, keeps legacy private writes denied and forbids receipt replay after removal',async t=>{
 const {executeAsyncTurnTool,turnTools}=await import('../src/runtime/turn-tools.ts');
 const f=fixture(t),{r,aa,al,admin,transport}=f;
 const tools={workareas:transport},call=(name:string,args:Record<string,unknown>,id=randomUUID())=>executeAsyncTurnTool(r,aa,al,{tool_call_id:id,name,arguments:args as import('../src/contracts/model.ts').JsonObject},id,undefined,tools);
 assert.ok(!turnTools(false,tools,false,false,false).some(t=>t.name==='workspace_select'));
 assert.ok(turnTools(false,tools,false,false,true).some(t=>t.name==='program_run'));
 await call('workspace_select',{area:'personal'});
 const result=await call('workspace_write',{path:'draft','content':'task-bound',expected_revision:null});assert.ok(result.revision);
 const operation=randomUUID();assert.equal((await call('workspace_read',{path:'draft'},operation)).content,'task-bound');
 const project=await r.workareas.project(admin,{name:'案件',room_id:f.room.id,members:[f.a.id,f.b.id]});
 await call('workspace_select',{area:project.id});
 assert.ok((await call('workspace_read',{path:'draft'},operation)).error);
 r.workareas.enable(admin,false);assert.ok((await call('workspace_read',{path:'draft'})).error);
});

test('restart preserves files and epoch; restore fences missing files instead of resurrecting deleted content',async t=>{
 const f=fixture(t),{r,aa,al,admin,transport}=f;
 const id=r.workareas.personal(aa,al).area_id!;
 await r.workareas.execute(aa,id,write('keep','retained'),transport,al);
 const reopened=new Runtime(join(f.root,'state'));
 try{
  assert.equal(reopened.workareas.epoch(),r.workareas.epoch());
  assert.equal((await reopened.workareas.execute(reopened.administrator(),id,{operation:'read',path:'keep'},transport)).content,'retained');
  reopened.tasks.protectRestoredWork(reopened.administrator());
  assert.equal(reopened.workareas.settings(reopened.administrator()).enabled,0);
  reopened.workareas.enable(reopened.administrator(),true);
  await assert.rejects(reopened.workareas.execute(reopened.administrator(),id,{operation:'read',path:'keep'},transport));
 }finally{reopened.close();}
});

test('approved uploads bind the selected workarea and reject removal without an external send',async t=>{
 const {executeAsyncTurnTool}=await import('../src/runtime/turn-tools.ts');
 const {FormLog}=await import('../src/tools/browser/form-log.ts');
 const {submitPublicForm}=await import('../src/tools/browser/form.ts');
 const f=fixture(t),{r,admin,aa,transport}=f;
 const project=await r.workareas.project(admin,{name:'添付案件',room_id:f.room.id,members:[f.a.id,f.b.id]});
 let lease=f.al,sent=0;
 r.workareas.select(aa,lease,project.id);
 const stored=await r.workareas.execute(aa,project.id,write('upload.txt','synthetic upload'),transport,lease);
 const journal=new FormLog(join(f.root,'forms.db'),(form,signal,reader)=>submitPublicForm(form,signal,async()=>{sent++;return {url:form.url,status:200,text:'synthetic',truncated:false,untrusted:true};},async()=> '93.184.215.14',reader));
 t.after(()=>journal.close());
 const external={workareas:transport,forms:journal,browser:async()=>({})} as unknown as import('../src/runtime/turn-tools.ts').ExternalTools;
 const call={tool_call_id:'upload',name:'browser_form_submit',arguments:{url:'https://example.com/submit',method:'POST',fields:[],files:[{name:'attachment',path:'upload.txt',filename:'upload.txt',revision:stored.revision,size:16}]}};
 assert.equal((await executeAsyncTurnTool(r,aa,lease,call,'upload',undefined,external)).waiting_for_approval,true);assert.equal(sent,0);
 const approval=r.approvals(admin)[0]!;assert.ok(String(approval.detail).includes(project.id));
 r.decideApproval(admin,lease.task.id,true,String(approval.version));lease=r.tasks.claim(admin)!;
 const result=await executeAsyncTurnTool(r,aa,lease,call,'upload',undefined,external);assert.equal(result.status,200);assert.equal(sent,1);
 await r.workareas.project(admin,{id:project.id,name:'添付案件',room_id:f.room.id,members:[f.b.id],expected_revision:1});
 assert.ok((await executeAsyncTurnTool(r,aa,lease,call,'upload',undefined,external)).error);assert.equal(sent,1);
});

test('independent activity cannot use a new personal area to bypass a held operation',async t=>{
 const {executeAsyncTurnTool}=await import('../src/runtime/turn-tools.ts');
 const f=fixture(t),{r,admin,aa,transport}=f;
 r.tasks.wait(aa,f.al,'waiting_user','人工の必要入力待ち');
 const now=Date.now();r.autonomousWakes.dispatch(admin,now);r.autonomousWakes.dispatch(admin,now+60000);
 const lease=r.tasks.claim(admin)!;assert.ok(lease);assert.equal(lease.task.agent_id,f.a.id);assert.equal(r.tasks.independentActivity(aa,lease),true);
 r.workareas.personal(aa,lease);
 for(const [name,args] of [['workspace_write',{path:'other-name',content:'held operation',expected_revision:null}],['program_run',{command:['true'],seconds:10}],['workspace_share',{path:'draft',expected_revision:'a'.repeat(64),target_project:null,parent_artifact:null}] ] as const){
  const result=await executeAsyncTurnTool(r,aa,lease,{name,tool_call_id:name,arguments:args},randomUUID(),undefined,{workareas:transport});assert.equal(result.error,'independent_activity_scope');
 }
 assert.equal(r.tasks.get(admin,f.al.task.id).state,'waiting_user');
 const read=await executeAsyncTurnTool(r,aa,lease,{name:'workspace_list',tool_call_id:'list',arguments:{path:''}},'list',undefined,{workareas:transport});assert.ok(read.error);
});
