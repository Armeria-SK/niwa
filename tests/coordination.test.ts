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

test('planned next owners never dispatch work; one explicit fixed-version handoff completes revision, review and freeze',t=>{
 const {r,admin,leader,actor,bot,other,room}=fixture(t);
 const started=Date.now();r.tasks.create(admin,leader.id,room.id,'期限：20分。文書を作成し確認に渡す');const lease=r.tasks.claim(admin)!;
 assert.ok(lease.task.deadline_at>=started+1199000 && lease.task.deadline_at<=Date.now()+1200000);
 const fields={completion_condition:'固定版の内容確認',stop_condition:'入力不足',blocker:'',waiting_for:null,next_agent_id:bot.id,notify:'involved' as const};
 r.updateCoordination(actor,lease,{...fields,expected_revision:0});r.updateCoordination(actor,lease,{...fields,next_agent_id:other.id,expected_revision:1});r.updateCoordination(actor,lease,{...fields,expected_revision:2});
 assert.equal(r.tasks.list(admin).length,1);assert.equal(r.messages(admin,room.id).length,0);
 assert.equal(r.tasks.acknowledgeWork(actor,lease).state,'running');assert.equal(r.tasks.get(admin,lease.task.id).state,'running');
 assert.throws(()=>r.handoff(actor,lease,'内容を確認する'),/not ready/);
 const original=r.createArtifact(actor,room.id,'handoff.txt','文書','人工の受入','version one',lease.task.id);
 const first=r.artifactVersions.inspect(actor,original);
 const revised=r.artifactVersions.revise(actor,original,first.sha256,'version two',lease.task.id);
 assert.throws(()=>r.reviewReady(actor,lease,original,first.sha256),/latest/);
 assert.throws(()=>r.reviewReady(actor,lease,revised.id,'0'.repeat(64)),/latest/);
 r.reviewReady(actor,lease,revised.id,revised.sha256);assert.equal(r.tasks.list(admin).length,1);
 const handoff=r.handoff(actor,lease,'固定版を読み、値がversion twoであることを確認する');assert.equal(r.tasks.list(admin).length,2);
 const child=r.tasks.claim(admin)!;assert.equal(child.task.id,handoff.task_id);assert.equal(child.task.agent_id,bot.id);
 const childActor=r.agentSession(bot.id);r.tasks.acknowledgeWork(childActor,child);
 const inspected=r.artifactVersions.reference(childActor,revised.id,child.task.id);assert.equal(inspected.content,'version two');
 assert.match(r.messages(admin,room.id)[0]!.body,/review_ready/);assert.ok(r.messages(admin,room.id)[0]!.body.includes(revised.sha256));
 r.updateCoordination(childActor,child,{...fields,next_agent_id:leader.id,expected_revision:0});assert.equal(r.tasks.list(admin).length,2);
 r.artifactVersions.review(childActor,revised.id,revised.sha256,'approved','version twoを確認');r.tasks.finish(childActor,child,'固定版の確認完了');
 const resumed=r.tasks.claim(admin)!;r.artifactVersions.freeze(actor,revised.id,revised.sha256);
 assert.equal(r.handoff(actor,resumed,'同じ成果物の重複依頼').task_id,child.task.id);assert.equal(r.tasks.list(admin).length,2);
 assert.equal(r.artifactVersions.inspect(actor,original).content,'version one');assert.equal(r.artifactVersions.inspect(actor,revised.id).frozen,1);
 r.tasks.finish(actor,resumed,'改訂・レビュー・凍結まで完了');
 assert.ok(r.tasks.create(admin,leader.id,room.id,'20分の動画の内容を調べる').deadline_at>Date.now()+86400000);
 assert.ok(r.tasks.create(admin,leader.id,room.id,'0.5時間以内の表現を確認').deadline_at>Date.now()+86400000);
});
