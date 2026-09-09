import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Runtime} from '../src/runtime/runtime.ts';
import {executeTurnTool} from '../src/runtime/turn-tools.ts';
function fixture(t:{after(fn:()=>void):void}){
 const root=mkdtempSync(join(tmpdir(),'niwa-initiatives-')),r=new Runtime(root),admin=r.administrator(),bot=r.bootstrap(admin),actor=r.agentSession(bot.id),room=r.createRoom(admin,'人工共有');
 const db=new DatabaseSync(join(root,'control.db'));t.after(()=>{db.close();r.close();rmSync(root,{recursive:true,force:true});});
 return {root,r,admin,bot,actor,room,db};
}
function body(owner:string){return {purpose:'資料を検証して改善する',reason:'比較方法に関心がある',completion:'根拠付きの比較を保存',next_action:'方法Aを検証',method:'方法A',last_result:'未着手',participants:[owner],workarea:null,artifacts:[],wait:{kind:'none' as const,detail:'',task_id:null}};}
test('opt-in, revision CAS, current context and persisted checkpoints reuse one initiative',t=>{
 const {root,r,admin,bot,actor,room}=fixture(t);r.tasks.create(admin,bot.id,room.id,'初回');const lease=r.tasks.claim(admin)!;
 const input={id:null,expected_revision:0,body:body(bot.id),state:'active' as const,review_at:0};
 assert.throws(()=>r.initiatives.save(actor,lease,input));r.initiatives.enable(admin,true);
 const call={tool_call_id:'i',name:'initiative_save',arguments:input};const first=executeTurnTool(r,actor,lease,call,'save');assert.ok(first.id);
 assert.deepEqual(executeTurnTool(r,actor,lease,call,'save'),first);assert.equal(r.initiatives.list(admin).length,1);
 assert.throws(()=>r.initiatives.save(actor,lease,{...input,id:String(first.id)}));
 r.tasks.finish(actor,lease,'初回終了');let now=Date.now();r.autonomousWakes.dispatch(admin,now);r.autonomousWakes.dispatch(admin,now+60001);
 const cycle=r.tasks.claim(admin)!;assert.equal(r.initiatives.current(actor,cycle.task.id)!.id,first.id);
 r.tasks.checkpoint(actor,cycle,'checkpoint',{purpose:'目的',tried:'方法A',result:'根拠なし',alternatives:'方法B',next_action:'方法Bを検証',resume_condition:'休息後',rest_minutes:60});
 const saved=r.initiatives.get(admin,String(first.id));assert.equal(saved.body.next_action,'方法Bを検証');assert.equal(saved.state,'resting');
 r.autonomousWakes.dispatch(admin,now+120000);assert.equal(r.tasks.list(admin).length,2);
 const reopened=new Runtime(root);try{const a=reopened.administrator();assert.deepEqual(reopened.initiatives.get(a,saved.id),saved);reopened.autonomousWakes.dispatch(a,now+7200000);assert.equal(reopened.tasks.list(a).length,3);assert.equal(reopened.initiatives.list(a).length,1);}finally{reopened.close();}
});
test('private scope, participant removal, dormancy, pause and restore block access or execution',t=>{
 const {r,admin,bot,actor,db}=fixture(t),other=r.createAgent(actor,'別Bot'),privateRoom=r.createRoom(admin,'個別',[bot.id]);r.initiatives.enable(admin,true);
 r.tasks.create(admin,bot.id,privateRoom.id,'個別の途中作業');const lease=r.tasks.claim(admin)!,item=r.initiatives.save(actor,lease,{id:null,expected_revision:0,body:{...body(bot.id),purpose:'private-canary'},state:'active',review_at:0});
 assert.equal(r.initiatives.list(r.agentSession(other.id)).length,0);assert.throws(()=>r.initiatives.save(actor,lease,{id:item.id,expected_revision:1,body:{...item.body,participants:[bot.id,other.id]},state:'active',review_at:0}));
 r.initiatives.pause(admin,item.id,item.revision,true);assert.equal(r.tasks.active(actor,lease),false);assert.throws(()=>r.initiatives.save(actor,lease,{id:item.id,expected_revision:2,body:item.body,state:'active',review_at:0}));
 r.initiatives.pause(admin,item.id,2,false);assert.equal(r.tasks.get(admin,lease.task.id).paused,1);r.tasks.resume(admin,lease.task.id);r.tasks.finish(actor,r.tasks.claim(admin)!,'保存');
 r.initiatives.pause(admin,item.id,3,true);r.autonomousWakes.dispatch(admin,Date.now()+3600000);assert.equal(db.prepare('SELECT count(*) n FROM initiative_tasks').get()!.n,1);
 r.tasks.protectRestoredWork(admin);assert.equal(r.initiatives.enabled(),false);
});
test('actual wait references, deduplicated events and grounded evidence preserve held operations',async t=>{
 const {r,admin,bot,actor,room,db}=fixture(t);r.initiatives.enable(admin,true);
 const held=r.tasks.create(admin,bot.id,room.id,'承認待ち');const heldLease=r.tasks.claim(admin)!;r.authorizeAction(actor,heldLease,'approval','人工操作',{destination:'synthetic'});
 const now=Date.now();r.autonomousWakes.dispatch(admin,now);r.autonomousWakes.dispatch(admin,now+60001);const lease=r.tasks.claim(admin)!;
 const input={id:null,expected_revision:0,body:{...body(bot.id),wait:{kind:'approval' as const,detail:'人工操作の承認',task_id:held.id}},state:'active' as const,review_at:now+86400000};
 const item=r.initiatives.save(actor,lease,input);assert.throws(()=>r.initiatives.save(actor,lease,{...input,id:item.id,expected_revision:1,body:{...input.body,wait:{kind:'approval' as const,detail:'未提出',task_id:lease.task.id}}}));
 let executed=false;await r.tasks.externalOnce(actor,lease,'forbidden',{name:'send'},async()=>{executed=true;return {};});assert.equal(executed,false);
 r.tasks.once(actor,lease,'source',{name:'web_read'},()=>({url:'https://example.test/',fetched_at:'2026-09-09',text:'人工の観測結果'}));
 assert.equal(r.initiatives.evidence(actor,lease,'finding','source','比較方法Aを棄却する根拠').recorded,true);
 assert.equal(r.initiatives.evidence(actor,lease,'finding','source','言い換え').recorded,false);
 assert.throws(()=>r.initiatives.evidence(actor,lease,'finding','missing','自己申告'));
 r.tasks.finish(actor,lease,'比較終了');r.autonomousWakes.dispatch(admin,now+120000);
 // A relevant message pulls forward a review once. It does not resume approval.
 r.post(admin,room.id,'関連する新しい人工情報');r.autonomousWakes.dispatch(admin,now+1800000);const next=r.tasks.claim(admin)!;assert.ok(next);assert.equal(r.initiatives.current(actor,next.task.id)!.id,item.id);
 r.autonomousWakes.dispatch(admin,now+1800001);assert.equal(r.tasks.list(admin).length,3);assert.equal(r.tasks.get(admin,held.id).state,'waiting_user');assert.equal(r.approvals(admin).length,1);
 assert.equal(db.prepare('SELECT count(*) n FROM initiative_evidence').get()!.n,1);
});
test('multiple Bots and cycles retain initiative links and budget across delegation and model waits',t=>{
 const {r,admin,bot,actor,room,db}=fixture(t),other=r.createAgent(actor,'協力者'),now=Date.now();r.initiatives.enable(admin,true);
 for(const member of [bot,other]){r.tasks.create(admin,member.id,room.id,'準備');const lease=r.tasks.claim(admin)!;r.initiatives.save(r.agentSession(member.id),lease,{id:null,expected_revision:0,body:{...body(member.id),purpose:member.id,participants:[bot.id,other.id]},state:'active',review_at:0});r.tasks.finish(r.agentSession(member.id),lease,'保存');}
 for(let cycle=0;cycle<6;cycle++){r.autonomousWakes.dispatch(admin,now+60001+cycle*3600000);const lease=r.tasks.claim(admin)!;assert.ok(lease);const a=r.agentSession(lease.task.agent_id);assert.ok(r.initiatives.current(a,lease.task.id));assert.equal(r.tasks.reserveModelCall(a,lease),true);r.tasks.checkpoint(a,lease,'save',{purpose:'比較',tried:'方法'+cycle,result:'次の仮説',alternatives:'別経路',next_action:'比較を続ける',resume_condition:'時間',rest_minutes:15});}
 assert.equal(r.initiatives.list(admin).length,2);assert.equal(db.prepare('SELECT count(*) n FROM initiative_tasks').get()!.n,8);assert.equal(db.prepare('SELECT sum(model_calls) n FROM autonomous_wakes').get()!.n,6);
 db.prepare('UPDATE autonomous_wakes SET model_calls=24,budget_reset_at=?').run(now+86400000);const count=r.tasks.list(admin).length;r.autonomousWakes.dispatch(admin,now+8*3600000);assert.equal(r.tasks.list(admin).length,count);
 r.updateSettings(admin,{paused:true});r.autonomousWakes.dispatch(admin,now+2*86400000);assert.equal(r.tasks.list(admin).length,count);
});
test('mixed child, approval, search and provider waits leave independent work runnable without bypass or new chains',async t=>{
 const {r,admin,bot,actor,room,db}=fixture(t);r.initiatives.enable(admin,true);const b=r.createAgent(actor,'子待ち'),c=r.createAgent(actor,'モデル待ち');
 r.tasks.create(admin,bot.id,room.id,'操作');r.authorizeAction(actor,r.tasks.claim(admin)!,'approval','人工操作',{x:1});
 r.tasks.create(admin,b.id,room.id,'子へ依頼');const parent=r.tasks.claim(admin)!;r.tasks.delegate(r.agentSession(b.id),parent,c.id,'子の調査');const child=r.tasks.claim(admin)!;r.tasks.wait(r.agentSession(c.id),child,'waiting_provider','人工のモデル接続待ち');
 const held=r.tasks.list(admin).map(x=>[x.id,x.state]),now=Date.now();r.autonomousWakes.dispatch(admin,now);
 const seen=new Set<string>();for(let cycle=0;cycle<9;cycle++){
  r.autonomousWakes.dispatch(admin,now+60001+cycle*3600000);const lease=r.tasks.claim(admin)!;assert.ok(lease);const a=r.agentSession(lease.task.agent_id);seen.add(lease.task.agent_id);
  assert.equal(r.tasks.independentActivity(a,lease),true);let ran=false;await r.tasks.externalOnce(a,lease,'no-bypass',{name:'program_run'},async()=>{ran=true;return {};});assert.equal(ran,false);
  let item=r.initiatives.current(a,lease.task.id);if(!item)item=r.initiatives.save(a,lease,{id:null,expected_revision:0,body:{...body(lease.task.agent_id),wait:{kind:'search_failed',detail:'方法Aで見つからない。方法Bへ',task_id:null}},state:'active',review_at:0});
  r.tasks.checkpoint(a,lease,'next',{purpose:'比較',tried:'方法A',result:'候補なし',alternatives:'方法B',next_action:'方法Bを試す',resume_condition:'休息後',rest_minutes:15});
 }
 assert.equal(seen.size,3);assert.equal(r.initiatives.list(admin).length,3);assert.deepEqual(r.tasks.list(admin).filter(x=>held.some(h=>h[0]===x.id)).map(x=>[x.id,x.state]),held);
 assert.equal(db.prepare('SELECT count(*) n FROM tasks WHERE parent_id IS NOT NULL').get()!.n,1);assert.equal(r.approvals(admin).length,1);
});
test('delegation uses the originating hourly budget and participation grants no new permissions',t=>{
 const {r,admin,bot,actor,room,db}=fixture(t),other=r.createAgent(actor,'担当');r.initiatives.enable(admin,true);
 const now=Date.now();r.autonomousWakes.dispatch(admin,now);r.autonomousWakes.dispatch(admin,now+60001);const lease=r.tasks.claim(admin)!;
 const item=r.initiatives.save(actor,lease,{id:null,expected_revision:0,body:{...body(bot.id),participants:[bot.id,other.id]},state:'active',review_at:0});
 r.tasks.reserveModelCall(actor,lease);r.tasks.delegate(actor,lease,other.id,'比較の実物を確認。完成条件は相違点の報告、期限20分以内');const child=r.tasks.claim(admin)!,ca=r.agentSession(other.id);
 assert.equal(r.initiatives.current(ca,child.task.id)!.id,item.id);assert.equal(r.tasks.reserveModelCall(ca,child),true);
 assert.equal(db.prepare('SELECT model_calls FROM autonomous_wakes WHERE agent_id=?').get(bot.id)!.model_calls,2);
 db.prepare('UPDATE autonomous_wakes SET model_calls=24 WHERE agent_id=?').run(bot.id);assert.equal(r.tasks.reserveModelCall(ca,child),false);assert.equal(r.tasks.get(admin,child.task.id).state,'waiting_provider');
});
test('artifact revisions coalesce during cooldown; membership removal and deletion preserve privacy',t=>{
 const {r,admin,bot,actor,room,db}=fixture(t),other=r.createAgent(actor,'共同担当');r.initiatives.enable(admin,true);
 r.tasks.create(admin,bot.id,room.id,'初稿');let lease=r.tasks.claim(admin)!;const artifact=r.createArtifact(actor,room.id,'人工の初稿','text','検証','v1',lease.task.id);r.artifactVersions.reference(actor,artifact,lease.task.id);
 let item=r.initiatives.save(actor,lease,{id:null,expected_revision:0,body:{...body(bot.id),participants:[bot.id,other.id],artifacts:[artifact]},state:'active',review_at:0});
 r.tasks.finish(actor,lease,'初稿');const now=Date.now();r.autonomousWakes.dispatch(admin,now);lease=r.tasks.claim(admin)!;r.tasks.finish(actor,lease,'確認');r.autonomousWakes.dispatch(admin,now+1);
 const ref=r.artifactVersions.reference(actor,artifact,lease.task.id);r.artifactVersions.revise(actor,artifact,String(ref.sha256),'v2',lease.task.id);r.initiatives.observe(admin,now+1000);
 item=r.initiatives.get(admin,item.id);assert.ok(item.review_reason.includes('成果物'));assert.equal(item.review_at,now+900000);
 r.initiatives.observe(admin,now+2000);assert.equal(r.initiatives.get(admin,item.id).review_at,item.review_at);
 r.tasks.create(admin,other.id,room.id,'参加中');const child=r.tasks.claim(admin)!;r.initiatives.select(r.agentSession(other.id),child,item.id);
 // Owner may withdraw an existing participant; the old task loses execution authority.
 r.tasks.create(admin,bot.id,room.id,'参加者の更新');const owner=r.tasks.claim(admin)!;
 r.initiatives.save(actor,owner,{id:item.id,expected_revision:item.revision,body:{...item.body,participants:[bot.id]},state:'active',review_at:item.review_at});assert.equal(r.tasks.active(r.agentSession(other.id),child),false);assert.equal(r.initiatives.list(r.agentSession(other.id)).length,0);
 const privateRoom=r.createRoom(admin,'個別',[other.id]);r.tasks.cancel(admin,child.task.id);r.tasks.create(admin,other.id,privateRoom.id,'非公開');const privateLease=r.tasks.claim(admin)!;
 r.initiatives.save(r.agentSession(other.id),privateLease,{id:null,expected_revision:0,body:{...body(other.id),purpose:'private-canary'},state:'active',review_at:0});r.applyAgentDeletions(admin,[{id:other.id,deleted_at:Date.now()}]);assert.equal(db.prepare("SELECT count(*) n FROM initiatives WHERE body LIKE '%private-canary%'").get()!.n,0);
});
