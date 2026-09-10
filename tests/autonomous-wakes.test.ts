import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Runtime} from '../src/runtime/runtime.ts';
import {DatabaseSync} from 'node:sqlite';
function fixture(t:{after(fn:()=>void):void}) {
 const root=mkdtempSync(join(tmpdir(),'niwa-wakes-')),r=new Runtime(root),admin=r.administrator(),leader=r.bootstrap(admin),actor=r.agentSession(leader.id);
 t.after(()=>{r.close();rmSync(root,{recursive:true,force:true});});
 return {root,r,admin,leader,actor};
}
test('zero schedules produce one durable wake; rest and restart retain the cooldown without messages',t=>{
 const {root,r,admin,leader,actor}=fixture(t),now=Date.now();
 r.autonomousWakes.dispatch(admin,now);assert.equal(r.tasks.list(admin).length,0);
 r.autonomousWakes.dispatch(admin,now+60000);assert.equal(r.schedules.list(admin).length,0);
 const lease=r.tasks.claim(admin)!;assert.equal(lease.task.agent_id,leader.id);
 assert.equal(r.tasks.workState(actor,lease).autonomous,true);
 r.autonomousWakes.dispatch(admin,now+120000);assert.equal(r.tasks.list(admin).length,1);
 r.tasks.rest(actor,lease);r.autonomousWakes.dispatch(admin,now+120001);
 const state=r.autonomousWakes.list(admin)[0]!;assert.equal(state.reason,'休息中');assert.ok(Number(state.next_at)>=now+3500000);
 assert.equal(r.messages(admin,lease.task.room_id).length,0);
 const reopen=new Runtime(root);try{reopen.autonomousWakes.dispatch(reopen.administrator(),now+180000);assert.equal(reopen.tasks.list(reopen.administrator()).length,1);assert.deepEqual(reopen.autonomousWakes.list(reopen.administrator()),r.autonomousWakes.list(admin));}finally{reopen.close();}
});
test('off, pause, dormancy, deletion and archived rooms forbid new wakes; manual work remains runnable',t=>{
 const {r,admin,leader,actor}=fixture(t),bot=r.createAgent(actor,'仲間'),room=r.createRoom(admin,'共有'),now=Date.now();
 r.autonomousWakes.dispatch(admin,now);r.updateSettings(admin,{autonomous:false});r.autonomousWakes.dispatch(admin,now+60000);assert.equal(r.tasks.list(admin).length,0);
 r.updateSettings(admin,{autonomous:true,paused:true});r.autonomousWakes.dispatch(admin,now+120000);assert.equal(r.tasks.list(admin).length,0);
 r.updateSettings(admin,{paused:false});r.setDormant(admin,bot.id,true);r.organizeRoom(admin,room.id,{archived:true});r.autonomousWakes.dispatch(admin,now+180000);assert.equal(r.tasks.list(admin).length,0);
 r.organizeRoom(admin,room.id,{archived:false});r.autonomousWakes.dispatch(admin,now+240000);assert.equal(r.tasks.list(admin).length,1);assert.equal(r.tasks.list(admin)[0]!.agent_id,leader.id);
 r.updateSettings(admin,{autonomous:false});assert.equal(r.tasks.claim(admin),undefined);
 const manual=r.tasks.create(admin,leader.id,room.id,'通常依頼');assert.equal(r.tasks.claim(admin)!.task.id,manual.id);
});
test('fair staggered opportunities, manual priority, and active-task recovery do not duplicate work',t=>{
 const {root,r,admin,leader,actor}=fixture(t),other=r.createAgent(actor,'仲間'),room=r.createRoom(admin,'共有'),now=Date.now();
 r.autonomousWakes.dispatch(admin,now);r.autonomousWakes.dispatch(admin,now+60000);r.autonomousWakes.dispatch(admin,now+60001);assert.equal(r.tasks.list(admin).length,1);
 const manual=r.tasks.create(admin,leader.id,room.id,'急ぎの通常依頼');const first=r.tasks.claim(admin)!;assert.equal(first.task.id,manual.id);r.tasks.finish(actor,first,'完了');
 const wake=r.tasks.claim(admin)!;r.autonomousWakes.dispatch(admin,now+120000);assert.equal(r.tasks.list(admin).filter(t=>t.agent_id===other.id).length,1);
 const pending=r.tasks.claim(admin)!;assert.equal(pending.task.agent_id,other.id);
 r.updateSettings(admin,{autonomous:false});assert.equal(r.tasks.active(actor,wake),false);assert.equal(r.tasks.active(r.agentSession(other.id),pending),false);
 const reopened=new Runtime(root);try{const a=reopened.administrator();reopened.tasks.recover(a);reopened.autonomousWakes.dispatch(a,now+180000);assert.equal(reopened.tasks.list(a).length,3);reopened.updateSettings(a,{autonomous:true});assert.ok(reopened.tasks.claim(a));}finally{reopened.close();}
});
test('public wake context excludes private memory, history and artifacts; failures back off',t=>{
 const {r,admin,leader,actor}=fixture(t),shared=r.createRoom(admin,'共有'),privateRoom=r.createRoom(admin,'個別',[leader.id]);
 const msg=r.post(admin,privateRoom.id,'private-canary');r.remember(actor,msg.id,'private-canary');
 r.tasks.create(admin,leader.id,privateRoom.id,'private-canary');r.tasks.finish(actor,r.tasks.claim(admin)!,'private-canary');
 const now=Date.now();r.autonomousWakes.dispatch(admin,now);r.autonomousWakes.dispatch(admin,now+60000);const lease=r.tasks.claim(admin)!;
 assert.equal(lease.task.room_id,shared.id);assert.ok(!JSON.stringify(r.context(actor,shared.id)).includes('private-canary'));assert.ok(!JSON.stringify(r.tasks.workState(actor,lease)).includes('private-canary'));
 r.tasks.expire(admin,lease.task.deadline_at+1);r.autonomousWakes.dispatch(admin,Date.now());assert.equal(r.autonomousWakes.list(admin)[0]!.reason,'失敗後の待機');
 r.autonomousWakes.dispatch(admin,now+120000);assert.equal(r.tasks.list(admin).length,2);
});
test('restored work disables fresh wakeups until explicit review, and deleted bots stay absent',t=>{
 const {root,r,admin,actor}=fixture(t),bot=r.createAgent(actor,'削除対象'),now=Date.now();
 r.autonomousWakes.dispatch(admin,now);
 r.applyAgentDeletions(admin,[{id:bot.id,deleted_at:now}]);
 assert.ok(!r.autonomousWakes.list(admin).some(row=>row.agent_id===bot.id));
 r.tasks.protectRestoredWork(admin);assert.equal(r.settings(admin).autonomous,false);
 r.autonomousWakes.dispatch(admin,now+60000);assert.equal(r.tasks.list(admin).length,0);
 const db=new DatabaseSync(join(root,'control.db'),{readOnly:true});try{assert.equal(db.prepare('PRAGMA user_version').get()!.user_version,46);}finally{db.close();}
});

test('a normal request interrupts an in-flight wake before claiming the same Bot again',async t=>{
 const {r,admin,actor}=fixture(t),now=Date.now();
 const {Scheduler}=await import('../src/runtime/scheduler.ts');
 r.autonomousWakes.dispatch(admin,now-60001);r.autonomousWakes.dispatch(admin,now);
 let started!:()=>void,aborted=false;const ready=new Promise<void>(resolve=>{started=resolve;});
 const scheduler=new Scheduler(r,{async run(lease,signal){
  if(lease.task.internal_autonomous){started();await new Promise<void>(resolve=>signal!.addEventListener('abort',()=>{aborted=true;resolve();},{once:true}));}
  else r.tasks.finish(actor,lease,'通常依頼を処理');
 }});
 t.after(()=>scheduler.stop());scheduler.tick();await ready;
 const initial=r.tasks.list(admin)[0]!;
 const manual=r.tasks.create(admin,initial.agent_id,initial.room_id,'優先するユーザー依頼');
 scheduler.tick();await new Promise(resolve=>setImmediate(resolve));assert.equal(aborted,true);
 scheduler.tick();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(r.tasks.get(admin,manual.id).state,'completed');assert.equal(r.tasks.get(admin,initial.id).state,'queued');
 assert.equal(r.tasks.list(admin).length,2);
});

test('wake and delegated work share a rolling call allowance and continue automatically instead of asking for count-limit approval',t=>{
 const {root,r,admin,actor}=fixture(t),other=r.createAgent(actor,'担当'),now=Date.now();
 r.autonomousWakes.dispatch(admin,now);r.autonomousWakes.dispatch(admin,now+60000);
 const parent=r.tasks.claim(admin)!;
 for(let i=0;i<23;i++)assert.equal(r.tasks.reserveModelCall(actor,parent),true);
 r.tasks.delegate(actor,parent,other.id,'資料を確認');const child=r.tasks.claim(admin)!,childActor=r.agentSession(other.id);
 assert.equal(r.tasks.reserveModelCall(childActor,child),true);assert.equal(r.tasks.reserveModelCall(childActor,child),false);
 const waiting=r.tasks.get(admin,child.task.id);assert.equal(waiting.state,'waiting_provider');assert.ok(waiting.provider_retry_at!>now);assert.equal(r.approvals(admin).length,0);
 r.updateSettings(admin,{autonomous:false});r.tasks.retryProviders(admin,waiting.provider_retry_at!);assert.equal(r.tasks.claim(admin),undefined);
 r.updateSettings(admin,{autonomous:true});const resumed=r.tasks.claim(admin)!;assert.equal(resumed.task.id,child.task.id);
 const db=new DatabaseSync(join(root,'control.db'));db.prepare('UPDATE autonomous_wakes SET budget_reset_at=?').run(Date.now()-1);db.close();
 assert.equal(r.tasks.reserveModelCall(childActor,resumed),true);
 assert.equal(r.tasks.list(admin).length,2);
});
test('pending approval stays held while a separate bounded activity can start',t=>{
 const {r,admin,actor}=fixture(t),now=Date.now();r.autonomousWakes.dispatch(admin,now);r.autonomousWakes.dispatch(admin,now+60000);
 const lease=r.tasks.claim(admin)!;
 assert.equal(r.authorizeAction(actor,lease,'0:0','人工送信',{url:'https://service.example/submit',method:'POST',body:'test'}),false);
 r.autonomousWakes.dispatch(admin,now+86400000);assert.equal(r.tasks.list(admin).length,2);
 assert.equal(r.tasks.workState(actor,r.tasks.claim(admin)!).independent_activity,true);
 assert.equal(r.tasks.get(admin,lease.task.id).state,'waiting_user');assert.notEqual(r.autonomousWakes.list(admin)[0]!.task_id,lease.task.id);
 const approval=r.approvals(admin)[0]!;r.decideApproval(admin,lease.task.id,false,String(approval.version));
 r.autonomousWakes.dispatch(admin);assert.equal(r.tasks.list(admin).length,2);
});

test('per-agent autonomy gates wakes and running leases while retaining manual work and persisted preference',t=>{
 const {root,r,admin,leader,actor}=fixture(t),other=r.createAgent(actor,'仲間'),room=r.createRoom(admin,'共有'),now=Date.now();
 assert.throws(()=>r.autonomousWakes.configure(actor,leader.id,false));
 r.autonomousWakes.configure(admin,leader.id,false);
 r.autonomousWakes.dispatch(admin,now);r.autonomousWakes.dispatch(admin,now+60000);
 assert.equal(r.tasks.list(admin).length,1);assert.equal(r.tasks.list(admin)[0]!.agent_id,other.id);
 const lease=r.tasks.claim(admin)!;
 r.autonomousWakes.configure(admin,other.id,false);
 assert.equal(r.tasks.claim(admin),undefined);
 assert.throws(()=>r.respond(r.agentSession(other.id),lease,'遅れて届いた返答'));
 const manual=r.tasks.create(admin,other.id,room.id,'ユーザーの依頼');
 assert.equal(r.tasks.claim(admin)!.task.id,manual.id);
 r.close();const reopened=new Runtime(root);
 try{assert.equal(reopened.autonomousWakes.list(reopened.administrator()).find(a=>a.agent_id===other.id)!.enabled,false);
 reopened.updateSettings(reopened.administrator(),{autonomous:false});reopened.autonomousWakes.configure(reopened.administrator(),leader.id,true);
 reopened.autonomousWakes.dispatch(reopened.administrator(),now+120000);assert.equal(reopened.tasks.list(reopened.administrator()).length,2);
 }finally{reopened.close();}
});

test('disabled ancestor reply does not block independent wakes or bypass held operations',t=>{
 const {root,r,admin,leader,actor}=fixture(t),other=r.createAgent(actor,'起点'),room=r.createRoom(admin,'共有'),now=Date.now();
 const origin=r.tasks.create(admin,other.id,room.id,'人工の自発起点');
 const reply=r.tasks.create(admin,leader.id,room.id,'人工の返信');
 const db=new DatabaseSync(join(root,'control.db'));
 try{
 db.prepare("UPDATE tasks SET internal_autonomous=1,state='waiting_user' WHERE id=?").run(origin.id);
 db.prepare('UPDATE tasks SET conversation_reply=1,parent_id=? WHERE id=?').run(origin.id,reply.id);
 r.autonomousWakes.configure(admin,other.id,false);
 assert.equal(r.tasks.claim(admin),undefined);
 r.autonomousWakes.dispatch(admin,now);r.autonomousWakes.dispatch(admin,now+60000);
 const lease=r.tasks.claim(admin)!;assert.ok(lease);assert.notEqual(lease.task.id,reply.id);assert.equal(lease.task.agent_id,leader.id);
 assert.ok(db.prepare('SELECT 1 FROM autonomous_boundaries WHERE task_id=?').get(lease.task.id));
 assert.equal(r.tasks.get(admin,reply.id).state,'queued');
 r.autonomousWakes.dispatch(admin,now+120000);assert.equal(r.tasks.list(admin).length,3);
 assert.equal(r.autonomousWakes.list(admin).find(row=>row.agent_id===leader.id)!.reason,'前回の活動を継続・待機中');
 }finally{db.close();}
});

test('blocked replies cannot repeatedly preempt a running independent wake',async t=>{
 const {root,r,admin,leader,actor}=fixture(t),other=r.createAgent(actor,'停止した起点'),room=r.createRoom(admin,'共有');
 const origin=r.tasks.create(admin,other.id,room.id,'人工起点'),reply=r.tasks.create(admin,leader.id,room.id,'保留返信');
 const db=new DatabaseSync(join(root,'control.db'));
 db.prepare("UPDATE tasks SET internal_autonomous=1,state='waiting_user' WHERE id=?").run(origin.id);
 db.prepare('UPDATE tasks SET conversation_reply=1,parent_id=? WHERE id=?').run(origin.id,reply.id);db.close();
 r.autonomousWakes.configure(admin,other.id,false);
 const now=Date.now();r.autonomousWakes.dispatch(admin,now-61000);r.autonomousWakes.dispatch(admin,now);
 const {Scheduler}=await import('../src/runtime/scheduler.ts');let runs=0,aborts=0;
 const scheduler=new Scheduler(r,{async run(_lease,signal){runs++;await new Promise<void>(resolve=>signal!.addEventListener('abort',()=>{aborts++;resolve();},{once:true}));}});
 try{
 scheduler.tick();await new Promise(resolve=>setImmediate(resolve));
 for(let i=0;i<4;i++){scheduler.tick();await new Promise(resolve=>setImmediate(resolve));}
 assert.equal(runs,1);assert.equal(aborts,0);assert.equal(r.tasks.get(admin,reply.id).state,'queued');
 r.tasks.create(admin,leader.id,room.id,'本当のユーザー依頼');scheduler.tick();await new Promise(resolve=>setImmediate(resolve));assert.equal(aborts,1);
 }finally{await scheduler.stop();}
});

test('wake status exposes the actual budget reset instead of an overdue wake time',t=>{
 const {root,r,admin}=fixture(t),now=Date.now();r.autonomousWakes.dispatch(admin,now);
 const db=new DatabaseSync(join(root,'control.db'));db.prepare('UPDATE autonomous_wakes SET model_calls=24,budget_reset_at=?,next_at=?').run(now+3600000,now-60000);db.close();
 const row=r.autonomousWakes.list(admin)[0]!;assert.equal(row.reason,'自発活動の利用枠待ち');assert.equal(row.next_at,now+3600000);
});
