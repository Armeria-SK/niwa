import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Runtime} from '../src/runtime/runtime.ts';
import {executeAsyncTurnTool,turnTools} from '../src/runtime/turn-tools.ts';
import {readPublicFile, type PageNetwork} from '../src/tools/web/public-page.ts';

test('public binary downloads validate redirect destinations, sizes and preserve bytes', async () => {
  const transport: PageNetwork = {resolve:async()=>['93.184.216.34'], get:async()=>({status:200,contentType:'application/pdf',body:Buffer.from([0,255,42])})};
  assert.equal((await readPublicFile('https://example.com/file',undefined,transport)).body_base64,'AP8q');
  await assert.rejects(readPublicFile('https://example.com/file',undefined,{...transport,resolve:async()=>['127.0.0.1']}));
  await assert.rejects(readPublicFile('https://example.com/file',undefined,{...transport,get:async()=>({status:302,location:'http://127.0.0.1/private',contentType:'',body:''})}));
  await assert.rejects(readPublicFile('https://example.com/file',undefined,{...transport,get:async()=>({status:200,contentType:'application/octet-stream',body:Buffer.alloc(256*1024+1)})}));
});

test('download tool enforces shared scope, caches completion and does not retry an uncertain write', async t => {
  const root=mkdtempSync(join(tmpdir(),'niwa-download-')), runtime=new Runtime(join(root,'state'));
  t.after(()=>{runtime.close();rmSync(root,{recursive:true,force:true});});
  const admin=runtime.administrator(), leader=runtime.bootstrap(admin), actor=runtime.agentSession(leader.id), room=runtime.createRoom(admin,'Artificial download');
  runtime.tasks.create(admin,leader.id,room.id,'download'); let lease=runtime.tasks.claim(admin)!;
  let reads=0,writes=0;
  const external={readFile:async()=>{reads++;return {url:'https://example.com/file',content_type:'application/pdf',body_base64:'AP8q',fetched_at:new Date().toISOString(),untrusted:true};},
    workspaceWrite:async()=>{writes++;return {path:'file.pdf',revision:'a'.repeat(64),shared:true};}};
  const call={name:'web_download',tool_call_id:'download',arguments:{url:'https://example.com/file',path:'file.pdf',expected_revision:null}};
  const first=await executeAsyncTurnTool(runtime,actor,lease,call,'first',undefined,external);
  assert.equal(first.path,'file.pdf'); assert.ok(!('body_base64' in first));
  assert.deepEqual(await executeAsyncTurnTool(runtime,actor,lease,call,'first',undefined,external),first);
  assert.equal(reads,1);assert.equal(writes,1);
  assert.equal((await executeAsyncTurnTool(runtime,actor,lease,call,'lost',undefined,{...external,workspaceWrite:async()=>{throw Error('Lost reply');}})).error,'outcome_unknown');
  runtime.tasks.resume(admin,lease.task.id);lease=runtime.tasks.claim(admin)!;
  assert.equal((await executeAsyncTurnTool(runtime,actor,lease,call,'lost',undefined,external)).error,'outcome_unknown');
  assert.equal(writes,1);assert.equal(reads,2);
  assert.equal(turnTools(false,external,false).some(tool=>tool.name==='web_download'),false);
});
