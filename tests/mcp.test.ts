import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,chmodSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {request} from 'node:http';
import {once} from 'node:events';
import {McpConnector,mcpScope} from '../src/tools/mcp/client.ts';
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
