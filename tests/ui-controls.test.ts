import {test} from 'node:test';import assert from 'node:assert/strict';import {resolve} from 'node:path';import {pathToFileURL} from 'node:url';import {NO_DEADLINE} from '../src/domain/deadline.ts';
const ui=(file:string)=>import(pathToFileURL(resolve('web/src/'+file)).href);
test('deadline display uses the persisted sentinel; invalid dates never render as calendar dates',async()=>{
 const {deadlineLabel}=await ui('deadline.js');for(const value of [NO_DEADLINE,null,undefined])assert.equal(deadlineLabel(value),'期限なし');for(const value of [NaN,Infinity,-1,0,'bad',NO_DEADLINE+1])assert.equal(deadlineLabel(value),'期限未確認');assert.equal(deadlineLabel(1_800_000_000_000),'期限：'+new Date(1_800_000_000_000).toLocaleString('ja-JP'));
});
test('artifact categories preserve Japanese names, unite aliases and group unknown internal values without changing records',async()=>{
 const {kindLabel,artifactGroups}=await ui('artifact-display.js');const kinds=['実行手順書','実行計画','内部評価表','進捗・意思決定メモ','markdown','document','unregistered_a','unregistered_b'];assert.deepEqual(kinds.slice(0,4).map(kindLabel),kinds.slice(0,4));assert.equal(kindLabel('markdown'),kindLabel('document'));assert.equal(new Set(kinds.map(kindLabel)).size,6);assert.equal(kinds.filter(k=>kindLabel(k)==='その他の資料').length,2);
 const rows=kinds.map((kind,i)=>({id:String(i),room_id:'room',series_id:String(i),kind,version:1,created_at:i,name:'同名'})),saved=JSON.stringify(rows);assert.equal(artifactGroups(rows).length,8);assert.equal(JSON.stringify(rows),saved);
});
test('work counts distinguish assignments from purposes and never call paused work running',async()=>{
 const {workCounts}=await ui('work-display.js');const tasks=[{state:'running'},{state:'running',paused:1},{state:'queued'},{state:'waiting_child'},{state:'completed'},{state:'cancelled'}];assert.equal(workCounts(tasks),'実行中1作業・待機2作業・一時停止1作業・終了2作業');assert.equal(workCounts(tasks,true),'一時停止4作業・終了2作業');
});
test('model setup notice appears only when no saved connection can answer the Bot in question',async()=>{
 const {modelSetupNotice}=await ui('providers.js');
 const leader={authority:'leader',name:'リーダー',provider:'openai_subscription'},kanade={authority:'member',name:'カナデ',provider:'anthropic'};
 assert.equal(modelSetupNotice(null,leader),null);
 assert.match(modelSetupNotice([],leader).title,/まずモデルをつなぎましょう/);
 assert.match(modelSetupNotice(['anthropic'],leader).title,/リーダーのモデル（Codex）/);
 assert.match(modelSetupNotice(['openai_subscription'],kanade).title,/カナデのモデル（Claude（Anthropic API））/);
 assert.equal(modelSetupNotice(['anthropic','local_llm'],kanade),null);assert.equal(modelSetupNotice(['anthropic'],undefined),null);
});
test('memory source names the speaker and room, marks private conversations and survives a deleted room',async()=>{
 const {memorySource}=await ui('memory-source.js');
 const shared=memorySource({created_at:'2026-09-09T08:53:00.000Z',source:{room_title:'はじめての共同制作',private:false,excerpt:'日時は第2土曜です',author_id:'administrator',author_name:null,said_at:'2026-09-09T08:52:00.000Z'}});
 assert.equal(shared.author,'あなた');assert.equal(shared.room,'はじめての共同制作');assert.equal(shared.private,false);assert.ok(shared.created&&shared.said);assert.equal(shared.openable,true);
 const bot=memorySource({created_at:'x',source:{room_title:'個別',private:true,excerpt:'了解',author_id:'b',author_name:null,said_at:'x'}});
 assert.equal(bot.author,'削除したBot');assert.equal(bot.private,true);assert.equal(bot.created,'');
 const gone=memorySource({created_at:'2026-09-09T08:53:00.000Z',source:null});
 assert.equal(gone.room,'元の会話は削除されています');assert.equal(gone.excerpt,'');assert.equal(gone.openable,false);
});
test('usage sums reported tokens and falls back to the estimate only for unreported input',async()=>{
 const {usageSummary}=await ui('work-display.js');
 assert.deepEqual(usageSummary([{input_tokens:1200,output_tokens:80,estimated_input_tokens:1500},{input_tokens:null,output_tokens:null,estimated_input_tokens:900}]),{calls:2,input:2100,output:80,estimated:1});
 assert.deepEqual(usageSummary(undefined),{calls:0,input:0,output:0,estimated:0});
});
test('unread counts start from what exists, grow with new messages and clear when the conversation is shown',async()=>{
 const {startSeen,unreadOf,markSeen}=await ui('unread.js');
 const rooms=[{id:'a',message_count:5},{id:'b',message_count:2}];
 const seen=startSeen(rooms,null);assert.equal(unreadOf(rooms[0],seen),0);
 const later={id:'a',message_count:8},fresh={id:'c',message_count:3};
 assert.equal(unreadOf(later,seen),3);assert.equal(unreadOf(fresh,seen),3);
 const after=markSeen(seen,later);assert.equal(unreadOf(later,after),0);assert.equal(markSeen(after,later),after);
 assert.equal(startSeen(rooms,after),after);assert.equal(unreadOf(later,null),0);
});
test('your-turn list puts approvals first, hides answered questions and never lists a question twice',async()=>{
 const {attentionItems}=await ui('attention.js');
 const activities=[{id:'t1',status:'approval',state:'waiting_user',title:'送信の承認',updated_at:10},{id:'t2',status:'waiting',state:'waiting_user',title:'文章',updated_at:20},
  {id:'t3',status:'waiting',state:'waiting_user',title:'止まった仕事',reason:'確認後に再開してください。',updated_at:30},{id:'t4',status:'running',state:'running',title:'答え済み',updated_at:40}];
 const questions=[{id:'q1',title:'参加費は無料？',detail:'参加費は無料？',activity:'t2',created_at:'2026-10-17T00:00:00Z'},{id:'q2',title:'答えた質問',activity:'t4'},{id:'q3',title:'確認済み',seen:1}];
 const items=attentionItems({activities,questions,decisions:[{id:'d1',title:'日時は第2土曜'},{id:'d2',title:'見た',seen:1}]});
 assert.deepEqual(items.map((i:{kind:string;id:string})=>[i.kind,i.id]),[['approval','t1'],['question','q1'],['stopped','t3'],['decisions','decisions']]);
 assert.equal(items[1].detail,'');assert.deepEqual(items[3].ids,['d1']);
 assert.deepEqual(attentionItems({}),[]);
 const seenAsk=attentionItems({activities:[{id:'t2',status:'waiting',state:'waiting_user',title:'文章'}],questions:[{id:'q1',title:'参加費は？',activity:'t2',seen:1},{id:'q9',title:'消えた仕事',activity:'gone'}]});
 assert.deepEqual(seenAsk,[]);
});
test('procedure use reads as a count with the last day, and says when a procedure is turned off',async()=>{
 const {procedureUse}=await ui('procedure-display.js');
 assert.equal(procedureUse({enabled:true,uses:0,last_used_at:null}),'まだ使っていません');
 assert.match(procedureUse({enabled:true,uses:3,last_used_at:Date.UTC(2026,9,17,3)}),/^3回使った・最後は10\/1[67]$/);
 assert.equal(procedureUse({enabled:false,uses:0,last_used_at:null}),'止めています（まだ使っていません）');
});
test('sentences split after each full stop, but not inside brackets or at the very end',async()=>{
 const {splitSentences}=await ui('sentences.js');
 assert.deepEqual(splitSentences('一つ目です。二つ目です。'),['一つ目です。','二つ目です。']);
 assert.deepEqual(splitSentences('「設定」→「保存。」を押します。続けます'),['「設定」→「保存。」を押します。','続けます']);
 assert.deepEqual(splitSentences('句点のない文'),['句点のない文']);assert.deepEqual(splitSentences('（途中。）まで。 次へ。'),['（途中。）まで。','次へ。']);
});
test('screen addresses read old names, drop what cannot be read and write back the same address',async()=>{
 const {parseRoute,routeHash}=await ui('route.js');
 assert.deepEqual(parseRoute(''),{page:'today'});assert.deepEqual(parseRoute('#unknown/x'),{page:'today'});
 assert.deepEqual(parseRoute('#members'),{page:'bots'});assert.deepEqual(parseRoute('#activity'),{page:'records'});
 assert.deepEqual(parseRoute('#settings/mcp'),{page:'settings',tab:'mcp'});assert.deepEqual(parseRoute('#settings/nope'),{page:'settings'});
 assert.deepEqual(parseRoute('#conversation/room-1'),{page:'conversation',id:'room-1'});assert.deepEqual(parseRoute('#conversation/<script>'),{page:'conversation'});
 assert.deepEqual(parseRoute('#bots/a1/memory'),{page:'bots',id:'a1',tab:'memory'});assert.deepEqual(parseRoute('#bots/a1/secret'),{page:'bots',id:'a1'});
 assert.deepEqual(parseRoute('#records/task/t9'),{page:'records',task:'t9'});assert.deepEqual(parseRoute('#records/artifacts'),{page:'records',tab:'artifacts'});
 assert.deepEqual(parseRoute('#records/%E0%A4'),{page:'records'});
 for(const hash of ['#today','#conversation/room-1','#bots/a1/procedures','#bots/a1','#records/task/t9','#records/schedules','#settings/models'])assert.equal(routeHash(parseRoute(hash)),hash);
 assert.equal(routeHash({page:'bots',tab:'memory'}),'#bots');
});
test('today counts what is waiting on you, who is working and what was made in the last day',async()=>{
 const {todayDigest,DAY}=await ui('today.js');const now=Date.UTC(2026,9,17,12);
 const artifacts=[{id:'a1',room_id:'r',series_id:'s',version:1,created_at:now-2*DAY,name:'案内'},{id:'a2',room_id:'r',series_id:'s',version:2,created_at:now-1000,name:'案内'},{id:'a3',room_id:'r',series_id:'old',version:1,created_at:now-3*DAY,name:'古い'}];
 const activities=[{state:'running',member:'k'},{state:'running',member:'k'},{state:'running',member:'r',paused:1},{state:'completed',member:'r'}];
 const digest=todayDigest({now,attention:[{kind:'approval'}],activities,artifacts,decisions:[{id:'d1',created_at:new Date(now-60_000).toISOString()},{id:'d0',created_at:now-2*DAY}]});
 assert.deepEqual(digest.made.map((item:{id:string})=>item.id),['a2']);assert.deepEqual(digest.decided.map((item:{id:string})=>item.id),['d1']);assert.equal(digest.working,1);
 assert.equal(digest.summary,'あなたの番が1件あります。いま1体のBotが仕事を進めています。直近24時間で、決まったことが1件、できたものが1件あります。');
 assert.equal(todayDigest({now,paused:true,activities}).summary,'あなたの判断を待っているものはありません。Botの活動は一時停止しています。');
});
