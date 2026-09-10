import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Runtime} from '../src/runtime/runtime.ts';
import {DatabaseSync} from 'node:sqlite';
function fixture(t:{after(fn:()=>void):void}) {
 const root=mkdtempSync(join(tmpdir(),'niwa-continuity-')),r=new Runtime(root),admin=r.administrator(),leader=r.bootstrap(admin),actor=r.agentSession(leader.id),room=r.createRoom(admin,'共同作業');
 t.after(()=>{r.close();rmSync(root,{recursive:true,force:true});});return {root,r,admin,leader,actor,room};
}
const checkpoint={purpose:'比較を進める',tried:'公開情報の経路A',result:'候補なし。ユーザー操作は不要',alternatives:'経路B',next_action:'別の根拠で比較',resume_condition:'休息後に方法Bを試す',rest_minutes:60};
test('mixed waits permit fair independent cycles and preserve approval, child and input waits across restart',async t=>{
 const {root,r,admin,leader,actor,room}=fixture(t),other=r.createAgent(actor,'担当'),childBot=r.createAgent(actor,'調査'),childActor=r.agentSession(childBot.id);
 const approval=r.tasks.create(admin,leader.id,room.id,'承認が必要な操作'),approvalLease=r.tasks.claim(admin)!;
 r.authorizeAction(actor,approvalLease,'approval','人工送信',{url:'https://example.test',method:'POST'});
 const parent=r.tasks.create(admin,other.id,room.id,'子の入力待ち');const parentLease=r.tasks.claim(admin)!;
 r.tasks.delegate(r.agentSession(other.id),parentLease,childBot.id,'入力待ちの調査');const child=r.tasks.claim(admin)!;
 r.tasks.wait(childActor,child,'waiting_user','具体的な入力が必要');
 const before=r.tasks.list(admin).map(x=>[x.id,x.state]),pending=r.approvals(admin).length;
 const now=Date.now();r.autonomousWakes.dispatch(admin,now);
 for(let cycle=0;cycle<6;cycle++){
  r.autonomousWakes.dispatch(admin,now+60000+cycle*3600001);
  const lease=r.tasks.claim(admin)!;assert.ok(lease);const bot=r.agentSession(lease.task.agent_id);
  assert.equal(r.tasks.workState(bot,lease).independent_activity,true);
  r.autonomousWakes.dispatch(admin,now+60001+cycle*3600001);
  assert.equal(r.tasks.list(admin).filter(x=>x.agent_id===lease.task.agent_id&&x.state==='running').length,1);
  let executed=false;const result=await r.tasks.externalOnce(bot,lease,'attempt',{name:'send'},async()=>{executed=true;return {ok:true};});
  assert.equal(executed,false);assert.equal(result.error,'independent_activity_scope');
  r.tasks.checkpoint(bot,lease,'save',checkpoint);
  assert.equal(r.tasks.get(admin,lease.task.id).state,'completed');
 }
 assert.equal(r.schedules.list(admin).length,0);assert.equal(r.approvals(admin).length,pending);
 assert.deepEqual(r.tasks.list(admin).filter(x=>before.some(b=>b[0]===x.id)).map(x=>[x.id,x.state]),before);
 assert.equal(r.tasks.get(admin,parent.id).state,'waiting_child');assert.equal(r.tasks.get(admin,approval.id).state,'waiting_user');
 const wakes=r.tasks.list(admin).filter(x=>x.internal_autonomous);assert.equal(wakes.length,6);assert.equal(new Set(wakes.map(x=>x.agent_id)).size,3);
 r.autonomousWakes.dispatch(admin,now+6*3600001);const reopened=new Runtime(root);try{
  const a=reopened.administrator();reopened.autonomousWakes.dispatch(a,now+10*3600001);const lease=reopened.tasks.claim(a)!;
  assert.ok(JSON.stringify(reopened.tasks.workState(reopened.agentSession(lease.task.agent_id),lease).recent_autonomous_work).includes('経路B'));
  reopened.updateSettings(a,{paused:true});const count=reopened.tasks.list(a).length;reopened.autonomousWakes.dispatch(a,now+20*3600001);assert.equal(reopened.tasks.list(a).length,count);
 }finally{reopened.close();}
});
test('held wake pointer is released, repeated evidence backs off, and private plans stay private',t=>{
 const {root,r,admin,leader,actor,room}=fixture(t),privateRoom=r.createRoom(admin,'個別',[leader.id]);
 r.tasks.create(admin,leader.id,privateRoom.id,'private-canary');let lease=r.tasks.claim(admin)!;
 r.tasks.updatePlan(actor,lease,'private',0,['private-canary']);r.tasks.wait(actor,lease,'waiting_user','private-canary');
 const now=Date.now();r.autonomousWakes.dispatch(admin,now);r.autonomousWakes.dispatch(admin,now+60000);lease=r.tasks.claim(admin)!;
 assert.ok(!JSON.stringify(r.tasks.workState(actor,lease)).includes('private-canary'));
 r.tasks.wait(actor,lease,'waiting_user','具体的な判断を待つ');r.autonomousWakes.dispatch(admin,now+120000);
 assert.equal(r.autonomousWakes.list(admin)[0]!.task_id,null);assert.equal(r.tasks.get(admin,lease.task.id).state,'waiting_user');
 for(let i=1;i<=3;i++){
  r.autonomousWakes.dispatch(admin,now+i*86400000);const next=r.tasks.claim(admin)!;assert.ok(next);
  r.tasks.checkpoint(actor,next,'rest',checkpoint);r.autonomousWakes.dispatch(admin,now+i*86400000+1);
 }
 const db=new DatabaseSync(join(root,'control.db'),{readOnly:true});try{assert.equal(db.prepare('SELECT stagnant FROM autonomous_wakes').get()!.stagnant,4);}finally{db.close();}
 assert.equal(r.autonomousWakes.list(admin)[0]!.reason,'進展がないため方法の見直し待ち');
 assert.equal(r.messages(admin,room.id).length,0);
});
test('independent delegation inherits operation boundaries and cannot turn replies into chains',async t=>{
 const {r,admin,leader,actor,room}=fixture(t),other=r.createAgent(actor,'担当');
 r.tasks.create(admin,leader.id,room.id,'保留');r.tasks.wait(actor,r.tasks.claim(admin)!,'waiting_user','入力待ち');
 const now=Date.now();r.autonomousWakes.dispatch(admin,now);r.autonomousWakes.dispatch(admin,now+60000);const parent=r.tasks.claim(admin)!;
 r.tasks.delegate(actor,parent,other.id,'独立した比較');const child=r.tasks.claim(admin)!,ca=r.agentSession(other.id);
 assert.equal(r.tasks.independentActivity(ca,child),true);
 assert.throws(()=>r.tasks.delegate(ca,child,leader.id,'連鎖禁止'));
 const count=r.tasks.list(admin).length;r.tasks.address(ca,child,leader.id,'受領');assert.equal(r.tasks.list(admin).length,count);
 let called=false;await r.tasks.externalOnce(ca,child,'send',{name:'send'},async()=>{called=true;return {};});assert.equal(called,false);
 r.tasks.finish(ca,child,'比較完了');const resumed=r.tasks.claim(admin)!;
 assert.throws(()=>r.tasks.delegate(actor,resumed,other.id,'同じ担当への追加依頼'));
});

test('new evidence clears stagnation; rereads and identical artifacts do not, and old artifacts stay immutable',async t=>{
 const {root,r,admin,leader,actor,room}=fixture(t);
 const {executeTurnTool,executeAsyncTurnTool}=await import('../src/runtime/turn-tools.ts');
 r.tasks.create(admin,leader.id,room.id,'保留');r.tasks.wait(actor,r.tasks.claim(admin)!,'waiting_user','承認待ち');
 const now=Date.now();r.autonomousWakes.dispatch(admin,now);r.autonomousWakes.dispatch(admin,now+60000);const first=r.tasks.claim(admin)!;
 const call={tool_call_id:'a',name:'artifact_create',arguments:{name:'比較',kind:'text',description:'人工検証',content:'新しい根拠'}};
 const created=executeTurnTool(r,actor,first,call,'create');r.tasks.rest(actor,first);r.autonomousWakes.dispatch(admin,now+120000);
 const db=new DatabaseSync(join(root,'control.db'),{readOnly:true});t.after(()=>db.close());
 assert.equal(db.prepare('SELECT stagnant FROM autonomous_wakes').get()!.stagnant,0);
 r.autonomousWakes.dispatch(admin,now+86400000);const next=r.tasks.claim(admin)!;
 assert.equal(executeTurnTool(r,actor,next,call,'repeat').reused,true);assert.equal(r.artifacts(admin).length,1);
 const edit=executeTurnTool(r,actor,next,{tool_call_id:'b',name:'artifact_revise',arguments:{id:created.id,expected_sha256:'0'.repeat(64),content:'改変'}},'edit');assert.ok(edit.error);
 const blocked=await executeAsyncTurnTool(r,actor,next,{tool_call_id:'s',name:'browser_form_submit',arguments:{}},'submit');assert.equal(blocked.error,'independent_activity_scope');assert.equal(r.approvals(admin).length,0);
 r.tasks.rest(actor,next);r.autonomousWakes.dispatch(admin,now+86400001);assert.equal(db.prepare('SELECT stagnant FROM autonomous_wakes').get()!.stagnant,1);
});

test('schema36 migration retains existing waits, administrator settings, personalities and memories',t=>{
 const {root,r,admin,leader,actor,room}=fixture(t);
 r.tasks.create(admin,leader.id,room.id,'維持する仕事');r.tasks.wait(actor,r.tasks.claim(admin)!,'waiting_user','具体的な入力待ち');
 const now=Date.now();r.autonomousWakes.dispatch(admin,now);
 const db=new DatabaseSync(join(root,'control.db'));
 const snapshot=()=>JSON.stringify(['tasks','settings','agents','approval_requests'].map(table=>db.prepare(`SELECT * FROM ${table}`).all()));
 const before=snapshot(),context=JSON.stringify(r.context(actor,room.id));
 db.exec('ALTER TABLE settings DROP COLUMN backup_enabled; DROP TABLE agent_autonomy; DROP TABLE response_progress; DROP TABLE provider_failures; DROP TABLE task_observations; DROP TABLE task_waits; DROP TABLE task_message_links; DROP TABLE task_context; DROP TABLE task_child_dependencies; DROP TABLE task_memory_skips; DROP TABLE task_activity; DROP TABLE prompt_runs; DROP TABLE task_prompt_versions; DROP TABLE artifact_evidence; DROP TABLE artifact_manifest; DROP TABLE artifact_quality; DROP TABLE task_quality; DROP TABLE quality_settings; ALTER TABLE artifact_reviews DROP COLUMN review_model; ALTER TABLE artifact_reviews DROP COLUMN checks; ALTER TABLE artifact_reviews DROP COLUMN evidence_revision; DROP TABLE initiative_evidence; DROP TABLE initiative_tasks; DROP TABLE initiatives; DROP TABLE initiative_settings; DROP TABLE execution_bindings; DROP TRIGGER retire_workarea_file; DROP TABLE retired_workarea_files; DROP TABLE task_workareas; DROP TABLE artifact_files; DROP TABLE artifact_audiences; DROP TABLE workarea_members; DROP TABLE workareas; DROP TABLE workarea_settings; DROP TABLE autonomous_boundaries; ALTER TABLE autonomous_wakes DROP COLUMN evidence; ALTER TABLE autonomous_wakes DROP COLUMN stagnant; PRAGMA user_version=36;');
 const reopened=new Runtime(root);try{
  assert.equal(db.prepare('PRAGMA user_version').get()!.user_version,46);assert.equal(snapshot(),before);
  assert.equal(JSON.stringify(reopened.context(reopened.agentSession(leader.id),room.id)),context);
  assert.equal(db.prepare('PRAGMA quick_check').get()!.quick_check,'ok');
 }finally{reopened.close();db.close();}
});
