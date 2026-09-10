import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {Runtime} from '../src/runtime/runtime.ts';
import {TurnRunner} from '../src/runtime/turns.ts';
import {executeTurnTool} from '../src/runtime/turn-tools.ts';
import {openAISubscriptionAdapterCapabilities} from '../src/providers/codex/adapter.ts';
import {isStatusInquiry} from '../src/runtime/conversation-work.ts';
function fixture(t:{after(fn:()=>void):void}){const root=mkdtempSync('/tmp/niwa-followup-'),r=new Runtime(root),admin=r.administrator(),a=r.bootstrap(admin),aa=r.agentSession(a.id),b=r.createAgent(aa,'人工担当'),room=r.createRoom(admin,'人工の案件');t.after(()=>{r.close();rmSync(root,{recursive:true,force:true});});return {root,r,admin,a,aa,b,room};}
test('status question reports running child of original work, with zero inquiry children and no model wait',t=>{
 const {r,admin,a,aa,b,room}=fixture(t);const parent=r.tasks.create(admin,a.id,room.id,'元の依頼');const lease=r.tasks.claim(admin)!;
 const child=r.tasks.delegate(aa,lease,b.id,'資料を照合');r.tasks.claim(admin)!;
 const start=performance.now();const answer=r.submit(admin,randomUUID(),room.id,'今誰が担当しているか？',a.id);
 assert.equal(answer.task?.state,'completed');assert.equal(r.tasks.get(admin,parent.id).state,'waiting_child');assert.equal(r.tasks.get(admin,child.id).state,'running');
 assert.equal(r.tasks.list(admin).filter(t=>t.parent_id===answer.task!.id).length,0);assert.equal(r.tasks.steps(aa,answer.task!.id).length,0);
 const reply=r.messages(admin,room.id).at(-1)!.body;assert.match(reply,/人工担当/);assert.match(reply,/資料を照合/);assert.match(reply,/作業中|状態を確認中/);
 assert.equal(r.tasks.list(admin).length,3);assert.ok(performance.now()-start<1000);
});
test('cancelled delegation is distinct from same bot doing independent activity; private rooms omitted',t=>{
 const {r,admin,a,aa,b,room}=fixture(t);const p=r.tasks.create(admin,a.id,room.id,'原依頼'),lease=r.tasks.claim(admin)!;const old=r.tasks.delegate(aa,lease,b.id,'取消対象');r.tasks.cancel(admin,old.id);
 const other=r.tasks.create(admin,b.id,room.id,'別の探究');r.tasks.pause(admin,p.id);r.tasks.claim(admin);
 const privateRoom=r.createRoom(admin,'別の個別',[a.id]);r.tasks.create(admin,a.id,privateRoom.id,'秘密の依頼文');
 const answer=r.submit(admin,randomUUID(),room.id,'担当状況',a.id);const body=r.messages(admin,room.id).at(-1)!.body;
 assert.match(body,/取消済み|取消/);assert.match(body,/別の探究/);assert.ok(!body.includes('秘密の依頼文'));assert.equal(r.tasks.get(admin,other.id).state,'running');assert.equal(answer.task!.state,'completed');
});
test('amend/cancel require exact target and execution revision, while status never resumes waiting work',t=>{
 const {r,admin,a,aa,room}=fixture(t);const task=r.tasks.create(admin,a.id,room.id,'仕事'),lease=r.tasks.claim(admin)!;
 r.tasks.wait(aa,lease,'waiting_user','具体的な入力');r.submit(admin,randomUUID(),room.id,'反応がない',a.id);assert.equal(r.tasks.get(admin,task.id).state,'waiting_user');
 assert.throws(()=>r.submit(admin,randomUUID(),room.id,'変更',a.id,undefined,{kind:'amend',task_id:task.id,expected_revision:0}),/refresh/);
 const current=r.tasks.get(admin,task.id);r.submit(admin,randomUUID(),room.id,'取り消してください',a.id,undefined,{kind:'cancel',task_id:task.id,expected_revision:r.tasks.controlRevision(admin,current.id)});assert.equal(r.tasks.get(admin,task.id).state,'cancelled');
 assert.equal(isStatusInquiry('誰が担当しているか調べて別のBotへ依頼して'),false);
});
test('structured intermediate report retains work and plan, restart and receipt replay do not publish twice',t=>{
 const {r,admin,a,aa,room}=fixture(t);const task=r.tasks.create(admin,a.id,room.id,'制作');const lease=r.tasks.claim(admin)!;
 const call={name:'task_report',tool_call_id:'report',arguments:{body:'下書きを確認しました。次に検査します。',next_action:'下書きの検査',expected_revision:0}};
 assert.equal(executeTurnTool(r,aa,lease,call,'report').continued,true);assert.equal(r.tasks.get(admin,task.id).state,'queued');
 r.tasks.recover(admin);const next=r.tasks.claim(admin)!;assert.equal(next.task.id,task.id);assert.deepEqual(r.tasks.workState(aa,next).remaining_plan.remaining,['下書きの検査']);
 executeTurnTool(r,aa,next,call,'report');assert.equal(r.messages(admin,room.id).length,1);r.respond(aa,next,'検査まで完了しました。',[]);assert.equal(r.tasks.get(admin,task.id).state,'completed');
});
test('malformed memory extraction is not saved or published and does not force a provider wait',async t=>{
 const {r,admin,a,aa,room}=fixture(t);r.post(admin,room.id,'短い回答をください');const task=r.tasks.create(admin,a.id,room.id,'回答');let calls=0;
 const runner=new TurnRunner(r,async()=>({adapter_id:'artificial',capabilities:openAISubscriptionAdapterCapabilities,async *run(request){calls++;yield {type:'text_delta' as const,text:request.tools[0]?.name==='memory_review'?'INVALID_PRIVATE_EXTRACTION':'回答です。'};yield {type:'completed' as const,finish_reason:'stop' as const};}}));
 await runner.run(r.tasks.claim(admin)!);assert.equal(r.tasks.get(admin,task.id).state,'completed');assert.equal(calls,2);assert.equal(r.memories(aa,a.id).length,0);assert.ok(!r.messages(admin,room.id).some(m=>m.body.includes('INVALID_PRIVATE')));
});
test('bot receives current conversation snapshot without access to another bots private memory',t=>{
 const {r,admin,a,aa,b,room}=fixture(t);r.tasks.create(admin,a.id,room.id,'主担当');const lease=r.tasks.claim(admin)!;const child=r.tasks.delegate(aa,lease,b.id,'実作業');r.tasks.claim(admin);
 const follow=r.tasks.create(admin,a.id,room.id,'追加の質問'),next=r.tasks.claim(admin)!;assert.equal(next.task.id,follow.id);
 const state=r.tasks.workState(aa,next);assert.equal(state.child_results.length,0);assert.ok(state.conversation_scope.tasks.some(t=>t.id===child.id&&t.state==='running'));assert.ok(!JSON.stringify(state.conversation_scope).includes('summary'));
});
test('required children block premature completion; explicitly independent children retain parent and budget lineage',t=>{
 const {r,admin,a,aa,b,room}=fixture(t);const parent=r.tasks.create(admin,a.id,room.id,'制作'),lease=r.tasks.claim(admin)!;r.tasks.address(aa,lease,b.id,'独立相談');const child=r.tasks.list(admin).find(t=>t.parent_id===parent.id)!;
 assert.throws(()=>r.respond(aa,lease,'完了'),/children/);const current=r.tasks.get(admin,child.id);
 r.tasks.childDisposition(aa,lease,child.id,'independent',r.tasks.controlRevision(admin,current.id));r.respond(aa,lease,'担当範囲は完了。相談は独立して継続します。',[]);
 assert.equal(r.tasks.get(admin,parent.id).state,'completed');assert.equal(r.tasks.get(admin,child.id).parent_id,parent.id);assert.equal(r.tasks.get(admin,child.id).state,'queued');
});
test('saved next action survives closing and reopening the artificial installation',t=>{
 const {root,r,admin,a,aa,room}=fixture(t);const task=r.tasks.create(admin,a.id,room.id,'長い制作'),lease=r.tasks.claim(admin)!;
 executeTurnTool(r,aa,lease,{name:'task_report',tool_call_id:'p',arguments:{body:'試作済み',next_action:'前回の試作を検査',expected_revision:0}},'p');r.close();
 const reopened=new Runtime(root);try{const admin2=reopened.administrator(),actor=reopened.agentSession(a.id),next=reopened.tasks.claim(admin2)!;assert.equal(next.task.id,task.id);assert.deepEqual(reopened.tasks.workState(actor,next).remaining_plan.remaining,['前回の試作を検査']);reopened.respond(actor,next,'検査済み',[]);assert.equal(reopened.tasks.get(admin2,task.id).state,'completed');}finally{reopened.close();}
});

test('answering a paused question retains the answer, message link and stop across restart',t=>{
 const {root,r,admin,a,aa,room}=fixture(t);
 const task=r.tasks.create(admin,a.id,room.id,'人工の制作'),lease=r.tasks.claim(admin)!;
 r.tasks.wait(aa,lease,'waiting_user','人工の色指定');r.tasks.pause(admin,task.id);
 const id=randomUUID(),answer=r.submit(admin,id,room.id,'青でお願いします',a.id);
 assert.equal(answer.task!.id,task.id);assert.equal(answer.task!.paused,1);
 assert.equal(answer.task!.state,'queued');assert.equal(r.tasks.claim(admin),undefined);
 assert.equal(r.tasks.replies(admin,task.id)[0]?.body,'青でお願いします');
 r.submit(admin,id,room.id,'青でお願いします',a.id);
 assert.equal(r.tasks.replies(admin,task.id).length,1);assert.equal(r.tasks.list(admin).length,1);
 r.close();const reopened=new Runtime(root);try{
  const admin2=reopened.administrator();reopened.tasks.recover(admin2);
  assert.equal(reopened.tasks.claim(admin2),undefined);assert.equal(reopened.tasks.replies(admin2,task.id).length,1);
  // Replying to the saved answer must still select the original work.
  reopened.submit(admin2,randomUUID(),room.id,'対象を変更します',a.id,answer.message.id,{kind:'amend',expected_revision:reopened.tasks.controlRevision(admin2,task.id)});
  assert.equal(reopened.tasks.get(admin2,task.id).paused,1);
  reopened.tasks.resume(admin2,task.id);assert.equal(reopened.tasks.claim(admin2)!.task.id,task.id);
 }finally{reopened.close();}
});

test('an explicit reply selects its waiting question even when another question exists',t=>{
 const {r,admin,a,aa,room}=fixture(t);
 const one=r.submit(admin,randomUUID(),room.id,'人工依頼A',a.id);
 r.tasks.wait(aa,r.tasks.claim(admin)!,'waiting_user','Aの入力');
 const two=r.submit(admin,randomUUID(),room.id,'人工依頼B',a.id,undefined,{kind:'new'});
 r.tasks.wait(aa,r.tasks.claim(admin)!,'waiting_user','Bの入力');
 const answer=r.submit(admin,randomUUID(),room.id,'Aの値です',a.id,one.message.id);
 assert.equal(answer.task!.id,one.task!.id);assert.equal(answer.task!.state,'queued');
 assert.equal(r.tasks.get(admin,two.task!.id).state,'waiting_user');assert.equal(r.tasks.list(admin).length,2);
 assert.equal(r.tasks.replies(admin,two.task!.id).length,0);
});

test('ambiguous replies and ordinary answers never choose or approve an unrelated wait',t=>{
 const {r,admin,a,aa,room}=fixture(t);
 const one=r.submit(admin,randomUUID(),room.id,'人工依頼A',a.id);
 r.tasks.wait(aa,r.tasks.claim(admin)!,'waiting_user','Aの入力');
 const two=r.submit(admin,randomUUID(),room.id,'人工依頼B',a.id,undefined,{kind:'new'});
 r.requestApproval(aa,r.tasks.claim(admin)!,'人工操作の許可','実際の送信はしない');
 const ambiguous=r.submit(admin,randomUUID(),room.id,'補足です',a.id);
 assert.notEqual(ambiguous.task!.id,one.task!.id);assert.notEqual(ambiguous.task!.id,two.task!.id);
 r.submit(admin,randomUUID(),room.id,'了解です',a.id,two.message.id);
 assert.equal(r.tasks.get(admin,one.task!.id).state,'waiting_user');
 assert.equal(r.tasks.get(admin,two.task!.id).state,'waiting_user');
 assert.equal(r.tasks.replies(admin,one.task!.id).length,0);assert.equal(r.tasks.replies(admin,two.task!.id).length,0);
 assert.equal(r.approvals(admin).length,1);
});

test('approving a paused operation records exact authorization without releasing its stop',t=>{
 const {r,admin,a,aa,room}=fixture(t);const task=r.tasks.create(admin,a.id,room.id,'人工承認'),lease=r.tasks.claim(admin)!;
 const action={destination:'synthetic',body:'artificial only'};
 assert.equal(r.authorizeAction(aa,lease,'synthetic-operation','人工操作',action),false);
 r.tasks.pause(admin,task.id);const version=String(r.approvals(admin)[0]!.version);
 r.decideApproval(admin,task.id,true,version);
 assert.equal(r.tasks.get(admin,task.id).paused,1);assert.equal(r.tasks.get(admin,task.id).state,'queued');
 assert.equal(r.tasks.claim(admin),undefined);assert.equal(r.approvals(admin).length,0);
 assert.equal(r.tasks.replies(admin,task.id).length,1);
 r.tasks.resume(admin,task.id);const resumed=r.tasks.claim(admin)!;
 assert.equal(resumed.task.id,task.id);assert.equal(r.authorizeAction(aa,resumed,'synthetic-operation','人工操作',action),true);
 assert.equal(r.authorizeAction(aa,resumed,'synthetic-operation','変更した人工操作',{...action,body:'changed'}),false);
});
