import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,chmodSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {request} from 'node:http';
import {once} from 'node:events';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {McpConnector,mcpRpc,mcpScope,mcpResourceUrl} from '../src/tools/mcp/client.ts';
import {Runtime} from '../src/runtime/runtime.ts';
import {turnTools,executeAsyncTurnTool} from '../src/runtime/turn-tools.ts';
import type {JsonObject} from '../src/contracts/model.ts';
import {WebAuth} from '../src/web/auth.ts';
import {createApiServer} from '../src/web/api.ts';

async function fixture(t:{after:(fn:()=>Promise<void>)=>void},scope:'conversation'|'shared'='conversation',context=true){
 const root=mkdtempSync(join(tmpdir(),'niwa-mcp-'));chmodSync(root,0o700);const socket=join(root,'mcp.sock');
 const calls:JsonObject[]=[],effects=new Map<string,JsonObject>();
 const server=createServer(async(req,res)=>{
  const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const message=JSON.parse(Buffer.concat(chunks).toString());
  if(message.id===undefined){res.writeHead(202);res.end();return;}
  let result:JsonObject={};
  if(message.method==='initialize')result={protocolVersion:'2025-06-18',capabilities:{experimental:{niwaContextV1:context}},serverInfo:{name:'artificial',version:'1'}};
  if(message.method==='tools/list')result={tools:['write','read','unapproved'].map(name=>({name,description:'人工のMCPツール',inputSchema:{type:'object',properties:{text:{type:'string'}},additionalProperties:false}}))};
  if(message.method==='tools/call'){
   calls.push(message.params);const meta=message.params._meta['org.niwa/context'];
   if(message.params.name==='write')effects.set(meta.execution_id,meta);
   result={content:[{type:'text',text:'人工の結果'},{type:'resource_link',uri:'fixture://document',name:'document.txt'}]};
  }
  if(message.method==='resources/read')result={contents:[{uri:message.params.uri,mimeType:'text/plain',text:'人工のファイル'}]};
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:message.id,result}));
 });server.listen(socket);await once(server,'listening');chmodSync(socket,0o600);
 mkdirSync(join(root,'state'));const runtime=new Runtime(join(root,'state'));
 t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));runtime.close();rmSync(root,{recursive:true,force:true});});
 const config={id:'local',socket,scope,tools:[{name:'write',readOnly:false},{name:'read',readOnly:true}]};
 return {root,socket,runtime,calls,effects,config};
}
test('MCP discovers only configured tools and pins caller context and write receipts',async t=>{
 const f=await fixture(t),mcp=await McpConnector.connect([f.config]);
 assert.deepEqual(mcp.tools(false).map(t=>t.name),['mcp_local_write','mcp_local_read']);assert.equal(turnTools(true).some(t=>t.name.startsWith('mcp_')),false);
 const admin=f.runtime.administrator(),leader=f.runtime.bootstrap(admin),actor=f.runtime.agentSession(leader.id),room=f.runtime.createRoom(admin,'人工の会話');
 f.runtime.tasks.create(admin,leader.id,room.id,'人工検証');const lease=f.runtime.tasks.claim(admin)!;
 const call={tool_call_id:'artificial',name:'mcp_local_write',arguments:{text:'fixture'}};
 const result=await executeAsyncTurnTool(f.runtime,actor,lease,call,'0:0',undefined,{mcp});
 await executeAsyncTurnTool(f.runtime,actor,lease,call,'0:0',undefined,{mcp});
 assert.equal(f.calls.length,1);assert.equal(f.effects.size,1);
 const meta=(f.calls[0]!._meta as JsonObject)['org.niwa/context'] as JsonObject;
 assert.equal(meta.scope,mcpScope(f.runtime.workareas.epoch(),room.id));assert.equal(meta.allow_start,true);assert.match(JSON.stringify(result),/\/api\/mcp\/local\/resource/);
 f.runtime.tasks.cancel(admin,lease.task.id);assert.ok((await executeAsyncTurnTool(f.runtime,actor,lease,call,'0:1',undefined,{mcp})).error);assert.equal(f.calls.length,1);
 const resource=await mcp.resource('local','fixture://document',String(meta.scope));assert.equal(resource.data.toString(),'人工のファイル');
});
test('MCP ordinary servers are shared-only and cannot replay unrecorded writes',async t=>{
 const f=await fixture(t,'shared',false),mcp=await McpConnector.connect([f.config]);
 assert.equal(mcp.tools(false).length,0);assert.equal(mcp.tools(true).length,2);
 assert.equal((await mcp.call('mcp_local_write',{}, {scope:mcpScope('epoch','room'),deadline:Date.now()+10000,allow_start:false})).error,'outcome_unknown');assert.equal(f.calls.length,0);
 await assert.rejects(McpConnector.connect([{...f.config,scope:'conversation'}]));
});
test('MCP history retains write and read results with downloads after observation eviction; new reads refresh',async t=>{
 const f=await fixture(t),mcp=await McpConnector.connect([f.config]);
 const admin=f.runtime.administrator(),leader=f.runtime.bootstrap(admin),actor=f.runtime.agentSession(leader.id),room=f.runtime.createRoom(admin,'人工の会話');
 f.runtime.tasks.create(admin,leader.id,room.id,'結果を再確認');const lease=f.runtime.tasks.claim(admin)!,revision=f.runtime.context(actor,room.id).revision;
 for(const name of ['mcp_local_write','mcp_local_read']){
  const call={type:'tool_call' as const,tool_call_id:name,name,arguments:{text:'fixture'}};
  const step=f.runtime.tasks.saveStep(actor,lease,revision,[call,{type:'completed',finish_reason:'tool_calls'}]);
  const before=f.calls.length;
  const output=await executeAsyncTurnTool(f.runtime,actor,lease,call,`${step}:0`,undefined,{mcp});
  assert.deepEqual(await executeAsyncTurnTool(f.runtime,actor,lease,call,`${step}:0`,undefined,{mcp}),output);
  assert.equal(f.calls.length,before+1);
  f.runtime.tasks.observe(actor,lease,`${step}:0`,name,call.arguments,output);
  for(let i=0;i<33;i++)f.runtime.tasks.observe(actor,lease,`${step}:later:${i}`,'workspace_read',{path:String(i)},{content:'later'});
  const history=JSON.parse(String(f.runtime.tasks.readStep(actor,lease,step).text));
  assert.deepEqual(history.tool_results[0].result,output);
  assert.match(JSON.stringify(history),/\/api\/mcp\/local\/resource/);
  assert.equal(history.tool_results[0].result.untrusted,true);
 }
 const before=f.calls.length;
 await executeAsyncTurnTool(f.runtime,actor,lease,{tool_call_id:'fresh',name:'mcp_local_read',arguments:{text:'fixture'}},'fresh:0',undefined,{mcp});
 assert.equal(f.calls.length,before+1);
});
test('MCP rejects unprotected sockets, missing tools and duplicate registrations',async t=>{
 const f=await fixture(t);
 await assert.rejects(McpConnector.connect([{...f.config,tools:[{name:'absent',readOnly:true}]}]));
 await assert.rejects(McpConnector.connect([f.config,f.config]));
 chmodSync(f.socket,0o666);await assert.rejects(McpConnector.connect([f.config]));
});
test('MCP resources are downloadable only after administrator login in a valid conversation',async t=>{
 const f=await fixture(t),mcp=await McpConnector.connect([f.config]);
 const admin=f.runtime.administrator();f.runtime.bootstrap(admin);const room=f.runtime.createRoom(admin,'人工の会話');
 const origin='https://niwa.test',key='k'.repeat(43),server=createApiServer(f.runtime,new WebAuth(origin,key),undefined,undefined,undefined,undefined,undefined,undefined,mcp);
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
 const port=(server.address() as {port:number}).port;let cookie='';
 const call=(path:string,body?:unknown)=>new Promise<{status:number;body:string;cookie:string;attachment:unknown}>((resolve,reject)=>{
  const req=request({host:'127.0.0.1',port,path,method:body?'POST':'GET',headers:{host:'niwa.test',origin,cookie,'Content-Type':'application/json'}},res=>{
   const chunks:Buffer[]=[];res.on('data',chunk=>chunks.push(Buffer.from(chunk)));res.on('end',()=>resolve({status:res.statusCode!,body:Buffer.concat(chunks).toString(),cookie:res.headers['set-cookie']?.[0]?.split(';')[0]??'',attachment:res.headers['content-disposition']}));
  });req.on('error',reject);req.end(body?JSON.stringify(body):undefined);
 });
 const url=`/api/mcp/local/resource?room=${room.id}&uri=fixture%3A%2F%2Fdocument`;
 assert.equal((await call(url)).status,401);assert.equal((await call('/api/mcp')).status,401);
 cookie=(await call('/api/login',{key})).cookie;
 const state=await call('/api/mcp');assert.equal(state.status,200);assert.equal(JSON.parse(state.body).available,true);assert.equal(JSON.parse(state.body).tools.length,2);
 const result=await call(url);assert.equal(result.status,200);assert.equal(result.body,'人工のファイル');assert.equal(result.attachment,'attachment');
 assert.equal((await call('/api/mcp/local/resource?room=absent&uri=fixture://document')).status,404);
});

async function rawServer(t:{after:(fn:()=>Promise<void>)=>void},handle:(message:JsonObject,req:import('node:http').IncomingMessage,res:import('node:http').ServerResponse)=>void){
 const root=mkdtempSync(join(tmpdir(),'niwa-mcp-raw-'));chmodSync(root,0o700);const socket=join(root,'mcp.sock'),seen:{method:string;session:string|undefined}[]=[];
 const server=createServer(async(req,res)=>{
  const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const message=JSON.parse(Buffer.concat(chunks).toString());
  seen.push({method:message.method,session:req.headers['mcp-session-id'] as string|undefined});handle(message,req,res);
 });server.listen(socket);await once(server,'listening');chmodSync(socket,0o600);
 t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(root,{recursive:true,force:true});});
 return {socket,seen};
}
test('MCP accepts SSE replies split across chunks, with multi-byte text, CRLF and unrelated server messages',async t=>{
 const text='日本語の結果'.repeat(5),reply=(id:string)=>[`event: message\r\ndata: ${JSON.stringify({jsonrpc:'2.0',method:'notifications/message',params:{x:1}})}\r\n\r\n`,`data: ${JSON.stringify({jsonrpc:'2.0',id:'other',result:{content:[]}})}\n\n`,`data: {"jsonrpc":"2.0","id":"${id}",\ndata: "result":{"content":[{"type":"text","text":"${text}"}]}}\r\n\r\n`].join('');
 const f=await rawServer(t,(message,_req,res)=>{
  res.writeHead(200,{'Content-Type':'text/event-stream'});const bytes=Buffer.from(reply(String(message.id)));
  let i=0;const timer=setInterval(()=>{if(i>=bytes.length){clearInterval(timer);res.end();return;}res.write(bytes.subarray(i,i+=7));},1);
 });
 const result=await mcpRpc(f.socket,'tools/call',{});assert.equal(JSON.stringify(result),JSON.stringify({content:[{type:'text',text}]}));
});
test('MCP SSE replies stay under the size cap and a stream without the reply fails',async t=>{
 const f=await rawServer(t,(message,_req,res)=>{
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  if(message.method==='tools/list')res.end(`data: ${JSON.stringify({jsonrpc:'2.0',id:message.id,result:{pad:'x'.repeat(2000)}})}\n\n`);
  else res.end(`data: ${JSON.stringify({jsonrpc:'2.0',id:'unrelated',result:{}})}\n\n`);
 });
 await assert.rejects(mcpRpc(f.socket,'tools/list',{},undefined,1000),/too large/);
 await assert.rejects(mcpRpc(f.socket,'other',{}));
});
test('MCP keeps the Mcp-Session-Id, re-initializes once when it expires and accepts 200 notification replies',async t=>{
 let current='',issued=0,stuck=false;
 const f=await rawServer(t,(message,req,res)=>{
  if(message.method==='initialize'){current=`session-${++issued}`;res.writeHead(200,{'Content-Type':'application/json','Mcp-Session-Id':current});res.end(JSON.stringify({jsonrpc:'2.0',id:message.id,result:{protocolVersion:'2025-06-18',capabilities:{}}}));return;}
  if(stuck||req.headers['mcp-session-id']!==current){res.writeHead(404);res.end();return;}
  if(message.id===undefined){res.writeHead(200);res.end('ok');return;}
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:message.id,result:{tools:[]}}));
 });
 const session={} as {id?:string};await McpConnector.discover(f.socket,undefined,session);
 assert.equal(session.id,'session-1');assert.deepEqual(f.seen.map(s=>s.session),[undefined,'session-1','session-1']);
 current='expired';f.seen.length=0;
 await mcpRpc(f.socket,'tools/list',{},undefined,undefined,session);
 assert.deepEqual(f.seen.map(s=>[s.method,s.session]),[['tools/list','session-1'],['initialize',undefined],['notifications/initialized','session-2'],['tools/list','session-2']]);
 stuck=true;f.seen.length=0;
 await assert.rejects(mcpRpc(f.socket,'tools/list',{},undefined,undefined,{id:'session-2'}),/transport failed/);
 assert.deepEqual(f.seen.map(s=>s.method),['tools/list','initialize','notifications/initialized']);
});
test('MCP JSON-RPC errors are propagated as bounded plain text',async t=>{
 const f=await rawServer(t,(message,_req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:message.id,error:{code:-32602,message:`bad\u0000 \u001b[31margument\n${'x'.repeat(500)}`}}));});
 const error=await mcpRpc(f.socket,'tools/call',{}).then(()=>undefined,e=>e as Error);
 assert.ok(error);assert.match(error.message,/^MCP error -32602: bad {1,3}\[31margument x+$/);assert.ok(error.message.length<=200);assert.doesNotMatch(error.message,/[\u0000-\u001f]/);
});
test('markdown links allow only http(s) and MCP resource downloads',async()=>{
 const {safeUrl}=await import(pathToFileURL(resolve('web/src/markdown-url.js')).href);
 const url=mcpResourceUrl('local','room-1','file:///a b?x=1&y=日本');
 assert.equal(safeUrl(url),url);assert.equal(safeUrl('https://example.com/a'),'https://example.com/a');
 for(const bad of ['/api/mcp/local/resource','/api/mcp/Local/resource?room=1','/api/mcp/local/resource?room=1//evil','/api/mcp/local/resource?room=\\evil','//evil.example/api/mcp/local/resource?x=1','/api/other/resource?x=1','/api/mcp/local/resource?a=1\nb','/api/mcp/local/resource/../x?a=1','javascript:alert(1)','/api/mcp/local/resource?room=1#//'])assert.equal(safeUrl(bad),'',bad);
});
