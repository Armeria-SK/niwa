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

function fixture(t:{after(fn:()=>void):void}){
 const root=mkdtempSync(join(tmpdir(),'niwa-lean-state-')),r=new Runtime(root),admin=r.administrator(),a=r.bootstrap(admin),aa=r.agentSession(a.id);
 const room=r.createRoom(admin,'人工の長い会話');r.updateSettings(admin,{autonomous:false});
 t.after(()=>{r.close();rmSync(root,{recursive:true,force:true});});
 const control=(sql:string,...args:(string|number)[])=>{const db=new DatabaseSync(join(root,'control.db'));try{return db.prepare(sql).run(...args);}finally{db.close();}};
 return {r,admin,a,aa,room,control};
}

test('model input lists open work and recently finished work, and only counts older finished work; the status reply keeps the long list',t=>{
 const {r,admin,a,room,control}=fixture(t);
 const now=Date.now();
 for(let i=0;i<24;i++)r.tasks.create(admin,a.id,room.id,`人工の未完了${i}`+'あ'.repeat(300));
 const finished=(state:string,count:number,minutesAgo:number,label:string)=>{for(let i=0;i<count;i++){const task=r.tasks.create(admin,a.id,room.id,`${label}${i}`);
  control('UPDATE tasks SET state=?,updated_at=? WHERE id=?',state,now-minutesAgo*60_000-i,task.id);}};
 finished('completed',10,5,'人工の最近の完了');finished('completed',6,90,'人工の古い完了');finished('failed',3,120,'人工の古い失敗');
 const lease=r.tasks.claim(admin)!;
 const scope=r.tasks.workState(r.agentSession(a.id),lease).conversation_scope as {truncated:boolean;tasks:{state:string;prompt:string}[];older?:{finished:number;failed:number}};
 const open=scope.tasks.filter(task=>!['completed','failed','cancelled'].includes(task.state));
 assert.equal(open.length,20);assert.equal(scope.truncated,true);
 assert.deepEqual(scope.tasks.filter(task=>task.state==='completed').map(task=>task.prompt.replace(/\d+$/,'')),Array(8).fill('人工の最近の完了'));
 assert.deepEqual(scope.older,{finished:8,failed:3,note:'一覧にない終わった仕事はcoordination_readやhistory_search(kind=task)で確認できます。'},'two recent and six old completions, three old failures are counted, not listed');
 assert.ok(scope.tasks.every(task=>task.prompt.length<=160));
 const status=r.tasks.conversationState(admin,room.id,lease.task.id) as {tasks:unknown[];older?:unknown};
 assert.equal(status.tasks.length,40);assert.equal(status.older,undefined);
});

for (const version of ['legacy-v4','structured-v5'] as const) {
 test(`${version}: the work state does not repeat the request, and per-call counters stay out of the system text`,async t=>{
  const {r,admin,a,room}=fixture(t);
  r.post(admin,room.id,'人工の話題');
  const task=r.tasks.create(admin,a.id,room.id,'人工の依頼を一度だけ送る');
  const sent:ModelRequest[]=[];
  const model:ModelAdapter={adapter_id:'artificial',capabilities:openAISubscriptionAdapterCapabilities,async *run(req){sent.push(req);
   const events:ModelEvent[]=req.tools.length===1?[{type:'tool_call',tool_call_id:'m',name:'memory_review',arguments:{memories:[]}},{type:'completed',finish_reason:'tool_calls'}]
    :[{type:'tool_call',tool_call_id:'s',name:'conversation_send',arguments:{body:'答えました。',recipient_ids:[]}},{type:'completed',finish_reason:'tool_calls'}];
   yield* events;}};
  await new TurnRunner(r,async()=>model,{},{promptVersion:version}).run(r.tasks.claim(admin)!);
  assert.equal(r.tasks.get(admin,task.id).state,'completed');
  for(const req of sent){
   const state=JSON.parse(req.messages.at(-1)!.content!).work_state;
   assert.equal(state.task.id,task.id);assert.equal(state.task.prompt,undefined);
   assert.equal(state.request_brief.origin_request.prompt,undefined);assert.equal(state.request_brief.origin_request.prompt_in_current_request,true);
   assert.deepEqual(Object.keys(state.context_counts).sort(),['archived_tool_messages','omitted_room_messages']);
   assert.doesNotMatch(req.system_instructions,/omitted_room_messages|archived_tool_messages/);
   assert.equal(req.messages.filter(message=>message.role==='user'&&message.content.includes('人工の依頼を一度だけ送る')).length,1);
  }
 });
}
