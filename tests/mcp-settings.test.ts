import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,chmodSync,rmSync,statSync,readFileSync,writeFileSync,symlinkSync,linkSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer,request} from 'node:http';
import {once} from 'node:events';
import {initializeInstallation,readInstallation,saveMcpInstallation,mcpConfigRevision} from '../src/config/installation.ts';
import {McpSettings} from '../src/tools/mcp/settings.ts';
import {mcpScope} from '../src/tools/mcp/client.ts';
import {Runtime} from '../src/runtime/runtime.ts';
import {WebAuth} from '../src/web/auth.ts';
import {createApiServer} from '../src/web/api.ts';
import {TurnRunner} from '../src/runtime/turns.ts';
import {openAISubscriptionAdapterCapabilities} from '../src/providers/codex/adapter.ts';
import {Backups} from '../src/backup/backups.ts';
import {restoreInstallation} from '../src/backup/restore.ts';
import {productPaths} from '../src/config/paths.ts';

async function fixture(t:{after:(fn:()=>Promise<void>)=>void}){
 const root=mkdtempSync(join(tmpdir(),'niwa-mcp-settings-')),socket=join(root,'mcp.sock');chmodSync(root,0o700);
 const methods:string[]=[];let release:()=>void=()=>{},started:()=>void=()=>{};
 const writeStarted=new Promise<void>(resolve=>{started=resolve;}),holdWrite=new Promise<void>(resolve=>{release=resolve;});
 const server=createServer(async(req,res)=>{
  const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const msg=JSON.parse(Buffer.concat(chunks).toString());methods.push(msg.method);
  if(msg.id===undefined){res.writeHead(202);res.end();return;}
  let result:unknown={};
  if(msg.method==='initialize')result={protocolVersion:'2025-06-18',capabilities:{experimental:{niwaContextV1:true}},serverInfo:{name:'fixture',version:'1'}};
  if(msg.method==='tools/list')result={tools:['read','write'].map(name=>({name,description:'人工のツール',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:name==='read'}}))};
  if(msg.method==='tools/call'){started();await holdWrite;result={content:[{type:'text',text:'finished original request'}]};}
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:msg.id,result}));
 });server.listen(socket);await once(server,'listening');chmodSync(socket,0o600);
 initializeInstallation(root,{version:1,origin:'https://niwa.test',port:3000,reasoningSummary:true,promptVersion:'structured-v5'});
 const manager=await McpSettings.open(root);
 t.after(async()=>{release();manager.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(root,{recursive:true,force:true});});
 const config={id:'local',socket,scope:'conversation' as const,tools:[{name:'write',readOnly:false},{name:'read',readOnly:true}]};
 return {root,socket,methods,config,manager,writeStarted,release};
}
test('MCP probe discovers permissions without publishing tools or changing saved configuration',async t=>{
 const f=await fixture(t),before=readFileSync(join(f.root,'config/niwa.json'),'utf8');
 const result=await f.manager.probe({socket:f.socket});assert.equal(result.ok,true);
 assert.ok('tools' in result);assert.deepEqual(result.tools.map(t=>t.readOnlyHint),[true,false]);
 assert.equal(f.manager.connector.tools(true).length,0);assert.equal(readFileSync(join(f.root,'config/niwa.json'),'utf8'),before);assert.ok(!f.methods.includes('tools/call'));
});
test('MCP changes persist, preserve other settings and retire previous connectors without redirecting an in-flight write',async t=>{
 const f=await fixture(t),revision=f.manager.status().revision,fixed=readFileSync(join(f.root,'config/niwa.json'),'utf8');
 assert.equal((await f.manager.save({revision,servers:[f.config]})).ok,true);
 const old=f.manager.connector,ctx={scope:mcpScope('epoch','room'),deadline:Date.now()+10000,execution_id:'00000000-0000-4000-8000-000000000001',allow_start:true};
 const running=old.call('mcp_local_write',{},ctx);await f.writeStarted;
 const current=f.manager.status();assert.deepEqual(current.connected,['local']);
 assert.equal((await f.manager.save({revision:current.revision,servers:[{...f.config,enabled:false}]})).ok,true);
 assert.equal(old.tools(true).length,0);await assert.rejects(old.call('mcp_local_write',{},ctx));
 f.release();assert.match(JSON.stringify(await running),/finished original request/);assert.equal(f.methods.filter(m=>m==='tools/call').length,1);
 const stored=readInstallation(f.root);assert.equal(stored.reasoningSummary,true);assert.equal(stored.promptVersion,'structured-v5');assert.equal(stored.mcpServers?.[0]?.enabled,false);assert.equal(statSync(join(f.root,'state/mcp.json')).mode&0o777,0o600);
 assert.equal(readFileSync(join(f.root,'config/niwa.json'),'utf8'),fixed);
 const reopened=await McpSettings.open(f.root);assert.equal(reopened.status().servers[0]?.enabled,false);assert.equal(reopened.status().applied,true);reopened.close();
});
test('MCP connection failure and stale edits preserve current configuration and active tools',async t=>{
 const f=await fixture(t),initial=f.manager.status().revision;
 await f.manager.save({revision:initial,servers:[f.config]});const before=readFileSync(join(f.root,'state/mcp.json'),'utf8'),active=f.manager.connector,revision=f.manager.status().revision;
 assert.equal((await f.manager.save({revision,servers:[{...f.config,socket:join(f.root,'missing.sock')}]})).ok,false);
 assert.equal(f.manager.connector,active);assert.equal(readFileSync(join(f.root,'state/mcp.json'),'utf8'),before);
 await assert.rejects(f.manager.save({revision:initial,servers:[]}));
 await assert.rejects(f.manager.save({revision,servers:[f.config,f.config]}));
 await assert.rejects(f.manager.save({revision,servers:[{...f.config,tools:[]}]}));
 assert.equal(readFileSync(join(f.root,'state/mcp.json'),'utf8'),before);
 await f.manager.save({revision,servers:[]});assert.equal(f.manager.connector.tools(true).length,0);
});
test('MCP saves with read-only deployment configuration and removed legacy connections stay removed after reopening',{skip:process.platform==='win32'||process.getuid?.()===0},async t=>{
 const f=await fixture(t),dir=join(f.root,'config'),file=join(dir,'niwa.json');
 writeFileSync(file,JSON.stringify({...readInstallation(f.root),mcpServers:[f.config]}));
 const fixed=readFileSync(file,'utf8');chmodSync(file,0o400);chmodSync(dir,0o500);
 try{
  // Prove this fixture rejects both overwriting and the old atomic rename approach.
  assert.throws(()=>writeFileSync(file,fixed),{code:'EACCES'});
  assert.throws(()=>writeFileSync(join(dir,'blocked.tmp'),'blocked'),{code:'EACCES'});
  assert.equal((await f.manager.save({revision:f.manager.status().revision,servers:[f.config]})).ok,true);
  assert.deepEqual(f.manager.status().connected,['local']);
  assert.equal((await f.manager.save({revision:f.manager.status().revision,servers:[]})).ok,true);
  assert.equal(readFileSync(file,'utf8'),fixed);
  const reopened=await McpSettings.open(f.root);
  try{assert.deepEqual(reopened.status().servers,[]);assert.deepEqual(reopened.status().connected,[]);assert.equal(reopened.status().applied,true);}finally{reopened.close();}
 }finally{chmodSync(dir,0o700);chmodSync(file,0o600);}
});
test('MCP storage failures preserve the active connector and report a storage error',{skip:process.platform==='win32'||process.getuid?.()===0},async t=>{
 const f=await fixture(t);await f.manager.save({revision:f.manager.status().revision,servers:[f.config]});
 const dir=join(f.root,'state'),before=readFileSync(join(dir,'mcp.json'),'utf8'),active=f.manager.connector;
 chmodSync(dir,0o500);
 try{
  const result=await f.manager.save({revision:f.manager.status().revision,servers:[]});
  assert.equal(result.ok,false);assert.ok('message' in result);assert.match(result.message,/保存先の書き込み権限と空き容量/);
  assert.equal(f.manager.connector,active);assert.deepEqual(active.connections(),['local']);assert.equal(f.manager.status().busy,false);
  assert.equal(readFileSync(join(dir,'mcp.json'),'utf8'),before);
 }finally{chmodSync(dir,0o700);}
 assert.equal((await f.manager.save({revision:f.manager.status().revision,servers:[]})).ok,true);
});
test('MCP saved state rejects unsafe files and cannot override fixed deployment fields',async t=>{
 const f=await fixture(t),file=join(f.root,'state/mcp.json');
 for(const value of [{version:2,servers:[]},{version:1,servers:[],port:9999},{version:1,servers:[f.config,f.config]},'{broken']){
  writeFileSync(file,typeof value==='string'?value:JSON.stringify(value),{mode:0o600});assert.throws(()=>readInstallation(f.root));
 }
 writeFileSync(file,' '.repeat(65537));assert.throws(()=>readInstallation(f.root));unlinkSync(file);
 if(process.platform!=='win32'){
  symlinkSync(join(f.root,'config/niwa.json'),file);assert.throws(()=>readInstallation(f.root));unlinkSync(file);
  writeFileSync(file,JSON.stringify({version:1,servers:[]}),{mode:0o644});assert.throws(()=>readInstallation(f.root));chmodSync(file,0o600);
  const linked=join(f.root,'hardlink');linkSync(file,linked);assert.throws(()=>readInstallation(f.root));unlinkSync(linked);
 }
});
test('MCP settings in state survive backup and installation restore with a consistent configuration snapshot',async t=>{
 const f=await fixture(t);await f.manager.save({revision:f.manager.status().revision,servers:[{...f.config,enabled:false}]});
 const installation=readInstallation(f.root),saved=structuredClone(installation),r=new Runtime(join(f.root,'state'));r.bootstrap(r.administrator());
 const backups=new Backups(r,productPaths(f.root),installation),destination=f.root+'-restored';
 t.after(async()=>{await backups.stop();r.close();rmSync(destination,{recursive:true,force:true});});
 const snapshot=r.snapshot.bind(r);
 r.snapshot=(actor,dir)=>{const names=snapshot(actor,dir);queueMicrotask(()=>{saveMcpInstallation(f.root,[],mcpConfigRevision(installation.mcpServers!));installation.mcpServers=[];});return names;};
 const backup=await backups.create();assert.deepEqual(backup.installation,saved);assert.deepEqual(readInstallation(f.root).mcpServers,[]);
 await backups.stop();r.close();await restoreInstallation(f.root,backup.id,destination);
 assert.deepEqual(readInstallation(destination),saved);
 const restored=await McpSettings.open(destination);
 try{assert.equal(restored.status().servers[0]?.enabled,false);assert.equal(restored.status().applied,true);}finally{restored.close();}
});
test('MCP startup connection failures can be disabled and recovered from saved settings',async t=>{
 const f=await fixture(t),file=join(f.root,'config/niwa.json');
 writeFileSync(file,JSON.stringify({...readInstallation(f.root),mcpServers:[{...f.config,socket:join(f.root,'missing.sock')}]}));
 const reopened=await McpSettings.open(f.root),status=reopened.status();assert.equal(status.applied,false);assert.ok(status.error);assert.equal(status.servers.length,1);
 assert.equal((await reopened.save({revision:status.revision,servers:status.servers.map(s=>({...s,enabled:false}))})).ok,true);assert.equal(reopened.status().error,null);reopened.close();
});
test('a model response obtained before settings changed cannot dispatch to the replacement server',async t=>{
 const f=await fixture(t),replacement=await fixture(t);f.release();replacement.release();
 await f.manager.save({revision:f.manager.status().revision,servers:[f.config]});
 const r=new Runtime(join(f.root,'state')),admin=r.administrator(),leader=r.bootstrap(admin),room=r.createRoom(admin,'人工の切替確認');
 t.after(async()=>r.close());r.tasks.create(admin,leader.id,room.id,'接続を確認');let calls=0;
 const runner=new TurnRunner(r,async()=>({adapter_id:'artificial',capabilities:openAISubscriptionAdapterCapabilities,async *run(request){
  if(request.tools.length===1&&request.tools[0]?.name==='memory_review'){yield {type:'tool_call',tool_call_id:'memory',name:'memory_review',arguments:{memories:[]}};yield {type:'completed',finish_reason:'tool_calls'};return;}
  if(calls++===0){
   assert.ok(request.tools.some(t=>t.name==='mcp_local_write'));
   await f.manager.save({revision:f.manager.status().revision,servers:[{...f.config,socket:replacement.socket}]});
   yield {type:'tool_call',tool_call_id:'old-response',name:'mcp_local_write',arguments:{}};yield {type:'completed',finish_reason:'tool_calls'};
  }else{yield {type:'text_delta',text:'人工確認を完了しました。'};yield {type:'completed',finish_reason:'stop'};}
 }}),{get mcp(){return f.manager.connector;}});
 await runner.run(r.tasks.claim(admin)!,AbortSignal.timeout(3000));
 assert.ok(!f.methods.includes('tools/call'));assert.ok(!replacement.methods.includes('tools/call'));assert.ok(calls>=2);
});
test('MCP settings and probing require administrator authentication and same-origin writes',async t=>{
 const f=await fixture(t),r=new Runtime(join(f.root,'state')),origin='https://niwa.test',key='k'.repeat(43);r.bootstrap(r.administrator());
 const server=createApiServer(r,new WebAuth(origin,key),undefined,undefined,undefined,undefined,undefined,undefined,undefined,f.manager);server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));r.close();});
 const port=(server.address() as {port:number}).port;let cookie='';
 const call=(path:string,method='GET',body?:unknown,requestOrigin=origin)=>new Promise<{status:number;body:any;cookie:string}>((resolve,reject)=>{
  const req=request({host:'127.0.0.1',port,path,method,headers:{host:'niwa.test',origin:requestOrigin,cookie,'Content-Type':'application/json'}},res=>{
   const chunks:Buffer[]=[];res.on('data',chunk=>chunks.push(Buffer.from(chunk)));res.on('end',()=>resolve({status:res.statusCode!,body:JSON.parse(Buffer.concat(chunks).toString()),cookie:res.headers['set-cookie']?.[0]?.split(';')[0]??''}));
  });req.on('error',reject);req.end(body?JSON.stringify(body):undefined);
 });
 const payload={revision:f.manager.status().revision,servers:[f.config]};
 assert.equal((await call('/api/mcp','PUT',payload)).status,401);assert.equal((await call('/api/mcp/probe','POST',{socket:f.socket})).status,401);
 cookie=(await call('/api/login','POST',{key})).cookie;
 assert.equal((await call('/api/mcp','PUT',payload,'http://foreign.test')).status,403);assert.equal((await call('/api/mcp/probe','POST',{socket:f.socket})).body.ok,true);
 const saved=await call('/api/mcp','PUT',payload);assert.equal(saved.status,200);assert.equal(saved.body.applied,true);assert.deepEqual(saved.body.connected,['local']);
 assert.equal((await call('/api/mcp','PUT',payload)).status,409);assert.equal((await call('/api/mcp','PUT',{...payload,unexpected:true})).status,400);
});
