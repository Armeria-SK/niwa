import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {DatabaseSync} from 'node:sqlite';import {resolve} from 'node:path';import {pathToFileURL} from 'node:url';import {Runtime} from '../src/runtime/runtime.ts';
function fixture(t:{after(fn:()=>void):void}){const root=mkdtempSync('/tmp/niwa-readable-'),r=new Runtime(root),admin=r.administrator(),a=r.bootstrap(admin),aa=r.agentSession(a.id),b=r.createAgent(aa,'照合Bot'),ba=r.agentSession(b.id),room=r.createRoom(admin,'人工案件'),db=new DatabaseSync(root+'/control.db');t.after(()=>{db.close();r.close();rmSync(root,{recursive:true,force:true});});return {root,r,admin,a,aa,b,ba,room,db};}
test('artifact lineage, exact-version review, historical search, equal names and private visibility',async t=>{
 const {r,admin,a,aa,b,ba,room}=fixture(t);const task=r.tasks.create(admin,a.id,room.id,'資料'),lease=r.tasks.claim(admin)!;
 const first=r.createArtifact(aa,room.id,'資料_v1.md','research_memo','人工資料','# 初版\n過去だけの検索語',task.id);
 r.artifactVersions.review(ba,first,r.artifactVersions.inspect(aa,first).sha256,'approved','初版の内容を確認しました');
 const second=r.artifactVersions.revise(aa,first,r.artifactVersions.inspect(aa,first).sha256,'# 改訂\n新しい根拠',task.id);
 const equal=r.createArtifact(aa,room.id,'資料_v1.md','research_memo','別の目的','別物');const privateRoom=r.createRoom(admin,'個別',[a.id]);const hidden=r.createArtifact(aa,privateRoom.id,'資料_v1.md','research_memo','個別','秘密の人工語');
 const rows=r.artifacts(ba);assert.equal(rows.find(x=>x.id===first)!.quality_status,'reviewed');assert.equal(rows.find(x=>x.id===second.id)!.quality_status,'unchecked');assert.equal(rows.find(x=>x.id===second.id)!.series_id,first);assert.equal(rows.some(x=>x.id===hidden),false);assert.deepEqual(r.artifacts(ba,'過去だけ').map(x=>x.id),[first]);assert.equal(r.artifact(ba,second.id).name,'資料_v1.md');assert.equal(r.artifact(ba,first).content,'# 初版\n過去だけの検索語');
 const {artifactGroups,documentName}=await import(pathToFileURL(resolve('web/src/artifact-display.js')).href);const groups=artifactGroups(rows);assert.equal(groups.length,2);assert.equal(groups.find((g:any)=>g.latest.id===second.id).versions.length,2);assert.equal(groups.find((g:any)=>g.latest.id===equal).versions.length,1);assert.equal(documentName('資料_v1.md'),'資料.md');
});
test('chronological pagination is stable across equal timestamps and nonmonotonic insertion times',t=>{
 const {r,admin,room,db}=fixture(t);r.post(admin,room.id,'最初の依頼');
 for(let i=0;i<123;i++){const m=r.post(admin,room.id,`発言${i}`);db.prepare('UPDATE messages SET created_at=? WHERE id=?').run(new Date(1_700_000_000_000+(i%19)*1000).toISOString(),m.id);}
 const expected=db.prepare('SELECT id FROM messages WHERE room_id=? ORDER BY created_at,rowid').all(room.id).map(x=>x.id).filter(x=>x!==r.messagePage(admin,room.id).first!.id);
 let page=r.messagePage(admin,room.id),ids=page.items.map(x=>x.id);while(page.next!==null){page=r.messagePage(admin,room.id,page.next);ids=[...page.items.map(x=>x.id),...ids];}assert.deepEqual(ids,expected);assert.equal(new Set(ids).size,123);assert.deepEqual(r.messagePage(admin,room.id).items.map(x=>x.id),ids.slice(-50));
});
test('waiting facts use required children in the same conversation and preserve running plus waiting counts',async t=>{
 const {r,admin,a,aa,b,ba,room}=fixture(t);const parent=r.tasks.create(admin,a.id,room.id,'調査'),p=r.tasks.claim(admin)!,child=r.tasks.delegate(aa,p,b.id,'公開資料の照合'),cl=r.tasks.claim(admin)!;
 const progress=r.tasks.progress(admin,parent.id);assert.deepEqual(progress.waiting_for,['照合Bot']);assert.equal(progress.waiting_tasks[0]!.id,child.id);assert.equal(progress.waiting_tasks[0]!.prompt,'公開資料の照合');assert.equal(progress.retry_at,null);assert.ok(progress.last_activity_at);
 const {memberWork,presenceCounts}=await import(pathToFileURL(resolve('web/src/work-display.js')).href);const jobs=[{state:'waiting_child',progress},{state:'running',progress:{label:'資料を確認中'}}];assert.equal(memberWork(jobs).kind,'running');assert.equal(memberWork(jobs,true).kind,'paused');assert.equal(memberWork(jobs,false,true).kind,'sleeping');assert.equal(presenceCounts([{workKind:'running'},{workKind:'waiting'},{workKind:'idle'}]),'実行中1人・待機1人・返答待機1人');
});
test('client merges reconnect and older pages once using stable server timestamps',async()=>{
 const {mergeMessages}=await import(pathToFileURL(resolve('web/src/message-order.js')).href);const a={id:'a',sequence:2,created_at:'2026-01-01T10:00:00Z'},b={id:'b',sequence:1,created_at:'2026-01-01T11:00:00Z'},c={id:'c',sequence:3,created_at:a.created_at};assert.deepEqual(mergeMessages([b,a],[a,c]).map((m:any)=>m.id),['a','c','b']);
});
