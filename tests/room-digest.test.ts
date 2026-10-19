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
import type {Message} from '../src/domain/types.ts';
import {mergeDigest,type DigestSource} from '../src/runtime/context/digest.ts';
import {composeDigestRoom} from '../src/runtime/context/room.ts';
import {emptyDigest,type DigestBody} from '../src/domain/room-digest.ts';

const call=(name:string,args:Record<string,unknown>):ModelEvent[]=>[{type:'tool_call',tool_call_id:name,name,arguments:args},{type:'completed',finish_reason:'tool_calls'}];
const room=(entries:[string,string][])=>new Map<string,DigestSource>(entries.map(([id,author],index)=>[id,{author_id:author,rowid:index+1}]));

test('a delta only changes what it names; the server decides authors and authority, and checks every source',()=>{
 const sources=room([['m1','administrator'],['m2','bot-a'],['m3','bot-b'],['m4','bot-a'],['m5','administrator'],['m6','bot-b'],['m7','bot-c'],['m8','bot-a']]);
 let body:DigestBody=emptyDigest();
 const first=mergeDigest(body,{add:[
  {section:'administrator',text:'毎週金曜に振り返る',sources:['m1']},
  {section:'administrator',text:'Botが言った指示',sources:['m2']},
  {section:'agreement',text:'第2案で進める',sources:['m2','m3']},
  {section:'agreement',text:'一人だけの合意',sources:['m4']},
  {section:'topic',text:'鍵は sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 です',sources:['m4']},
 ],update:[],resolve:[]},sources,0,4,1);
 assert.ok(!('rejectedAll' in first));body=first.body;
 assert.deepEqual(body.items.map(item=>[item.id,item.section,item.authors]),[['d1','administrator',['administrator']],['d2','topic',['bot-a']],['d3','agreement',['bot-a','bot-b']],['d4','decision',['bot-a']],['d5','topic',['bot-a']]]);
 assert.doesNotMatch(body.items[4]!.text,/sk-ant-api03-abcdef/);
 const before=JSON.stringify(body.items.find(item=>item.id==='d4'));
 const second=mergeDigest(body,{add:[{section:'topic',text:'新しい話題',sources:['m6']},{section:'topic',text:'まだ折りたたまれていない発言',sources:['m8']}],update:[
  {id:'d1',text:'毎週金曜の夕方に振り返る',sources:['m5']},
  {id:'d3',text:'当事者でないBotによる合意の書き換え',sources:['m7']},
 ],resolve:[{id:'d5',sources:['m5']}]},sources,4,7,2);
 assert.ok(!('rejectedAll' in second));
 assert.equal(second.applied,3);assert.equal(second.rejected,2,'a source past the cutoff, and an agreement update with no new source from its parties or the administrator');
 assert.equal(second.body.items.find(item=>item.id==='d1')!.text,'毎週金曜の夕方に振り返る');
 assert.equal(JSON.stringify(second.body.items.find(item=>item.id==='d4')),before,'unmentioned items are carried forward unchanged');
 assert.deepEqual(second.body.resolved.map(entry=>entry.id),['d5']);
 const stale=mergeDigest(second.body,{add:[],update:[{id:'d4',text:'古い根拠だけの更新',sources:['m4']}],resolve:[{id:'d2',sources:['m1']}]},sources,7,8,3);
 assert.ok('rejectedAll' in stale,'more than half invalid rejects the whole delta');
 const outsider=mergeDigest(second.body,{add:[{section:'topic',text:'よその発言',sources:['other-room']}],update:[],resolve:[]},sources,7,8,3);
 assert.ok('rejectedAll' in outsider);
});

test('a long digest keeps its size by turning the oldest items into cited stubs and then a counted range, administrator items last',()=>{
 const ids=Array.from({length:200},(_,i)=>[`m${i}`,i%10===0?'administrator':`bot-${i%3}`] as [string,string]);
 const sources=room(ids);let body=emptyDigest();
 for(let round=0;round<10;round++){
  const result=mergeDigest(body,{add:Array.from({length:20},(_,i)=>{const n=round*20+i;return {section:n%10===0?'administrator':n%4===0?'agreement':'topic',text:`項目${n}`+'あ'.repeat(250),sources:[`m${n}`]};}),update:[],resolve:[]},
   sources,round*20,round*20+20,round+1);
  assert.ok(!('rejectedAll' in result));body=result.body;
 }
 assert.ok(Buffer.byteLength(JSON.stringify(body))<=24_000);
 assert.ok(body.stubs.length<=60&&body.older_items!==null&&body.older_items.count>0);
 const kept=new Set([...body.items.map(item=>item.id),...body.stubs.map(stub=>stub.id)]);
 assert.equal(kept.size+body.older_items!.count,200,'every item is an item, a stub, or counted in the folded range');
 assert.ok(body.items.every(item=>item.section==='administrator'),'administrator items keep their full text longest');
 assert.deepEqual(body.notices,['compacted_authority']);
});

test('digest mode leaves out what the digest covers, keeps earlier administrator words and everything after the cutoff, and shows a review its unreviewed messages',()=>{
 const messages:Message[]=Array.from({length:60},(_,i)=>({id:`m${i}`,room_id:'r',author_id:i%15===0?'administrator':'bot',body:`発言${i}`,created_at:new Date(1_800_000_000_000+i).toISOString(),reply_to:null}));
 const rowids=messages.map((_m,i)=>i+1);
 const work=composeDigestRoom(messages,rowids,40);
 assert.deepEqual(work.selected.map(m=>m.id),['m0','m15','m30',...messages.slice(40).map(m=>m.id)]);
 assert.equal(work.reviewed_through,undefined);
 const review=composeDigestRoom(messages,rowids,40,{mark:'m29'});
 assert.deepEqual(review.selected.map(m=>m.id),['m0','m15',...messages.slice(30).map(m=>m.id)]);
 assert.equal(review.reviewed_through,'m59');
 const first=composeDigestRoom(messages,rowids,50,{mark:undefined});
 assert.deepEqual(first.selected.slice(0,2).map(m=>m.id),['m0','m10'],'a first review starts 40 messages before the cutoff');
 const long:Message[]=messages.map(m=>({...m,body:'い'.repeat(3000)}));
 const cut=composeDigestRoom(long,rowids,40,{mark:'m5'});
 assert.ok(cut.reviewed_through&&cut.reviewed_through!=='m59'&&Number(cut.reviewed_through.slice(1))<40,'a chunk cut by its budget moves the mark only to its end');
 const admin:Message[]=messages.map(m=>m.author_id==='administrator'?{...m,body:'う'.repeat(9000)}:m);
 const stubbed=composeDigestRoom(admin,rowids,40);
 assert.ok(stubbed.earlier_administrator.stubs.length>=1&&stubbed.earlier_administrator.stubs.every(stub=>stub.excerpt.length===160));
});

function fixture(t:{after(fn:()=>void):void}){
 const root=mkdtempSync(join(tmpdir(),'niwa-room-digest-')),r=new Runtime(root),admin=r.administrator(),a=r.bootstrap(admin),aa=r.agentSession(a.id);
 const b=r.createAgent(aa,'人工の聞き手'),space=r.createRoom(admin,'人工の長い会話');r.updateSettings(admin,{autonomous:false});
 t.after(()=>{r.close();rmSync(root,{recursive:true,force:true});});
 const control=(sql:string,...args:(string|number)[])=>{const db=new DatabaseSync(join(root,'control.db'));try{return db.prepare(sql).all(...args);}finally{db.close();}};
 return {r,admin,a,aa,b,room:space,control};
}
type Seen={phase:string;request:ModelRequest};
function runner(r:Runtime,mode:'full'|'shadow'|'digest',digest:(req:ModelRequest)=>ModelEvent[],reply:(req:ModelRequest)=>ModelEvent[]=()=>call('conversation_send',{body:'答えました。',recipient_ids:[]})){
 const seen:Seen[]=[];
 const turns=new TurnRunner(r,async()=>({adapter_id:'artificial',capabilities:openAISubscriptionAdapterCapabilities,async *run(req){
  const names=req.tools.map(tool=>tool.name),phase=names.includes('room_digest_save')?'room_digest':names.length===1?names[0]!:'work';seen.push({phase,request:req});
  yield* phase==='room_digest'?digest(req):phase==='memory_review'?call('memory_review',{memories:[]}):reply(req);
 }} satisfies ModelAdapter),{},{roomMode:mode});
 return {seen,one:(lease:Parameters<TurnRunner['run']>[0])=>turns.run(lease),run:async(admin:ReturnType<Runtime['administrator']>)=>{for(let lease=r.tasks.claim(admin);lease;lease=r.tasks.claim(admin))await turns.run(lease);}};
}
const folded=(req:ModelRequest)=>JSON.parse(req.messages[0]!.content!).room_digest_update as {messages_to_fold:{message_id:string;author_id:string}[];context_only:{message_id:string}[]};
const roomIds=(req:ModelRequest)=>req.messages.flatMap(m=>{try{const v=JSON.parse(m.content??'');return typeof v.message_id==='string'?[v.message_id as string]:[];}catch{return [];}});

test('shadow mode keeps a digest on the side without changing what Bots read; digest mode reads it in place of the older messages',async t=>{
 const {r,admin,a,aa,room,control}=fixture(t);
 const ids:string[]=[];
 for(let i=0;i<50;i++)ids.push(r.post(i%20===0?admin:aa,room.id,`人工の発言${i}`).id);
 const digest=(req:ModelRequest)=>{const input=folded(req);return call('room_digest_save',{add:[{section:'topic',text:'人工の発言を重ねてきた',sources:[input.messages_to_fold[1]!.message_id]},
  {section:'administrator',text:'管理者の最初の指示',sources:[input.messages_to_fold[0]!.message_id]}],update:[],resolve:[]});};
 const shadow=runner(r,'shadow',digest);
 const task=r.tasks.create(admin,a.id,room.id,'続けて');await shadow.run(admin);
 assert.deepEqual(shadow.seen.map(s=>s.phase),['room_digest','memory_review','work'],'the refresh comes first, once');
 const update=folded(shadow.seen[0]!.request);
 assert.equal(update.messages_to_fold.length,30,'short messages: the tail keeps 20');assert.deepEqual(update.context_only.map(m=>m.message_id),ids.slice(30,34));
 assert.deepEqual(roomIds(shadow.seen.at(-1)!.request),ids,'shadow mode still sends every message');
 const runs=control("SELECT phase,status FROM prompt_runs WHERE task_id=? ORDER BY id",task.id);
 assert.deepEqual(runs.map(row=>row.phase),['room_digest','memory_review','work']);
 assert.ok(r.tasks.steps(r.agentSession(a.id),task.id).every(step=>!JSON.stringify(step.events).includes('room_digest_save')),'the refresh is not a task step');
 const stored=r.digests.get(admin,room.id)!;
 assert.equal(stored.revision,1);assert.deepEqual(stored.body.items.map(item=>[item.section,item.authors]),[['topic',[a.id]],['administrator',['administrator']]]);

 const read=runner(r,'digest',()=>{throw new Error('not due again yet');});
 const now=r.messages(admin,room.id).map(m=>m.id);
 r.tasks.create(admin,a.id,room.id,'まとめを読んで続けて');await read.run(admin);
 const work=read.seen.find(s=>s.phase==='work')!.request;
 const block=JSON.parse(work.messages[0]!.content!).room_digest;
 assert.equal(block.revision,1);assert.equal(block.items.length,2);assert.equal(block.untrusted,true);
 assert.deepEqual(roomIds(work),[now[0]!,now[20]!,...now.slice(30)],'earlier administrator messages and everything after the cutoff');
});

test('a failed refresh leaves the digest as it was, waits before the next try, and the reply still goes out',async t=>{
 const {r,admin,a,aa,room,control}=fixture(t);
 for(let i=0;i<50;i++)r.post(aa,room.id,`人工の発言${i}`);
 const broken=runner(r,'digest',()=>[{type:'text_delta',text:'まとめられません'},{type:'completed',finish_reason:'stop'}]);
 const task=r.tasks.create(admin,a.id,room.id,'続けて');await broken.run(admin);
 assert.equal(r.tasks.get(admin,task.id).state,'completed');
 assert.equal(r.digests.get(admin,room.id),undefined);
 const claim=control('SELECT task_id,failures,retry_at FROM room_digest_claims WHERE room_id=?',room.id)[0]!;
 assert.equal(claim.task_id,null);assert.equal(claim.failures,1);assert.ok(Number(claim.retry_at)>Date.now()+9*60_000);
 r.tasks.create(admin,a.id,room.id,'もう一度');await broken.run(admin);
 assert.equal(broken.seen.filter(s=>s.phase==='room_digest').length,1,'no second try before retry_at');
});

test('a light Bot-to-Bot reply that refreshed the digest still posts without a handoff summary, and full mode never refreshes',async t=>{
 const {r,admin,a,aa,b,room}=fixture(t);
 for(let i=0;i<50;i++)r.post(aa,room.id,`人工の発言${i}`);
 const digest=(req:ModelRequest)=>call('room_digest_save',{add:[{section:'topic',text:'話題',sources:[folded(req).messages_to_fold[0]!.message_id]}],update:[],resolve:[]});
 const answer=(req:ModelRequest)=>JSON.parse(req.messages.at(-1)!.content!).work_state.task.conversation_reply?call('conversation_send',{body:'了解',recipient_ids:[]}):call('conversation_send',{body:'聞いて',recipient_ids:[b.id]});
 const full=runner(r,'full',digest,answer),reading=runner(r,'digest',digest,answer);
 r.tasks.create(admin,a.id,room.id,'聞き手に聞いて');
 await full.one(r.tasks.claim(admin)!);
 assert.equal(full.seen.filter(s=>s.phase==='room_digest').length,0,'full mode never refreshes');
 const reply=r.tasks.claim(admin)!;assert.equal(reply.task.agent_id,b.id);assert.equal(reply.task.conversation_reply,1);
 await reading.one(reply);
 assert.equal(reading.seen.filter(s=>s.phase==='room_digest').length,1);
 assert.equal(reading.seen.filter(s=>s.phase==='task_summary_save').length,0);
 assert.equal(r.tasks.get(admin,reply.task.id).state,'completed');
});

test('the administrator edits, deletes and resets digest items; a model cannot change an edited item; deleting the conversation removes the digest',async t=>{
 const {r,admin,a,aa,room,control}=fixture(t);
 for(let i=0;i<50;i++)r.post(aa,room.id,`人工の発言${i}`);
 let round=0;
 const builder=runner(r,'digest',req=>{const fold=folded(req).messages_to_fold;round++;
  return round===1?call('room_digest_save',{add:[{section:'topic',text:'最初の話題',sources:[fold[0]!.message_id]},{section:'decision',text:'消す項目の秘密の言い回し',sources:[fold[1]!.message_id]}],update:[],resolve:[]})
   :round===2?call('room_digest_save',{add:[],update:[{id:'d1',text:'モデルの書き換え',sources:[fold[0]!.message_id]}],resolve:[]})
   :call('room_digest_save',{add:[{section:'topic',text:'作り直した話題',sources:[fold[0]!.message_id]}],update:[],resolve:[]});});
 r.tasks.create(admin,a.id,room.id,'続けて');await builder.run(admin);
 assert.throws(()=>r.digests.edit(r.agentSession(a.id),room.id,'d1',{text:'Botの修正',section:'topic'}),/Administrator/);
 r.digests.edit(admin,room.id,'d1',{text:'管理者が直した話題',section:'decision'});
 r.digests.remove(admin,room.id,'d2');
 assert.ok(!control('SELECT body FROM room_digest_versions WHERE room_id=?',room.id).some(row=>String(row.body).includes('秘密の言い回し')),'removal scrubs every stored version');
 for(let i=0;i<50;i++)r.post(aa,room.id,`人工の続き${i}`);
 r.tasks.create(admin,a.id,room.id,'さらに続けて');await builder.run(admin);
 const item=r.digests.get(admin,room.id)!.body.items.find(entry=>entry.id==='d1')!;
 assert.equal(item.text,'管理者が直した話題');assert.equal(item.admin_edited,true);
 assert.deepEqual(new Set(r.digests.history(admin,room.id).map(row=>row.action)),new Set(['built','edited','deleted']));
 r.digests.reset(admin,room.id);assert.equal(r.digests.get(admin,room.id),undefined);
 r.tasks.create(admin,a.id,room.id,'作り直して');await builder.run(admin);
 assert.ok(r.digests.get(admin,room.id));
 r.deleteContent(admin,'room',room.id);
 assert.equal(control('SELECT count(*) n FROM room_digest_versions WHERE room_id=?',room.id)[0]!.n,0);
 assert.equal(control('SELECT count(*) n FROM room_digests WHERE room_id=?',room.id)[0]!.n,0);
});
