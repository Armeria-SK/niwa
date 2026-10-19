import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Runtime} from '../src/runtime/runtime.ts';
import {TurnRunner} from '../src/runtime/turns.ts';
import {openAISubscriptionAdapterCapabilities} from '../src/providers/codex/adapter.ts';
import type {ModelAdapter} from '../src/providers/shared/adapter.ts';
import type {ModelRequest,ModelEvent} from '../src/contracts/model.ts';
import type {Agent} from '../src/domain/types.ts';

const call=(name:string,args:Record<string,unknown>):ModelEvent[]=>[{type:'tool_call',tool_call_id:name,name,arguments:args},{type:'completed',finish_reason:'tool_calls'}];
const send=(body:string,recipient_ids:string[])=>call('conversation_send',{body,recipient_ids});
type Phase='memory_review'|'task_summary_save'|'work';
type Entry={agent:string;phase:Phase;task:string;messages:string[]};
const phaseOf=(req:ModelRequest):Phase=>req.tools.length===1&&(req.tools[0]!.name==='memory_review'||req.tools[0]!.name==='task_summary_save')?req.tools[0]!.name:'work';
const summary=(req:ModelRequest)=>{const state=JSON.parse(req.messages.at(-1)!.content!).work_state;
 return call('task_summary_save',{conclusion:'人工の確認を終えた。',reason:'会話の記録による。',unresolved:[],next_steps:[],
  sources:state.summary_sources.map(({kind,source_id,revision}:{kind:string;source_id:string;revision:string})=>({kind,source_id,revision}))});};
/** Room message ids the request showed, whichever prompt version laid them out. */
const shown=(req:ModelRequest)=>req.messages.flatMap(m=>{try{const v=JSON.parse(m.content??'');return typeof v.message_id==='string'?[v.message_id as string]:[];}catch{return [];}});

function fixture(t:{after(fn:()=>void):void}){
 const root=mkdtempSync(join(tmpdir(),'niwa-light-replies-')),r=new Runtime(root),admin=r.administrator(),a=r.bootstrap(admin),aa=r.agentSession(a.id);
 const b=r.createAgent(aa,'人工の聞き手'),room=r.createRoom(admin,'人工の共同体');
 r.updateSettings(admin,{autonomous:false});
 t.after(()=>{r.close();rmSync(root,{recursive:true,force:true});});
 const control=(sql:string,...args:(string|number)[])=>{const db=new DatabaseSync(join(root,'control.db'));try{return db.prepare(sql).all(...args);}finally{db.close();}};
 return {root,r,admin,a,aa,b,room,control};
}
/** Each Bot answers from a script; every call is logged with its phase and the room messages it showed. */
function runner(r:Runtime,version:'legacy-v4'|'structured-v5',script:(agent:Agent,req:ModelRequest,step:number)=>ModelEvent[],review:(agent:Agent,req:ModelRequest)=>ModelEvent[]=()=>call('memory_review',{memories:[]})){
 const log:Entry[]=[];const steps=new Map<string,number>();
 const turns=new TurnRunner(r,async agent=>({adapter_id:'artificial',capabilities:openAISubscriptionAdapterCapabilities,async *run(req){
  const task=String(JSON.parse(req.messages.at(-1)!.content!).work_state.task.id),phase=phaseOf(req);log.push({agent:agent.id,phase,task,messages:shown(req)});
  if(phase==='memory_review'){yield* review(agent,req);return;}
  if(phase==='task_summary_save'){yield* summary(req);return;}
  const step=steps.get(task)??0;steps.set(task,step+1);yield* script(agent,req,step);
 }} satisfies ModelAdapter),{},{promptVersion:version});
 const drain=async(admin:ReturnType<Runtime['administrator']>)=>{for(let lease=r.tasks.claim(admin);lease;lease=r.tasks.claim(admin))await turns.run(lease);};
 return {log,drain};
}
const count=(log:Entry[],agent:string,phase:Phase)=>log.filter(entry=>entry.agent===agent&&entry.phase===phase).length;
const reviewsOf=(log:Entry[],...agents:Agent[])=>agents.map(agent=>count(log,agent.id,'memory_review'));
const summariesOf=(log:Entry[],task:string)=>log.filter(entry=>entry.task===task&&entry.phase==='task_summary_save').length;

/** a and b take turns; `turns` replies are addressed onward, after which the speaker addresses nobody. */
function conversation(a:Agent,b:Agent){
 let left=0;
 return {say:(n:number)=>{left=n;},script:(agent:Agent)=>send(`${agent.name}の返事`,left-->0?[agent.id===a.id?b.id:a.id]:[])};
}

for (const version of ['legacy-v4','structured-v5'] as const) {
 test(`${version}: a Bot-to-Bot reply that only looked things up posts without a handoff summary; an assigned task still writes one`,async t=>{
  const {r,admin,a,b,room}=fixture(t);
  const {log,drain}=runner(r,version,(agent,_req,step)=>step===0?call('history_search',{query:'人工の手順'})
   :send(agent.id===a.id?'手順の案を読んだよ。どう思う？':'読んだ範囲では賛成です。',agent.id===a.id?[b.id]:[]));
  r.post(admin,room.id,'人工の手順について聞き手と話して');const assigned=r.tasks.create(admin,a.id,room.id,'人工の手順について聞き手と話して');
  await drain(admin);
  const reply=r.tasks.list(admin).find(task=>task.agent_id===b.id)!;
  assert.equal(reply.conversation_reply,1);
  assert.equal(summariesOf(log,assigned.id),1);
  assert.equal(summariesOf(log,reply.id),0);
  assert.ok(r.tasks.list(admin).every(task=>task.state==='completed'));
  assert.deepEqual(r.messages(admin,room.id).map(m=>m.body),['人工の手順について聞き手と話して','@人工の聞き手 手順の案を読んだよ。どう思う？','読んだ範囲では賛成です。']);
 });

 test(`${version}: a reply writes a handoff summary after a fifth lookup or any tool beyond lookups, but never for the tools it was already exempt from`,async t=>{
  const {r,admin,a,b,room}=fixture(t);
  // Each of b's replies follows one plan; the step index walks through it and the last step answers.
  const plans:ModelEvent[][][]=[
   [...Array.from({length:4},(_,i)=>call('history_search',{query:`人工${i}`})),send('四回調べた結果です。',[a.id])],
   [...Array.from({length:5},(_,i)=>call('history_search',{query:`人工${i}`})),send('五回調べた結果です。',[a.id])],
   [...Array.from({length:6},(_,i)=>call('memory_search',{query:`人工${i}`})),send('記憶を探しました。',[a.id])],
   [call('decision_report',{title:'人工の判断',detail:'新版を基準にする'}),send('判断を記録しました。',[])],
  ];
  let reply=-1;
  const {log,drain}=runner(r,version,(agent,_req,step)=>{
   if(agent.id===a.id)return send('次も確かめてほしい。',[b.id]);
   if(step===0)reply++;
   return plans[reply]![step]!;
  });
  r.post(admin,room.id,'聞き手に確かめてもらう');r.tasks.create(admin,a.id,room.id,'聞き手に確かめてもらう');
  await drain(admin);
  const replies=r.tasks.list(admin).filter(task=>task.agent_id===b.id);
  assert.equal(replies.length,4);
  assert.deepEqual(replies.map(task=>summariesOf(log,task.id)),[0,1,0,1]);
  assert.ok(r.tasks.list(admin).every(task=>task.state==='completed'));
 });

 test(`${version}: messages a deferred review skipped are shown to the next review even after they left the recent window`,async t=>{
  const {r,admin,a,aa,b,room}=fixture(t);const c=conversation(a,b);
  const {log,drain}=runner(r,version,agent=>c.script(agent));
  r.post(admin,room.id,'聞き手と話して');
  c.say(1);r.tasks.create(admin,a.id,room.id,'聞き手と話して');await drain(admin);
  // b's first reply reviewed. A few agreements arrive, and b's next reply, in the middle of an exchange, defers its review.
  const agreements=[0,1,2,3,4].map(i=>r.post(aa,room.id,`人工の合意${i}`).id);
  c.say(2);r.tasks.create(admin,a.id,room.id,'合意を伝えて');await drain(admin);
  const deferred=r.tasks.list(admin).filter(task=>task.agent_id===b.id).at(-1)!;
  assert.equal(log.some(entry=>entry.task===deferred.id&&entry.phase==='memory_review'),false);
  // Thirty more messages push the agreements out of the recent 24 before b's next review.
  for(let i=0;i<30;i++)r.post(aa,room.id,`人工の雑談${i}`);
  c.say(1);r.tasks.create(admin,a.id,room.id,'もう一度聞き手と');await drain(admin);
  const review=log.filter(entry=>entry.agent===b.id&&entry.phase==='memory_review').at(-1)!;
  assert.ok(agreements.every(id=>review.messages.includes(id)),'every message since the last saved review is shown, beyond the recent 24');
 });
}

test('the reply that ends an exchange reviews what earlier replies deferred; replies in the middle do not review',async t=>{
 const {r,admin,a,b,room,control}=fixture(t);const c=conversation(a,b);
 const {log,drain}=runner(r,'legacy-v4',agent=>c.script(agent));
 r.post(admin,room.id,'聞き手と話して');
 // a (assigned) -> b (first reply in the room) -> a (mid) -> b (mid) -> a (ends)
 c.say(4);r.tasks.create(admin,a.id,room.id,'聞き手と話して');await drain(admin);
 assert.deepEqual(reviewsOf(log,a,b),[2,1]);
 const tasks=r.tasks.list(admin);
 const last=tasks.at(-1)!;assert.equal(last.agent_id,a.id);
 assert.equal(log.filter(entry=>entry.task===last.id).map(entry=>entry.phase).join(),'work,memory_review');
 assert.equal(Number(control('SELECT count(*) n FROM task_memory_skips')[0]!.n),3);
 // The closing review saw everything up to the last answer it is about to give.
 const messages=r.messages(admin,room.id);
 assert.deepEqual(log.filter(entry=>entry.task===last.id&&entry.phase==='memory_review')[0]!.messages,messages.slice(0,-1).map(m=>m.id));
 assert.ok(tasks.every(task=>task.state==='completed'));
});

test('replies review again after an administrator message, at exactly eight new messages, or after six quiet hours',async t=>{
 const {r,admin,a,aa,b,room,control}=fixture(t);const c=conversation(a,b);
 const {log,drain}=runner(r,'legacy-v4',agent=>c.script(agent));
 const aReviews=()=>count(log,a.id,'memory_review');
 r.post(admin,room.id,'話して');
 // Each round: b is assigned and addresses a, a answers b mid-exchange, b ends. Only a's middle reply is under test.
 const round=async()=>{c.say(2);r.tasks.create(admin,b.id,room.id,'話を続けて');await drain(admin);};
 const since=()=>{const mark=Number(control('SELECT message_rowid FROM memory_review_marks WHERE agent_id=? AND room_id=?',a.id,room.id)[0]!.message_rowid);
  return Number(control('SELECT count(*) n FROM messages WHERE room_id=? AND rowid>?',room.id,mark)[0]!.n);};
 const topUp=async(to:number)=>{for(let n=since();n<to;n++)r.post(aa,room.id,`人工の雑談${n}`);assert.equal(since(),to);};
 await round();assert.equal(aReviews(),1,'a first reply in the room reviews');
 await round();assert.equal(aReviews(),1,'a few messages later it defers');
 r.post(admin,room.id,'人工の新しい方針');
 await round();assert.equal(aReviews(),2,'an administrator message makes it due');
 await topUp(6);await round();assert.equal(aReviews(),2,'seven new messages (six plus the one from b) still defer');
 r.post(admin,room.id,'人工の方針の続き');await round();assert.equal(aReviews(),3);
 await topUp(7);await round();assert.equal(aReviews(),4,'eight new messages (seven plus the one from b) make it due');
 control('UPDATE memory_review_marks SET reviewed_at=reviewed_at-5*3600000 WHERE agent_id=?',a.id);
 await round();assert.equal(aReviews(),4,'five quiet hours are not yet enough');
 control('UPDATE memory_review_marks SET reviewed_at=reviewed_at-2*3600000 WHERE agent_id=?',a.id);
 await round();assert.equal(aReviews(),5,'after six hours anything new is reviewed');
 assert.ok(r.tasks.list(admin).every(task=>task.state==='completed'));
});

test('a review whose result was not saved does not count: an unusable answer or a memory correction during review leaves the next reply due',async t=>{
 const {r,admin,a,b,room}=fixture(t);const c=conversation(a,b);
 const source=r.post(admin,room.id,'話して');
 const old=r.remember(r.agentSession(b.id),source.id,'訂正前の記憶');
 let mode:'invalid'|'correct'|'ok'='invalid';
 const {log,drain}=runner(r,'legacy-v4',agent=>c.script(agent),agent=>{
  if(agent.id!==b.id)return call('memory_review',{memories:[]});
  if(mode==='invalid'){mode='correct';return [{type:'text_delta',text:'整理できませんでした'},{type:'completed',finish_reason:'stop'}];}
  if(mode==='correct'){mode='ok';r.correctMemory(admin,b.id,old.id,1,'訂正後の記憶');return call('memory_review',{memories:[]});}
  return call('memory_review',{memories:[]});
 });
 // b's first reply: the review answer is unusable, so nothing is saved and no mark is set.
 c.say(2);r.tasks.create(admin,a.id,room.id,'聞き手と話して');await drain(admin);
 const bReplies=()=>r.tasks.list(admin).filter(task=>task.agent_id===b.id);
 assert.equal(log.filter(entry=>entry.task===bReplies()[0]!.id&&entry.phase==='memory_review').length,1);
 // b's next reply is therefore still due; a correction during that review drops it, and it is asked again.
 c.say(2);r.tasks.create(admin,a.id,room.id,'もう一度');await drain(admin);
 const second=bReplies()[1]!;
 assert.equal(log.filter(entry=>entry.task===second.id&&entry.phase==='memory_review').length,2);
 assert.ok(r.tasks.list(admin).every(task=>task.state==='completed'));
});

test('review marks are kept per conversation: a Bot\'s first reply in another conversation reviews',async t=>{
 const {r,admin,a,b,room}=fixture(t);const c=conversation(a,b);
 const other=r.createRoom(admin,'人工の別室');r.post(admin,other.id,'別室の話');
 const {log,drain}=runner(r,'legacy-v4',agent=>c.script(agent));
 r.post(admin,room.id,'話して');
 c.say(1);r.tasks.create(admin,a.id,room.id,'聞き手と話して');await drain(admin);
 assert.equal(count(log,b.id,'memory_review'),1);
 c.say(1);r.tasks.create(admin,a.id,other.id,'別室で聞き手と');await drain(admin);
 assert.equal(count(log,b.id,'memory_review'),2);
});
