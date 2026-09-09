import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Runtime} from '../src/runtime/runtime.ts';
import {executeTurnTool} from '../src/runtime/turn-tools.ts';
function fixture(t:{after(fn:()=>void):void}) {
 const root=mkdtempSync(join(tmpdir(),'niwa-versions-')),r=new Runtime(root),admin=r.administrator(),leader=r.bootstrap(admin),actor=r.agentSession(leader.id),bot=r.createAgent(actor,'確認担当'),room=r.createRoom(admin,'共同作業');
 r.tasks.create(admin,leader.id,room.id,'文書の制作');const lease=r.tasks.claim(admin)!;
 const id=r.createArtifact(actor,room.id,'draft.txt','文書','人工データ','version one',lease.task.id);
 t.after(()=>{r.close();rmSync(root,{recursive:true,force:true});});return {root,r,admin,leader,actor,bot,room,lease,id};
}
test('artifact revisions keep immutable references, enforce exact independent review and persist freezing',t=>{
 const {root,r,admin,actor,bot,lease,id}=fixture(t),v=r.artifactVersions,first=v.inspect(actor,id);
 v.reference(actor,id,lease.task.id);
 assert.throws(()=>v.review(actor,id,first.sha256,'approved','self review'),/author/);
 assert.throws(()=>v.freeze(actor,id,first.sha256),/independent/);
 const next=v.revise(actor,id,first.sha256,'version two',lease.task.id),second=v.inspect(actor,next.id);
 assert.equal(v.inspect(actor,id).content,'version one');assert.equal(v.inspect(actor,id).sha256,first.sha256);
 assert.equal(second.version,2);assert.equal(second.parent_id,id);assert.equal(second.versions.length,2);
 assert.equal(v.inspect(actor,id).referenced_by[0]!.sha256,first.sha256);
 assert.throws(()=>v.revise(actor,id,first.sha256,'stale branch',lease.task.id),/newer/);
 assert.throws(()=>v.review(r.agentSession(bot.id),next.id,first.sha256,'approved','wrong hash'),/exact/);
 v.review(r.agentSession(bot.id),next.id,second.sha256,'changes_requested','修正待ち');
 assert.throws(()=>v.freeze(actor,next.id,second.sha256),/independent/);
 v.review(r.agentSession(bot.id),next.id,second.sha256,'approved','内容確認済み');v.freeze(actor,next.id,second.sha256);
 assert.throws(()=>v.revise(actor,next.id,second.sha256,'cannot change',lease.task.id),/Frozen/);
 const reopened=new Runtime(root);try{assert.equal(reopened.artifactVersions.inspect(reopened.administrator(),next.id).frozen,1);}finally{reopened.close();}
 r.deleteContent(admin,'artifact',id);assert.throws(()=>v.inspect(admin,id),/not found/);
 assert.equal(v.inspect(admin,next.id).versions.length,1);assert.equal(v.inspect(admin,next.id).content,'version two');
});
test('shared artifact tools cannot inspect an author’s private artifact or leak reviews',t=>{
 const {r,admin,leader,actor,bot,lease}=fixture(t),room=r.createRoom(admin,'限定会話',[leader.id]);
 const privateId=r.createArtifact(actor,room.id,'private.txt','文書','private','private content');
 assert.throws(()=>r.artifactVersions.inspect(r.agentSession(bot.id),privateId),/unavailable/);
 const result=executeTurnTool(r,actor,lease,{name:'artifact_inspect',tool_call_id:'private',arguments:{id:privateId}},'private');
 assert.match(JSON.stringify(result),/another conversation/);assert.ok(!JSON.stringify(result).includes('private content'));
});
test('digest counts saved objects and classified intents, not completion claims, and survives reopening',async t=>{
 const {root,r,admin,leader,actor,room,lease}=fixture(t);
 r.reportUpdate(actor,room.id,'done','売上100万円','自己申告',lease.task.id);
 await r.tasks.externalOnce(actor,lease,'local',{name:'program_execute'},async()=>({code:0}));
 await r.tasks.externalOnce(actor,lease,'send',{name:'browser_form_submit'},async()=>({status:500}));
 await r.tasks.externalOnce(actor,lease,'unknown',{name:'browser_request_submit'},async()=>{throw Error('synthetic disconnect');});
 const digest=r.coordinationDigest(actor,room.id);assert.equal(digest.artifact_count,1);assert.equal(digest.revenue,'unverified');
 assert.equal(digest.operations.length,2);assert.equal(digest.operations.find(x=>x.tool_name==='browser_form_submit')!.recorded,1);
 assert.equal(digest.operations.find(x=>x.tool_name==='browser_request_submit')!.unknown,1);
 const hidden=r.createRoom(admin,'非共有',[leader.id]);r.createArtifact(actor,hidden.id,'hidden.txt','資料','hidden','hidden');
 assert.ok(!JSON.stringify(r.coordinationDigest(actor,room.id)).includes('hidden'));
 const reopened=new Runtime(root);try{assert.equal(reopened.coordinationDigest(reopened.administrator(),room.id).operations.length,2);}finally{reopened.close();}
});
test('timebox cannot extend an existing deadline, propagates to child work and persists expiration',t=>{
 const {root,r,admin,actor,bot,lease,room}=fixture(t);
 const deadline=r.tasks.timebox(actor,lease,90).deadline_at;
 assert.equal(r.tasks.timebox(actor,lease,900).deadline_at,deadline);
 r.tasks.delegate(actor,lease,bot.id,'子の処理');const child=r.tasks.claim(admin)!;
 assert.equal(child.task.deadline_at,deadline);
 const tighter=r.tasks.timebox(r.agentSession(bot.id),child,1).deadline_at;assert.ok(tighter<deadline);
 r.tasks.expire(admin,tighter+1);assert.equal(r.tasks.get(admin,child.task.id).state,'failed');
 assert.equal(r.tasks.get(admin,lease.task.id).state,'queued');
 assert.equal(r.coordinationDigest(actor,room.id).overdue,1);
 const reopened=new Runtime(root);try{assert.equal(reopened.tasks.get(reopened.administrator(),child.task.id).state,'failed');}finally{reopened.close();}
 assert.throws(()=>r.tasks.timebox(r.agentSession(bot.id),child,900),/no longer active/);
});

test('schema31 upgrade retains existing work, content and settings without backfilling private metadata',async t=>{
 const {DatabaseSync}=await import('node:sqlite');
 const {createHash}=await import('node:crypto');
 const {root,r,admin,actor,room,lease}=fixture(t);
 r.post(actor,room.id,'人工の保存済み会話');r.tasks.wait(actor,lease,'waiting_user','人工の入力待ち');
 r.close();
 const db=new DatabaseSync(join(root,'control.db'));
 db.exec('DROP TRIGGER retire_workarea_file; DROP TABLE retired_workarea_files; DROP TABLE task_workareas; DROP TABLE artifact_files; DROP TABLE artifact_audiences; DROP TABLE workarea_members; DROP TABLE workareas; DROP TABLE workarea_settings; DROP TABLE autonomous_boundaries; DROP TABLE autonomous_wakes; ALTER TABLE tasks DROP COLUMN internal_autonomous; DROP TABLE work_notes; DROP TABLE task_handoffs; DROP TABLE external_operation_labels; DROP TABLE artifact_references; DROP TABLE artifact_reviews; DROP TABLE artifact_versions; DROP TABLE task_coordination; DROP TABLE message_acknowledgments; ALTER TABLE tasks DROP COLUMN source_message_id; PRAGMA user_version=31;');
 const tables=['settings','tasks','messages','artifacts','external_operations','approval_requests','schedules'];
 const snapshot=(database:InstanceType<typeof DatabaseSync>)=>tables.map(table=>createHash('sha256').update(JSON.stringify(database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map(row=>{const {source_message_id,internal_autonomous,...original}=row;return original;}))).digest('hex'));
 const before=snapshot(db);db.close();const reopened=new Runtime(root),after=new DatabaseSync(join(root,'control.db'));
 try{
  assert.equal(after.prepare('PRAGMA user_version').get()!.user_version,38);assert.deepEqual(snapshot(after),before);
  assert.equal(reopened.coordination(reopened.administrator(),room.id)[0]!.blocker,'');
  assert.equal(reopened.tasks.get(reopened.administrator(),lease.task.id).state,'waiting_user');
 }finally{after.close();reopened.close();}
});
