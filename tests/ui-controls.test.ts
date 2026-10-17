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
 const {workCounts}=await ui('work-display.js');const tasks=[{state:'running'},{state:'running',paused:1},{state:'queued'},{state:'waiting_child'},{state:'completed'},{state:'cancelled'}];assert.equal(workCounts(tasks),'実行中1作業・待機2作業・停止1作業・終了2作業');assert.equal(workCounts(tasks,true),'停止4作業・終了2作業');
});
test('model setup notice appears only when no saved connection can answer the leader',async()=>{
 const {modelSetupNotice}=await ui('providers.js');
 assert.equal(modelSetupNotice(null,'anthropic'),null);
 assert.match(modelSetupNotice([],'openai_subscription').title,/まずモデルをつなぎましょう/);
 assert.match(modelSetupNotice(['anthropic'],'openai_subscription').title,/リーダーのモデル（Codex）/);
 assert.equal(modelSetupNotice(['anthropic','local_llm'],'anthropic'),null);
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
