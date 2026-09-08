import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Runtime} from '../src/runtime/runtime.ts';
import {executeTurnTool} from '../src/runtime/turn-tools.ts';
import {isAcknowledgment} from '../src/domain/coordination.ts';
function fixture(t:{after(fn:()=>void):void}) {
 const root=mkdtempSync(join(tmpdir(),'niwa-coordination-')),r=new Runtime(root),admin=r.administrator(),leader=r.bootstrap(admin),actor=r.agentSession(leader.id),bot=r.createAgent(actor,'担当'),other=r.createAgent(actor,'別担当'),room=r.createRoom(admin,'共同作業');
 t.after(()=>{r.close();rmSync(root,{recursive:true,force:true});});return {root,r,admin,leader,actor,bot,other,room};
}
test('acknowledgment adds a reaction without another message or task, while substantive replies survive',t=>{
 const f=fixture(t),{r,admin,leader,bot,actor,room}=f;
 r.tasks.create(admin,leader.id,room.id,'会話');const parent=r.tasks.claim(admin)!;
 r.respond(actor,parent,'資料を確認しました。返信は不要です。',[bot.id]);
 const lease=r.tasks.claim(admin)!;r.respond(r.agentSession(bot.id),lease,'了解しました。状態を維持します。',[leader.id]);
 assert.equal(r.messages(admin,room.id).length,1);assert.equal(r.tasks.list(admin).length,2);
 assert.equal(r.tasks.get(admin,lease.task.id).state,'completed');assert.equal(r.acknowledgments(admin,room.id)[0]!.agent_id,bot.id);
 assert.equal(r.updates(admin).filter(row=>row.task_id===lease.task.id).length,0);
 assert.ok(isAcknowledgment('受領しました。ありがとうございます。'));assert.ok(!isAcknowledgment('受領しました。入力データを変更してください。'));
 r.tasks.create(admin,leader.id,room.id,'別の会話');r.respond(actor,r.tasks.claim(admin)!,'変更の確認',[bot.id]);
 r.respond(r.agentSession(bot.id),r.tasks.claim(admin)!,'確認しました。値を42へ変更しました。',[]);
 assert.match(r.messages(admin,room.id).at(-1)!.body,/42/);
});
test('acknowledgment cannot finish delegated work or hide an artifact result',t=>{
 const {r,admin,leader,actor,bot,room}=fixture(t);
 r.tasks.create(admin,leader.id,room.id,'制作');const parent=r.tasks.claim(admin)!;
 r.tasks.delegate(actor,parent,bot.id,'納品物を作る');const child=r.tasks.claim(admin)!;
 assert.throws(()=>r.tasks.acknowledge(r.agentSession(bot.id),child),/Assigned work/);
 assert.equal(r.tasks.get(admin,child.task.id).state,'running');
});
test('coordination is room scoped, blocks retries, notifies only involved participants and does not duplicate after resume',t=>{
 const {r,admin,leader,actor,bot,other,room,root}=fixture(t);
 const privateRoom=r.createRoom(admin,'私的な会話',[leader.id]);r.tasks.create(admin,leader.id,privateRoom.id,'private fixture');
 const privateLease=r.tasks.claim(admin)!;r.tasks.finish(actor,privateLease,'private result');
 r.tasks.create(admin,leader.id,room.id,'共同依頼');const parent=r.tasks.claim(admin)!;
 r.tasks.delegate(actor,parent,bot.id,'データを処理する');let child=r.tasks.claim(admin)!;const childActor=r.agentSession(bot.id);
 const input={expected_revision:0,completion_condition:'CSVを作成',stop_condition:'入力がない',blocker:'入力データ待ち',waiting_for:leader.id,next_agent_id:leader.id,notify:'involved' as const};
 executeTurnTool(r,childActor,child,{name:'task_status_update',tool_call_id:'block',arguments:input},'0:0');
 assert.equal(r.tasks.get(admin,child.task.id).state,'waiting_user');
 assert.equal(r.tasks.list(admin).filter(task=>task.conversation_reply===1).length,1);
 const notification=r.tasks.claim(admin)!;assert.equal(notification.task.agent_id,leader.id);assert.notEqual(notification.task.agent_id,other.id);
 r.tasks.acknowledge(actor,notification);assert.equal(r.tasks.claim(admin),undefined);
 const rows=r.coordination(childActor,room.id);assert.ok(!JSON.stringify(rows).includes('private fixture'));
 assert.throws(()=>r.coordination(childActor,privateRoom.id),/unavailable/);
 const before=r.messages(admin,room.id).length;
 r.tasks.resume(admin,child.task.id);child=r.tasks.claim(admin)!;
 r.updateCoordination(childActor,child,{...input,expected_revision:1});
 assert.equal(r.messages(admin,room.id).length,before);
 const reopened=new Runtime(root);try{assert.equal(reopened.coordination(reopened.administrator(),room.id).find(row=>row.id===child.task.id)!.blocker,'入力データ待ち');}finally{reopened.close();}
});

test('leader escalation does not disclose a private task to a nonparticipant',t=>{
 const {r,admin,leader,bot,other}=fixture(t);
 const room=r.createRoom(admin,'参加者だけ',[bot.id,other.id]);
 r.tasks.create(admin,bot.id,room.id,'private operation');const lease=r.tasks.claim(admin)!;
 r.updateCoordination(r.agentSession(bot.id),lease,{expected_revision:0,completion_condition:'限定の成果物',stop_condition:'入力待ち',blocker:'private blocker',waiting_for:other.id,next_agent_id:other.id,notify:'leader'});
 const notifications=r.tasks.list(admin).filter(task=>task.conversation_reply===1);
 assert.equal(notifications.length,1);assert.equal(notifications[0]!.agent_id,other.id);
 assert.throws(()=>r.coordination(r.agentSession(leader.id),room.id),/unavailable/);
 assert.equal(r.messages(admin,room.id).length,1);
});
