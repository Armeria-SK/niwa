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
test('model choices are grouped by connection, with the experimental ChatGPT route last and the order inside each group kept',async()=>{
 const {groupByProvider}=await ui('providers.js');
 const items=[{provider:'openai_subscription',model:'gpt-6-astra'},{provider:'openai_compatible',model:'b'},{provider:'anthropic',model:'claude-opus-5-5'},{provider:'openai_compatible',model:'a'},{provider:'someday',model:'x'}];
 const groups=groupByProvider(items);
 assert.deepEqual(groups.map((group:{label:string})=>group.label),['Claude（Anthropic API）','OpenAI互換API','Codex','someday']);
 assert.deepEqual(groups[1].items.map((item:{model:string})=>item.model),['b','a']);
 assert.deepEqual(groupByProvider([]),[]);
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
 assert.deepEqual(parseRoute('#bots/everyone/conflicts'),{page:'bots',id:'everyone',tab:'conflicts'});assert.deepEqual(parseRoute('#bots/everyone/memory'),{page:'bots',id:'everyone'});assert.deepEqual(parseRoute('#bots/a1/conflicts'),{page:'bots',id:'a1'});
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
test('second opinions show the estimate before asking, explain failures by kind and keep model checks apart by provider',async()=>{
 const {estimateLabel,usedLabel,failureText,modelCheckView,checkProviders}=await ui('second-opinion.js');
 assert.equal(estimateLabel({estimated_input_tokens:12345,messages:3,memories:2,removed_messages:0}),'入力の見積もり：約12,345トークン（会話3件・記憶2件）');
 assert.equal(estimateLabel({estimated_input_tokens:900,messages:1,memories:0,removed_messages:4}),'入力の見積もり：約900トークン（会話1件・記憶0件）。古い発言4件は入りきらないので外します');
 assert.equal(estimateLabel({estimated_input_tokens:2000,truncated:true}),'入力の見積もり：約2,000トークン。長いので先頭の部分だけを渡します');
 assert.equal(estimateLabel(null),'');
 assert.equal(usedLabel({input_tokens:1200,output_tokens:80,estimated_input_tokens:1500}),'入力1,200・出力80トークン');
 assert.equal(usedLabel({input_tokens:null,output_tokens:null,estimated_input_tokens:1500}),'入力1,500（見積もり）・出力不明トークン');
 assert.equal(failureText({code:'RATE_LIMITED',message:'provider text'}),'接続先が混み合っています。少し待ってから試してください。（RATE_LIMITED）');
 assert.equal(failureText({code:'SOMETHING_NEW'}),'モデルの呼び出しを完了できませんでした。（SOMETHING_NEW）');
 const view=modelCheckView({review_model:'openai_compatible/org/model-x/native',note:'時刻を足す',created_at:1,sha256:'a',checks:JSON.stringify([{criterion:'c1',verdict:'fail',note:'時刻がない'},{criterion:'overall',verdict:'pass',note:'よい'}])},[{id:'c1',condition:'時刻と場所がある'}]);
 assert.equal(view.model,'OpenAI互換API org/model-x');assert.deepEqual(view.checks.map((c:{condition:string;label:string})=>[c.condition,c.label]),[['時刻と場所がある','直したほうがよい'],['全体として、正確で、筋が通り、役に立つか','条件を満たす']]);
 assert.equal(modelCheckView({review_model:'anthropic/claude-x/high',checks:'broken'}).model,'Claude（Anthropic API） claude-x・推論 high');
 assert.deepEqual(modelCheckView({review_model:'anthropic/claude-x/high',checks:'broken'}).checks,[]);
 assert.deepEqual(checkProviders(['anthropic','local_llm','openai_compatible'],['openai_subscription','anthropic']),['anthropic']);
});
test('the watch tab has its own URL and reads tools, outcomes, times and limits in plain words',async()=>{
 const {parseRoute,routeHash}=await ui('route.js');
 assert.deepEqual(parseRoute('#records/watch'),{page:'records',tab:'watch'});assert.equal(routeHash({page:'records',tab:'watch'}),'#records/watch');
 const {toolLabel,outcomeLabel,agoLabel,limitLabel,nightLine}=await ui('watch.js');
 assert.equal(toolLabel('browser_form_submit'),'フォームの送信');assert.equal(toolLabel('page_read'),'ページの取得');
 assert.equal(toolLabel('mcp_github_create_issue'),'MCPの操作（github：create_issue）');assert.equal(toolLabel('odd_tool'),'そのほかの操作（odd_tool）');
 assert.equal(outcomeLabel({outcome:'recorded',failed:false}),'記録あり');assert.equal(outcomeLabel({outcome:'recorded',failed:true}),'記録あり（失敗の記録）');assert.equal(outcomeLabel({outcome:'unknown'}),'結果不明');
 const now=Date.UTC(2026,9,17,12);
 assert.deepEqual([agoLabel(now-30_000,now),agoLabel(now-5*60_000,now),agoLabel(now-3*3600_000,now),agoLabel(now-2*86400_000,now),agoLabel(now+1000,now),agoLabel(0,now)],['たった今','5分前','3時間前','2日前','','']);
 assert.equal(limitLabel(5,24),'5 / 24回');assert.equal(limitLabel(1200),'1,200回');
 assert.equal(nightLine({decision:'approved',used:3,limit:30,in_night:true}),'今夜の上限：モデル呼び出し 3 / 30回');
 assert.equal(nightLine({decision:'approved',used:0,limit:30,in_night:false}),'今夜の上限：モデル呼び出し 0 / 30回（夜はまだ始まっていません）');
 assert.equal(nightLine({decision:'skipped'}),'今夜は休ませると決めています。');
 assert.match(nightLine({decision:null,preview:true}),/まだ決めていません/);assert.match(nightLine({decision:null,preview:false}),/下見はオフ/);
});
test('the watch tab lists moving work apart from work waiting for input, approval, its turn or a pause',async()=>{
 const {splitWork}=await ui('watch.js');
 const items=[{id:'a',state:'running',paused:false},{id:'b',state:'waiting_user',paused:false,progress:{kind:'user_input'}},{id:'c',state:'waiting_user',paused:false,progress:{kind:'approval'}},
  {id:'d',state:'running',paused:true},{id:'e',state:'queued',paused:false},{id:'f',state:'waiting_child',paused:false},{id:'g',state:'waiting_provider',paused:false},{id:'h',state:'running',paused:false}];
 const {moving,waiting}=splitWork(items);
 assert.deepEqual(moving.map((item:{id:string})=>item.id),['a','h']);assert.deepEqual(waiting.map((item:{id:string})=>item.id),['b','c','d','e','f','g']);
 assert.deepEqual(splitWork(undefined),{moving:[],waiting:[]});assert.deepEqual(splitWork([]),{moving:[],waiting:[]});
});
test('trust suggestions name the Bot, the kind and the run of approvals, and come after urgent items',async()=>{
 const {kindLabel,suggestionText,trustAttention}=await ui('trust.js');
 assert.equal(kindLabel('mcp:mcp_notes_append_note'),'MCPの書き込み（notes：append_note）');
 assert.deepEqual(['form','page_request','request','action','odd'].map(kindLabel),['Webフォームの送信','ページからの送信','支払い・購入・公開などの承認','そのほかの操作','そのほかの操作']);
 const item={agent_id:'a1',name:'リーダー',kind:'mcp:mcp_notes_append_note',streak:5,last_at:10};
 assert.equal(suggestionText(item),'リーダーの「MCPの書き込み（notes：append_note）」を、5回続けてそのまま承認しています。この種類は聞かずに進めてよいですか？');
 assert.deepEqual(trustAttention([item]).map((i:{kind:string;id:string;member:string})=>[i.kind,i.id,i.member]),[['trust','a1:mcp:mcp_notes_append_note','a1']]);
 assert.deepEqual(trustAttention(undefined),[]);
});
test('attachments are sorted into text, images and PDFs by their bytes, and an image a Bot could not see says so',async()=>{
 const {attachmentKind,unseenNotice,formatSize}=await ui('attachments.js');
 const png=new Uint8Array(24);png.set([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);png.set([...'IHDR'].map(c=>c.charCodeAt(0)),12);
 assert.equal(attachmentKind(png),'image');assert.equal(attachmentKind(new Uint8Array([0xff,0xd8,0xff,0xe0])),'image');
 assert.equal(attachmentKind(new TextEncoder().encode('%PDF-1.7\n')),'pdf');assert.equal(attachmentKind(new TextEncoder().encode('<svg/>')),'text');
 assert.equal(attachmentKind(new Uint8Array([0x00,0x01,0x02])),null);assert.equal(attachmentKind(new Uint8Array([0x89,0x50,0x4e,0x47])),null);
 assert.equal(unseenNotice(['リーダー','カナデ']),'リーダー・カナデのモデルは画像を見られないため、この画像を認識できませんでした。');assert.equal(unseenNotice([]),'');
 assert.deepEqual([formatSize(512),formatSize(2048),formatSize(3*1024*1024)],['512 B','2.0 KB','3.0 MB']);
});
test('a task replay has its own URL and reads each kind of record in plain words',async()=>{
 const {parseRoute,routeHash}=await ui('route.js');
 assert.deepEqual(parseRoute('#records/task/t-1/replay'),{page:'records',task:'t-1',replay:true});assert.deepEqual(parseRoute('#records/task/t-1/other'),{page:'records',task:'t-1'});
 assert.equal(routeHash({page:'records',task:'t-1',replay:true}),'#records/task/t-1/replay');assert.equal(routeHash({page:'records',task:'t-1'}),'#records/task/t-1');
 const {replayItemView}=await ui('replay.js');
 assert.deepEqual(replayItemView({type:'event',code:'running'}),{label:'状態',detail:'実行を開始',tone:'info'});
 assert.equal(replayItemView({type:'model',phase:'work',status:'completed',input_tokens:1200,output_tokens:60,estimated_input_tokens:1300}).detail,'返答・作業：完了（入力1,200・出力60）');
 assert.equal(replayItemView({type:'model',phase:'memory_review',status:'unknown',input_tokens:null,output_tokens:null,estimated_input_tokens:900}).detail,'記憶の整理：結果不明（入力の見積もり900）');
 assert.deepEqual(replayItemView({type:'tool',name:'web_read',args:'{"url":"u"}',result:'本文',failed:false}),{label:'道具 web_read',detail:'{"url":"u"} → 本文',tone:'info'});
 assert.equal(replayItemView({type:'tool',name:'web_read',args:'',result:'',failed:true}).detail,'→ 失敗');
 assert.deepEqual(replayItemView({type:'outside',name:'browser_form_submit',outcome:'unknown'}),{label:'外部への操作 browser_form_submit',detail:'結果不明',tone:'warn'});
 assert.equal(replayItemView({type:'message',link:'response',author:'リーダー',text:'答え'}).label,'返答（リーダー）');
 assert.equal(replayItemView({type:'approval',decision:'auto'}).detail,'任せた範囲で自動');
});
test('replay times follow the browser clock like the other screens, not a fixed Japan time',async()=>{
 const {replayTime}=await ui('replay.js');const at=Date.UTC(2026,9,17,3,4,5),zone=process.env.TZ;
 try{
  process.env.TZ='UTC';assert.equal(replayTime(at),'3:04:05');
  process.env.TZ='America/New_York';assert.equal(replayTime(at),'23:04:05');
  process.env.TZ='Asia/Tokyo';assert.equal(replayTime(at),'12:04:05');
 }finally{if(zone===undefined)delete process.env.TZ;else process.env.TZ=zone;}
});
test('the Bot export has its own URL and says what goes in and what cannot',async()=>{
 const {parseRoute,routeHash}=await ui('route.js');
 assert.deepEqual(parseRoute('#bots/b-1/export'),{page:'bots',id:'b-1',tab:'export'});assert.equal(routeHash({page:'bots',id:'b-1',tab:'export'}),'#bots/b-1/export');
 const {exportSummary,privateNote}=await ui('bot-file.js');
 assert.equal(exportSummary(0,0),'人格・見た目');assert.equal(exportSummary(2,1),'人格・見た目・手順2件・記憶1件');
 assert.equal(privateNote(1,3),'個別の会話から生まれた手順1件と記憶3件は、書き出せません。');assert.equal(privateNote(0,2),'個別の会話から生まれた記憶2件は、書き出せません。');assert.equal(privateNote(0,0),'');
});
test('reading a Bot file has its own URL and says what it makes and why a file cannot be read, in plain words',async()=>{
 const {parseRoute,routeHash}=await ui('route.js');
 assert.deepEqual(parseRoute('#bots/import'),{page:'bots',id:'import'});assert.deepEqual(parseRoute('#bots/import/memory'),{page:'bots',id:'import'});
 assert.equal(routeHash({page:'bots',id:'import'}),'#bots/import');assert.equal(routeHash({page:'bots',id:'import',tab:'memory'}),'#bots/import');
 const {BOT_FILE_MAX_LENGTH:screenLimit,problemText,appearanceText,importPlan,hiddenNote,limitNote}=await ui('bot-file.js');
 const {BOT_FILE_MAX_LENGTH:serverLimit}=await import('../src/runtime/bot-files.ts');assert.equal(screenLimit,serverLimit);
 assert.equal(problemText({kind:'json',path:''}),'JSONとして読めません。');assert.equal(problemText({kind:'format',path:'/format'}),'Niwaで書き出したBotのファイルではありません。');
 assert.equal(problemText({kind:'value',path:'/appearance/shape'}),'「かたち」の値が、Niwaで使える形ではありません。');assert.equal(problemText({kind:'unknown',path:'/bot/model'}),'知らない項目「model」があります。');
 assert.equal(problemText({kind:'missing',path:'/appearance/motion'}),'「動き」がありません。');assert.equal(problemText({kind:'blank',path:'/bot/name'}),'「名前」が空です。');
 assert.equal(problemText({kind:'blank',path:'/procedures/1/steps/2'}),'2件目の手順の「手順の中身」の3つ目が空です。');assert.equal(problemText({kind:'too_long',path:'/procedures/0'}),'1件目の手順が長すぎます。');
 assert.equal(problemText({kind:'blank',path:'/memories/4/body'}),'5件目の記憶が空です。');
 assert.equal(appearanceText({shape:'cloud',color:'#336699',motion:'float'}),'かたち：くも・カラー：#336699・動き：ふわふわ');
 const preview={bot:{name:'カナデ'},procedures:[{title:'集合の案内',steps:2}],memories:3,room_title:'ファイルから迎えたカナデの手順と記憶'};
 const all=importPlan(preview,{procedures:true,memories:true});
 assert.deepEqual(all.slice(0,3),['新しいBot「カナデ」を1体迎えます。','今いるBotは書き換えません。','モデルは「新しいBotの標準モデル」を使います。']);
 assert.ok(all.includes('共有の会話「ファイルから迎えたカナデの手順と記憶」を1つ作ります。')&&all.includes('そこに手順1件と記憶3件を、あなたの発言として1件ずつ載せます。')&&all.includes('ほかのBotも、この会話を読めます。'));
 assert.ok(importPlan(preview,{procedures:false,memories:true}).includes('そこに記憶3件を、あなたの発言として1件ずつ載せます。'));
 assert.deepEqual(importPlan(preview,{procedures:false,memories:false}).slice(3),['手順と記憶は入れません。','会話も作りません。']);
 assert.equal(importPlan({...preview,procedures:[],memories:0},{procedures:true,memories:true}).length,3);
 assert.ok(all.every((line:string)=>line.split('。').length===2),'one sentence per line');
 assert.equal(hiddenNote(0),'');assert.equal(hiddenNote(2),'秘密らしい文字を2か所伏せました。伏せたまま迎えます。');
 assert.equal(limitNote(2,3),'');assert.match(limitNote(3,3),/^迎えられるBotの上限（3体）に達しています。/);
});
test('every Bot shape splits into a body and two eyes, so the eyes can blink and close while sleeping',async()=>{
 const {readFileSync}=await import('node:fs');const {avatarParts}=await ui('avatar.js');const {SHAPES}=await ui('data.js');
 for(const shape of SHAPES as {id:string}[]){
  const parts=avatarParts(readFileSync(resolve(`web/src/avatars/avatar-${shape.id}.svg`),'utf8'));
  assert.match(parts.body,/^M[\s\S]+Z$/,shape.id);assert.equal(parts.eyes.length,2,shape.id);for(const eye of parts.eyes)assert.match(eye,/^M[\s\S]+Z$/,shape.id);
 }
 assert.deepEqual(avatarParts('<svg/>'),{body:'',eyes:[]});
});
test('Bot icons move by state: working hops, waiting tilts, sleeping closes its eyes, and a still choice stays still',async()=>{
 const {stateMotion,avatarMotion,blinkTiming}=await ui('avatar.js');
 assert.deepEqual(['running','waiting','sleeping','paused','idle',undefined].map(stateMotion),['work','wait','sleep','idle','idle','idle']);
 assert.equal(avatarMotion({runtime:'work'}),'work');assert.equal(avatarMotion({runtime:'wait'}),'wait');assert.equal(avatarMotion({}),'idle');
 assert.equal(avatarMotion({runtime:'work',paused:true}),'idle');assert.equal(avatarMotion({runtime:'celebrate'}),'celebrate');
 assert.equal(avatarMotion({runtime:'work',sleeping:true}),'sleep');assert.equal(avatarMotion({preference:'none',sleeping:true}),'sleep');
 assert.equal(avatarMotion({preference:'none',runtime:'celebrate'}),'none');assert.equal(avatarMotion({preference:'float',runtime:'celebrate'}),'float');assert.equal(avatarMotion({preference:'float',paused:true}),'idle');
 assert.equal(avatarMotion({preference:'auto',preview:true}),'work');assert.equal(avatarMotion({preference:'pulse',preview:true}),'pulse');
 const one=blinkTiming('bot-1'),again=blinkTiming('bot-1'),other=blinkTiming('bot-2');
 assert.deepEqual(one,again);assert.notDeepEqual(one,other);
 for(const timing of [one,other,blinkTiming(''),blinkTiming(undefined)]){assert.ok(timing.period>=4.2&&timing.period<=6.6);assert.ok(timing.delay<=0&&timing.delay>-6);}
});
