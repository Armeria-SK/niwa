import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,chmodSync,rmSync,statSync,readFileSync,writeFileSync,existsSync,symlinkSync,linkSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {createServer,request,type IncomingMessage,type ServerResponse} from 'node:http';
import {once} from 'node:events';
import {createHash,randomBytes} from 'node:crypto';
import {initializeInstallation,readInstallation} from '../src/config/installation.ts';
import {McpSettings} from '../src/tools/mcp/settings.ts';
import {McpConnector,McpLoginRequired,mcpRpc,mcpScope,mcpEndpointValid,mcpUrl,oauthUrl,type McpEndpoint} from '../src/tools/mcp/client.ts';
import {McpOAuth,parseChallenges} from '../src/tools/mcp/oauth.ts';
import {readMcpOAuth,writeMcpOAuth,listMcpOAuth,mcpOAuthFile,removeMcpOAuth,readMcpOAuthClient,type McpOAuthCredential} from '../src/tools/mcp/oauth-store.ts';
import {Runtime} from '../src/runtime/runtime.ts';
import {WebAuth} from '../src/web/auth.ts';
import {createApiServer} from '../src/web/api.ts';

type After={after:(fn:()=>Promise<void>)=>void};
const until=async(check:()=>boolean,ms=3000)=>{const end=Date.now()+ms;while(!check()&&Date.now()<end)await new Promise(r=>setTimeout(r,10));};
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const body=async(req:IncomingMessage)=>{const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));return Buffer.concat(chunks).toString();};
const send=(res:ServerResponse,status:number,value:unknown,headers:Record<string,string>={})=>{res.writeHead(status,{'Content-Type':'application/json',...headers});res.end(JSON.stringify(value));};
async function listen(t:After,handler:(req:IncomingMessage,res:ServerResponse)=>void|Promise<void>){
 const server=createServer((req,res)=>{Promise.resolve(handler(req,res)).catch(()=>{if(!res.headersSent)res.writeHead(500);res.end();});});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
 return `http://127.0.0.1:${(server.address() as {port:number}).port}`;
}

/** Artificial authorization server: metadata, registration, PKCE-checked code exchange, rotating refresh tokens, revocation. */
async function authorizationServer(t:After){
 const s={url:'',overrides:{} as Record<string,unknown>,codes:new Map<string,{challenge:string;redirect:string;client:string;resource:string}>(),refreshTokens:new Set<string>(),accepted:new Set<string>(),
  tokens:[] as {form:URLSearchParams;auth:string|undefined}[],registrations:[] as Record<string,any>[],revoked:[] as {form:URLSearchParams;auth:string|undefined}[],hits:new Map<string,number>(),redirects:new Set<string>(),
  expiresIn:3600 as number|undefined,omitRefresh:false,omitInitialRefresh:false,tokenLength:0,clientGone:undefined as string|undefined,metadataDelay:0,revokeAll:false,owner:new Map<string,string>(),onRefresh:undefined as (()=>void)|undefined,refreshFailure:undefined as string|undefined,secret:undefined as string|undefined,method:'client_secret_post',delay:0,counter:0,latestRefresh:'',registerStatus:201,revokeStatus:200,tokenType:'Bearer',registration:{} as Record<string,unknown>,
  refreshes:()=>s.tokens.filter(r=>r.form.get('grant_type')==='refresh_token'),
  metadata:()=>{
   const base:Record<string,unknown>={issuer:s.url,authorization_endpoint:`${s.url}/authorize`,token_endpoint:`${s.url}/token`,registration_endpoint:`${s.url}/register`,revocation_endpoint:`${s.url}/revoke`,
    code_challenge_methods_supported:['S256'],response_types_supported:['code'],grant_types_supported:['authorization_code','refresh_token'],token_endpoint_auth_methods_supported:['none','client_secret_post']};
   for(const [key,value] of Object.entries(s.overrides)){if(value===null)delete base[key];else base[key]=value;}
   return base;
  },
  /** The browser step: the provider remembers the PKCE challenge and hands back a code. */
  authorize:(address:string)=>{
   const u=new URL(address),code='code-'+randomBytes(8).toString('hex');
   s.codes.set(code,{challenge:u.searchParams.get('code_challenge')!,redirect:u.searchParams.get('redirect_uri')!,client:u.searchParams.get('client_id')!,resource:u.searchParams.get('resource')!});
   return {code,state:u.searchParams.get('state')!};
  }};
 const issue=(res:ServerResponse,initial:boolean,client:string)=>{
  const pad='a'.repeat(s.tokenLength);
  const access=`at-${++s.counter}-${randomBytes(6).toString('hex')}${pad}`;s.accepted.add(access);
  const omit=initial?s.omitInitialRefresh:s.omitRefresh,next=`rt-${s.counter}-${randomBytes(6).toString('hex')}${pad}`;
  s.owner.set(access,client);if(!omit){s.refreshTokens.add(next);s.latestRefresh=next;s.owner.set(next,client);}
  send(res,200,{access_token:access,token_type:s.tokenType,...(s.expiresIn!==undefined?{expires_in:s.expiresIn}:{}),...(omit?{}:{refresh_token:next}),scope:'mail.read'});
 };
 s.url=await listen(t,async(req,res)=>{
  const path=new URL(req.url!,'http://x').pathname;s.hits.set(path,(s.hits.get(path)??0)+1);
  if(s.redirects.has(path)){res.writeHead(302,{Location:`${s.url}/elsewhere`});res.end();return;}
  if(path==='/.well-known/oauth-authorization-server'){if(s.metadataDelay)await sleep(s.metadataDelay);send(res,200,s.metadata());return;}
  if(path==='/register'){
   const value=JSON.parse(await body(req));s.registrations.push(value);
   send(res,s.registerStatus,{client_id:`client-${s.registrations.length}`,redirect_uris:value.redirect_uris,token_endpoint_auth_method:'none',...s.registration});return;
  }
  if(path==='/revoke'){
   const form=new URLSearchParams(await body(req));s.revoked.push({form,auth:req.headers.authorization});
   // Some providers end every token of the client when one is revoked.
   if(s.revokeAll){const client=s.owner.get(form.get('token')!);for(const [token,owner] of s.owner)if(owner===client){s.accepted.delete(token);s.refreshTokens.delete(token);}}
   res.writeHead(s.revokeStatus);res.end();return;
  }
  if(path==='/token'){
   const form=new URLSearchParams(await body(req));s.tokens.push({form,auth:req.headers.authorization});
   if(s.delay)await sleep(s.delay);
   if(s.clientGone!==undefined&&form.get('client_id')===s.clientGone){send(res,401,{error:'invalid_client'});return;}
   if(s.secret!==undefined){
    const sent=s.method==='client_secret_basic'?req.headers.authorization===`Basic ${Buffer.from(`${encodeURIComponent(form.get('client_id')!)}:${encodeURIComponent(s.secret)}`).toString('base64')}`:form.get('client_secret')===s.secret;
    if(!sent){send(res,401,{error:'invalid_client'});return;}
   }
   if(form.get('grant_type')==='authorization_code'){
    const known=s.codes.get(form.get('code')!);s.codes.delete(form.get('code')!);
    const challenge=createHash('sha256').update(form.get('code_verifier')??'').digest('base64url');
    if(!known||known.challenge!==challenge||known.redirect!==form.get('redirect_uri')||known.client!==form.get('client_id')||known.resource!==form.get('resource')){send(res,400,{error:'invalid_grant'});return;}
    issue(res,true,form.get('client_id')!);return;
   }
   if(form.get('grant_type')==='refresh_token'){
    s.onRefresh?.();
    if(s.refreshFailure){send(res,400,{error:s.refreshFailure});return;}
    const old=form.get('refresh_token')!;
    if(!s.refreshTokens.has(old)){send(res,400,{error:'invalid_grant'});return;}
    if(!s.omitRefresh)s.refreshTokens.delete(old);
    issue(res,false,form.get('client_id')!);return;
   }
  }
  res.writeHead(404);res.end();
 });
 return s;
}
type As=Awaited<ReturnType<typeof authorizationServer>>;

/** Artificial MCP server that wants a Bearer token the authorization server issued. */
async function mcpServer(t:After,as:As){
 const s={url:'',base:'',hits:new Map<string,number>(),calls:[] as {method:string;auth:string|undefined}[],resource:undefined as string|undefined|null,rejectAll:false,hold:undefined as ((auth:string|undefined)=>Promise<void>|undefined)|undefined,prm:true,header:undefined as string|undefined,
  unauthenticated:()=>s.calls.filter(c=>c.auth===undefined).length};
 s.base=await listen(t,async(req,res)=>{
  const path=new URL(req.url!,'http://x').pathname;s.hits.set(path,(s.hits.get(path)??0)+1);
  if(path==='/.well-known/oauth-protected-resource/mcp'&&s.prm){send(res,200,{...(s.resource===null?{}:{resource:s.resource??s.url}),authorization_servers:[as.url],scopes_supported:['mail.read','mail.send']});return;}
  if(path!=='/mcp'||req.method!=='POST'){res.writeHead(404);res.end();return;}
  const message=JSON.parse(await body(req)),auth=req.headers.authorization;s.calls.push({method:message.method,auth});
  await s.hold?.(auth);
  if(s.rejectAll||!auth?.startsWith('Bearer ')||!as.accepted.has(auth.slice(7))){
   res.writeHead(401,{'WWW-Authenticate':s.header??`Bearer realm="mcp", error="invalid_token", resource_metadata="${s.base}/.well-known/oauth-protected-resource/mcp", scope="mail.read"`});res.end();return;
  }
  if(message.id===undefined){res.writeHead(202);res.end();return;}
  let result:unknown={};
  if(message.method==='initialize')result={protocolVersion:'2025-06-18',capabilities:{experimental:{niwaContextV1:true}}};
  if(message.method==='tools/list')result={tools:['mail_search','echo'].map(name=>({name,description:'人工のツール',inputSchema:{type:'object'}}))};
  if(message.method==='tools/call'){
   if(message.params.name==='echo'){
    const echoed=JSON.stringify({auth,refresh:as.latestRefresh});
    if(message.params.arguments?.fail){send(res,200,{jsonrpc:'2.0',id:message.id,error:{code:-32000,message:`failed for ${echoed}`}});return;}
    result={content:[{type:'text',text:echoed}]};
   }else result={content:[{type:'text',text:'人工の結果'}]};
  }
  send(res,200,{jsonrpc:'2.0',id:message.id,result});
 });
 s.url=`${s.base}/mcp`;
 return s;
}

async function niwa(t:After,retry={initial:20,max:40}){
 const root=mkdtempSync(join(tmpdir(),'niwa-mcp-oauth-'));chmodSync(root,0o700);
 initializeInstallation(root,{version:1,origin:'https://niwa.test',port:3000});
 const manager=await McpSettings.open(root,undefined,retry),runtime=new Runtime(join(root,'state')),origin='https://niwa.test';runtime.bootstrap(runtime.administrator());
 const api=createApiServer(runtime,new WebAuth(origin),undefined,undefined,undefined,undefined,undefined,undefined,manager);api.listen(0,'127.0.0.1');await once(api,'listening');
 t.after(async()=>{manager.close();api.closeAllConnections();await new Promise<void>(resolve=>api.close(()=>resolve()));runtime.close();rmSync(root,{recursive:true,force:true});});
 const port=(api.address() as {port:number}).port;
 const call=(path:string,method='GET',payload?:unknown,options:{cookie?:boolean;origin?:string;site?:string}={})=>new Promise<{status:number;text:string;json:any;headers:IncomingMessage['headers']}>((resolve,reject)=>{
  const headers:Record<string,string>={host:'niwa.test','tailscale-user-login':'owner@example.com','Content-Type':'application/json',...(method==='GET'?{}:{origin:options.origin??origin}),...(options.site?{'sec-fetch-site':options.site}:{})};
  const req=request({host:'127.0.0.1',port,path,method,headers},res=>{
   const chunks:Buffer[]=[];res.on('data',chunk=>chunks.push(Buffer.from(chunk)));
   res.on('end',()=>{const text=Buffer.concat(chunks).toString();let json:unknown;try{json=JSON.parse(text);}catch{}resolve({status:res.statusCode!,text,json,headers:res.headers});});
  });req.on('error',reject);req.end(payload===undefined?undefined:JSON.stringify(payload));
 });
 const secret=(name:string)=>join(root,'secrets',name),read=(name:string)=>readFileSync(secret(name),'utf8');
 return {root,manager,call,secret,read,callback:'https://niwa.test/api/mcp/oauth/callback'};
}
type Niwa=Awaited<ReturnType<typeof niwa>>;
const remoteConfig=(url:string,extra:Record<string,unknown>={})=>({id:'remote',url,oauth:true as const,scope:'conversation' as const,tools:[{name:'mail_search',readOnly:true}],...extra});
/** Start through the API, log in at the "provider" and return through the cookie-free callback. */
async function signIn(f:Niwa,as:As,url:string,extra:Record<string,unknown>={},query:(state:string,code:string)=>string=(state,code)=>`state=${state}&code=${code}`){
 const started=await f.call('/api/mcp/oauth/start','POST',{id:'remote',url,...extra});
 assert.equal(started.status,200);assert.equal(started.json.ok,true,JSON.stringify(started.json));
 const {code,state}=as.authorize(started.json.url);
 const done=await f.call(`/api/mcp/oauth/callback?${query(state,code)}`,'GET',undefined,{cookie:false});
 return {started,done,state,code};
}
/** Status of the login for one URL (the first one when none is given) as the screen reads it from the entry. */
const loginStatus=(entry:{logins:{resource:string;status:string}[]}|undefined,resource?:string)=>entry?.logins.find(l=>resource===undefined||l.resource===resource)?.status??'signed_out';
/** File name of the login for one connection ID and URL. */
const credFile=(url:string,id='remote')=>mcpOAuthFile(id,mcpUrl(url)!.href);
/** The stored login of a connection (the one for `resource` when several exist). */
const stored=(f:Niwa,id='remote',resource?:string)=>{const entry=listMcpOAuth(join(f.root,'secrets')).find(e=>e.id===id&&(resource===undefined||e.credential?.resource===resource));return entry!.credential as McpOAuthCredential;};
const toolCtx=()=>({scope:mcpScope('epoch','room'),deadline:Date.now()+10000});

test('OAuth login end to end: discovery, registration, PKCE, cookie-free callback, probe, save and a tool call',async t=>{
 const as=await authorizationServer(t),mcp=await mcpServer(t,as),f=await niwa(t);
 const {started,done}=await signIn(f,as,mcp.url);
 const authorization=new URL(started.json.url);
 assert.equal(authorization.origin+authorization.pathname,`${as.url}/authorize`);
 const q=authorization.searchParams;
 assert.equal(q.get('response_type'),'code');assert.equal(q.get('client_id'),'client-1');assert.equal(q.get('redirect_uri'),f.callback);assert.equal(q.get('code_challenge_method'),'S256');
 assert.match(q.get('code_challenge')!,/^[A-Za-z0-9_-]{43}$/);assert.match(q.get('state')!,/^[A-Za-z0-9_-]{43}$/);assert.equal(q.get('resource'),mcp.url);assert.equal(q.get('scope'),'mail.read');
 assert.ok(started.json.expires_at>Date.now());
 assert.deepEqual(as.registrations[0],{client_name:'Niwa',redirect_uris:[f.callback],grant_types:['authorization_code','refresh_token'],response_types:['code'],token_endpoint_auth_method:'none'});
 assert.equal(done.status,200);assert.match(done.text,/<a href="\/#settings\/mcp">Niwaの画面に戻る<\/a>/);assert.match(done.text,/MCPの接続先にログインしました。Niwaの画面に戻って「接続を確認」を押してください。/);
 assert.equal(done.headers['referrer-policy'],'no-referrer');assert.match(String(done.headers['content-security-policy']),/default-src 'none'/);
 // The authorization code exchange carried the PKCE verifier, redirect and resource.
 const exchange=as.tokens[0]!.form;assert.equal(exchange.get('grant_type'),'authorization_code');assert.equal(exchange.get('resource'),mcp.url);assert.equal(exchange.get('client_id'),'client-1');
 const file=f.secret(credFile(mcp.url)),credential=stored(f);
 assert.equal(statSync(file).mode&0o777,0o600);assert.equal(credential.resource,mcp.url);assert.equal(credential.issuer,as.url);assert.equal(credential.token_endpoint_auth_method,'none');assert.ok(credential.refresh_token);
 const status=await f.call('/api/mcp');
 assert.deepEqual(status.json.oauth,[{id:'remote',pending:false,logins:[{resource:mcp.url,status:'signed_in'}],client_saved:true}]);
 const probe=await f.call('/api/mcp/probe','POST',{url:mcp.url,id:'remote',oauth:true});
 assert.equal(probe.json.ok,true,probe.text);assert.deepEqual(probe.json.tools.map((x:any)=>x.name),['mail_search','echo']);assert.equal(mcp.calls.at(-1)!.auth,`Bearer ${credential.access_token}`);
 const saved=await f.call('/api/mcp','PUT',{revision:status.json.revision,servers:[remoteConfig(mcp.url)]});
 assert.equal(saved.json.ok,true,saved.text);assert.deepEqual(saved.json.connected,['remote']);assert.deepEqual(saved.json.tokens,[]);
 const result=await f.manager.connector.call('mcp_remote_mail_search',{},toolCtx());assert.match(JSON.stringify(result),/人工の結果/);
 // Secrets are only in secrets/: not in config, state, the API or the files' neighbours.
 const secrets=[credential.access_token,credential.refresh_token!];
 for(const text of [readFileSync(join(f.root,'state/mcp.json'),'utf8'),readFileSync(join(f.root,'config/niwa.json'),'utf8'),saved.text,status.text,probe.text,done.text,started.text]){for(const value of secrets)assert.ok(!text.includes(value));}
 assert.equal(JSON.parse(readFileSync(join(f.root,'state/mcp.json'),'utf8')).servers[0].oauth,true);
 assert.equal(readInstallation(f.root).mcpServers![0]!.oauth,true);
 assert.deepEqual(readdirSync(join(f.root,'secrets')).filter(n=>n.startsWith('mcp-')).sort(),[credFile(mcp.url),'mcp-oauth-remote.client.json'].sort());
});

test('OAuth access tokens are renewed before they expire; the rotated refresh token is saved and concurrent callers share one renewal',async t=>{
 const as=await authorizationServer(t),mcp=await mcpServer(t,as),f=await niwa(t),oauth=new McpOAuth(join(f.root,'secrets'));
 as.expiresIn=0;
 const login=async()=>{const s=await oauth.start('remote',mcp.url,undefined,f.callback);assert.equal(s.ok,true);if(!s.ok)return;const {code,state}=as.authorize(s.url);assert.ok(await oauth.finish({state,code}));};
 await login();const first=stored(f);assert.ok(first.expires_at!-Date.now()<=30_000);
 as.expiresIn=3600;
 await mcpRpc({url:mcp.url,oauth:oauth.source('remote',mcp.url)},'tools/list');
 const second=stored(f);assert.equal(as.refreshes().length,1);
 assert.equal(as.refreshes()[0]!.form.get('refresh_token'),first.refresh_token);assert.equal(as.refreshes()[0]!.form.get('resource'),mcp.url);assert.equal(as.refreshes()[0]!.form.get('client_id'),'client-1');
 assert.notEqual(second.refresh_token,first.refresh_token);assert.notEqual(second.access_token,first.access_token);assert.ok(second.expires_at!-Date.now()>3000_000);
 assert.equal(statSync(f.secret(credFile(mcp.url))).mode&0o777,0o600);assert.equal(mcp.calls.at(-1)!.auth,`Bearer ${second.access_token}`);
 // A valid token is not renewed again.
 await mcpRpc({url:mcp.url,oauth:oauth.source('remote',mcp.url)},'tools/list');assert.equal(as.refreshes().length,1);
 // Expired again: six simultaneous requests cause one renewal.
 as.expiresIn=0;await login();as.expiresIn=3600;as.delay=100;const before=as.refreshes().length;
 const endpoint:McpEndpoint={url:mcp.url,oauth:oauth.source('remote',mcp.url)};
 await Promise.all(Array.from({length:6},()=>mcpRpc(endpoint,'tools/list')));
 assert.equal(as.refreshes().length,before+1);
 // A refresh response without a new refresh token keeps the old one.
 as.expiresIn=0;await login();const old=stored(f);as.expiresIn=3600;as.omitRefresh=true;
 await mcpRpc({url:mcp.url,oauth:oauth.source('remote',mcp.url)},'tools/list');
 const kept=stored(f);assert.equal(kept.refresh_token,old.refresh_token);assert.notEqual(kept.access_token,old.access_token);
});

test('an MCP 401 renews the token once and repeats the call; a second 401 asks for a new login without looping',async t=>{
 const as=await authorizationServer(t),mcp=await mcpServer(t,as),f=await niwa(t),oauth=new McpOAuth(join(f.root,'secrets'));
 const s=await oauth.start('remote',mcp.url,undefined,f.callback);assert.equal(s.ok,true);if(!s.ok)return;
 const {code,state}=as.authorize(s.url);assert.ok(await oauth.finish({state,code}));
 const endpoint:McpEndpoint={url:mcp.url,oauth:oauth.source('remote',mcp.url)},old=stored(f).access_token;
 await mcpRpc(endpoint,'tools/list');
 as.accepted.clear();const before=mcp.calls.length;
 const listed=await mcpRpc(endpoint,'tools/list');assert.ok(Array.isArray(listed.tools));
 assert.equal(as.refreshes().length,1);assert.deepEqual(mcp.calls.slice(before).map(c=>c.method),['tools/list','tools/list']);assert.equal(mcp.calls[before]!.auth,`Bearer ${old}`);assert.notEqual(mcp.calls[before+1]!.auth,`Bearer ${old}`);
 // The server keeps refusing: exactly one renewal and one retry, then login_required.
 mcp.rejectAll=true;const refreshes=as.refreshes().length,requests=mcp.calls.length;
 await assert.rejects(mcpRpc(endpoint,'tools/list'),(e:Error)=>e instanceof McpLoginRequired&&e.message==='login_required');
 assert.equal(as.refreshes().length,refreshes+1);assert.equal(mcp.calls.length,requests+2);
 // The login is now marked unusable: no further network traffic until the next login.
 await assert.rejects(mcpRpc(endpoint,'tools/list'),McpLoginRequired);assert.equal(as.refreshes().length,refreshes+1);assert.equal(mcp.calls.length,requests+2);
 assert.equal(loginStatus(oauth.states([]).find(x=>x.id==='remote')!),'needs_login');
 // Tool calls are safe to repeat after a 401 because the first attempt never ran.
 mcp.rejectAll=false;const s2=await oauth.start('remote',mcp.url,undefined,f.callback);if(!s2.ok)throw Error('start');const again=as.authorize(s2.url);assert.ok(await oauth.finish(again));
 const response=await mcpRpc({url:mcp.url,oauth:oauth.source('remote',mcp.url)},'tools/call',{name:'mail_search',arguments:{}});assert.ok(response.content);
});

test('a revoked refresh token marks the login as needed; signing in again reconnects the saved server without a restart',async t=>{
 const as=await authorizationServer(t),mcp=await mcpServer(t,as),f=await niwa(t);
 await signIn(f,as,mcp.url);
 assert.equal((await f.call('/api/mcp','PUT',{revision:(await f.call('/api/mcp')).json.revision,servers:[remoteConfig(mcp.url)]})).json.ok,true);
 // The provider revoked everything.
 as.accepted.clear();as.refreshFailure='invalid_grant';
 await assert.rejects(f.manager.connector.call('mcp_remote_mail_search',{},toolCtx()),McpLoginRequired);
 let status=f.manager.status();
 assert.deepEqual(status.connected,[]);assert.deepEqual(status.failed,[{id:'remote',reason:'login_required'}]);assert.equal(loginStatus(status.oauth[0]!),'needs_login');assert.equal(status.applied,false);
 const refreshes=as.refreshes().length;await sleep(150);
 // Waiting for a login costs no requests.
 assert.equal(as.refreshes().length,refreshes);
 assert.equal((await f.call('/api/mcp/probe','POST',{url:mcp.url,id:'remote',oauth:true})).json.ok,false);
 as.refreshFailure=undefined;await signIn(f,as,mcp.url);
 await until(()=>f.manager.status().connected.includes('remote'));
 status=f.manager.status();assert.deepEqual(status.connected,['remote']);assert.deepEqual(status.failed,[]);assert.equal(loginStatus(status.oauth[0]!),'signed_in');assert.equal(status.applied,true);assert.equal(status.error,null);
 await f.manager.connector.call('mcp_remote_mail_search',{},toolCtx());
});

test('temporary refresh failures are retried and never mistaken for a lost login',async t=>{
 const as=await authorizationServer(t),mcp=await mcpServer(t,as),f=await niwa(t),secrets=join(f.root,'secrets'),oauth=new McpOAuth(secrets);
 as.expiresIn=0;const s=await oauth.start('remote',mcp.url,undefined,f.callback);if(!s.ok)throw Error('start');assert.ok(await oauth.finish(as.authorize(s.url)));as.expiresIn=3600;
 const before=readFileSync(f.secret(credFile(mcp.url)),'utf8');
 const outage=(respond:()=>Response|Promise<Response>)=>new McpOAuth(secrets,{fetcher:(async(input:any,init:any)=>String(input).endsWith('/token')?respond():fetch(input,init)) as typeof fetch});
 for(const flaky of [outage(()=>new Response('busy',{status:503})),outage(()=>{throw new TypeError('fetch failed');}),outage(()=>new Response('<html>',{status:200,headers:{'Content-Type':'text/html'}})),outage(()=>new Response(JSON.stringify({access_token:'x'}),{status:200,headers:{'Content-Type':'application/json'}}))]){
  await assert.rejects(mcpRpc({url:mcp.url,oauth:flaky.source('remote',mcp.url)},'tools/list'),(e:Error)=>!(e instanceof McpLoginRequired)&&e.message==='oauth_refresh_failed');
  assert.equal(loginStatus(flaky.states([])[0]!),'signed_in');assert.equal(readFileSync(f.secret(credFile(mcp.url)),'utf8'),before);
 }
 assert.equal(as.refreshes().length,0);
 await mcpRpc({url:mcp.url,oauth:oauth.source('remote',mcp.url)},'tools/list');assert.equal(as.refreshes().length,1);
});

test('callback states are single use, expire and are validated; only the callback is reachable from the provider\'s site',async t=>{
 const as=await authorizationServer(t),mcp=await mcpServer(t,as),f=await niwa(t),file=credFile(mcp.url);
 const failedPage=(r:{status:number;text:string})=>{assert.equal(r.status,400);assert.match(r.text,/ログインを完了できませんでした。Niwaの設定から、もう一度ログインしてください。/);};
 const fake=randomBytes(32).toString('base64url');
 failedPage(await f.call(`/api/mcp/oauth/callback?state=${fake}&code=abc`,'GET',undefined,{cookie:false}));
 failedPage(await f.call('/api/mcp/oauth/callback?state=short&code=abc','GET',undefined,{cookie:false}));
 failedPage(await f.call('/api/mcp/oauth/callback','GET',undefined,{cookie:false}));
 assert.ok(!existsSync(f.secret(file)));
 // Reuse of a state.
 const first=await signIn(f,as,mcp.url);assert.equal(first.done.status,200);const credential=f.read(file);
 failedPage(await f.call(`/api/mcp/oauth/callback?state=${first.state}&code=${first.code}`,'GET',undefined,{cookie:false}));assert.equal(f.read(file),credential);
 // Ambiguous (duplicate) parameters are refused before the login is looked up, so a forged request cannot burn it.
 const started=await f.call('/api/mcp/oauth/start','POST',{id:'remote',url:mcp.url}),pair=as.authorize(started.json.url);
 failedPage(await f.call(`/api/mcp/oauth/callback?state=${pair.state}&code=${pair.code}&code=other`,'GET',undefined,{cookie:false}));
 failedPage(await f.call(`/api/mcp/oauth/callback?state=${pair.state}&state=${pair.state}&code=${pair.code}`,'GET',undefined,{cookie:false}));
 assert.equal(f.read(file),credential);
 assert.equal((await f.call(`/api/mcp/oauth/callback?state=${pair.state}&code=${pair.code}`,'GET',undefined,{cookie:false})).status,200);assert.notEqual(f.read(file),credential);
 // A return without a code ends that login attempt.
 const bare=as.authorize((await f.call('/api/mcp/oauth/start','POST',{id:'remote',url:mcp.url})).json.url),kept=f.read(file);
 failedPage(await f.call(`/api/mcp/oauth/callback?state=${bare.state}`,'GET',undefined,{cookie:false}));
 failedPage(await f.call(`/api/mcp/oauth/callback?state=${bare.state}&code=${bare.code}`,'GET',undefined,{cookie:false}));assert.equal(f.read(file),kept);
 // The provider reports a refusal: the pending login is dropped.
 rmSync(f.secret(file));
 const refused=as.authorize((await f.call('/api/mcp/oauth/start','POST',{id:'remote',url:mcp.url})).json.url);
 const denied=await f.call(`/api/mcp/oauth/callback?state=${refused.state}&error=access_denied&error_description=no`,'GET',undefined,{cookie:false});
 assert.equal(denied.status,400);assert.match(denied.text,/ログインが取り消されたか、拒否されました/);assert.doesNotMatch(denied.text,/access_denied|no\b/);
 failedPage(await f.call(`/api/mcp/oauth/callback?state=${refused.state}&code=${refused.code}`,'GET',undefined,{cookie:false}));assert.ok(!existsSync(f.secret(file)));
 // A state older than ten minutes is refused.
 const late=as.authorize((await f.call('/api/mcp/oauth/start','POST',{id:'remote',url:mcp.url})).json.url),now=Date.now;
 t.mock.method(Date,'now',()=>now()+10*60_000+1000);
 failedPage(await f.call(`/api/mcp/oauth/callback?state=${late.state}&code=${late.code}`,'GET',undefined,{cookie:false}));t.mock.restoreAll();
 assert.ok(!existsSync(f.secret(file)));
 // The browser comes back from the provider's site; only the callback accepts that. Every other MCP route refuses a request another site sent.
 failedPage(await f.call('/api/mcp/oauth/callback?state=short&code=abc','GET',undefined,{site:'cross-site'}));
 for(const [path,method,payload] of [['/api/mcp','GET',undefined],['/api/mcp/probe','POST',{url:mcp.url}],['/api/mcp/oauth/start','POST',{id:'remote',url:mcp.url}],['/api/mcp/oauth/logout','POST',{id:'remote'}]] as const)
  assert.equal((await f.call(path,method,payload,{site:'cross-site'})).status,403,path);
 assert.equal((await f.call('/api/mcp/oauth/callback','POST',{},{site:'cross-site'})).status,403);
 // Cross-site POSTs are refused by the origin check as for every other write.
 assert.equal((await f.call('/api/mcp/oauth/start','POST',{id:'remote',url:mcp.url},{origin:'http://foreign.test'})).status,403);
});

test('at most eight logins are pending and a new login for the same server replaces the old one',async t=>{
 const as=await authorizationServer(t),mcp=await mcpServer(t,as),f=await niwa(t),oauth=new McpOAuth(join(f.root,'secrets'));
 const begin=async(id:string)=>{const s=await oauth.start(id,mcp.url,undefined,f.callback);if(!s.ok)throw Error(s.code);return as.authorize(s.url);};
 const a=await begin('remote'),b=await begin('remote');
 assert.equal(await oauth.finish(a),undefined);assert.ok(await oauth.finish(b));
 const many=[];for(let i=0;i<9;i++)many.push(await begin(`srv${i}`));
 assert.equal(await oauth.finish(many[0]!),undefined);assert.ok(await oauth.finish(many[8]!));
 assert.deepEqual(listMcpOAuth(join(f.root,'secrets')).map(e=>e.id).sort(),['remote','srv8']);
});

test('discovery refuses mismatched issuers and resources, missing PKCE, insecure endpoints and redirects',async t=>{
 const as=await authorizationServer(t),mcp=await mcpServer(t,as),f=await niwa(t),start=(extra:Record<string,unknown>={})=>f.call('/api/mcp/oauth/start','POST',{id:'remote',url:mcp.url,...extra});
 const refuses=async(code:string)=>{const r=await start();assert.equal(r.status,200);assert.equal(r.json.ok,false,r.text);assert.equal(r.json.code,code,r.text);assert.match(r.json.message,new RegExp(`（${code}）$`));assert.ok(!r.text.includes('code_challenge'));};
 as.overrides={issuer:'http://127.0.0.1:1'};await refuses('issuer_mismatch');
 as.overrides={code_challenge_methods_supported:['plain']};await refuses('pkce_unsupported');
 as.overrides={response_types_supported:['token']};await refuses('unsupported_flow');
 for(const key of ['token_endpoint','authorization_endpoint','registration_endpoint','revocation_endpoint']){as.overrides={[key]:'http://example.com/endpoint'};await refuses('endpoint_insecure');}
 as.overrides={token_endpoint:'https://user:pw@example.com/token'};await refuses('endpoint_insecure');
 as.overrides={authorization_endpoint:null};await refuses('metadata_invalid');
 as.overrides={};mcp.resource='http://127.0.0.1:1/other';await refuses('resource_mismatch');mcp.resource=undefined;
 // A trailing-slash difference alone is accepted.
 mcp.resource=mcp.url+'/';assert.equal((await start()).json.ok,true);mcp.resource=undefined;
 // Redirects are never followed: metadata, registration and token exchange.
 as.redirects.add('/.well-known/oauth-authorization-server');as.redirects.add('/.well-known/openid-configuration');await refuses('discovery_failed');as.redirects.clear();
 as.redirects.add('/register');await refuses('network_error');assert.equal(as.hits.get('/elsewhere')??0,0);as.redirects.clear();
 as.redirects.add('/token');const login=await start(),pair=as.authorize(login.json.url);
 const page=await f.call(`/api/mcp/oauth/callback?state=${pair.state}&code=${pair.code}`,'GET',undefined,{cookie:false});
 assert.equal(page.status,400);assert.equal(as.hits.get('/elsewhere')??0,0);assert.ok(!existsSync(f.secret(credFile(mcp.url))));
 // PRM served through a redirect is not followed either.
 as.redirects.clear();
 const redirecting=await listen(t,(req,res)=>{res.writeHead(307,{Location:`${mcp.base}/.well-known/oauth-protected-resource/mcp`});res.end();});
 mcp.header=`Bearer resource_metadata="${redirecting}/prm"`;assert.equal((await start()).json.code,'discovery_failed');
 mcp.header=`Bearer resource_metadata="http://example.com/prm"`;assert.equal((await start()).json.code,'endpoint_insecure');
});

test('OAuth endpoints on a remote HTTPS server may not point at plain http, even loopback',async t=>{
 const secrets=mkdtempSync(join(tmpdir(),'niwa-oauth-fetch-'));t.after(async()=>rmSync(secrets,{recursive:true,force:true}));
 const hits:string[]=[];
 const make=(token_endpoint:string)=>(async(input:any)=>{
  const url=String(input);hits.push(url);
  const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
  if(url==='https://mcp.example.com/mcp')return new Response('',{status:401,headers:{'WWW-Authenticate':'Bearer resource_metadata="https://mcp.example.com/prm"'}});
  if(url==='https://mcp.example.com/prm')return json({resource:'https://mcp.example.com/mcp',authorization_servers:['https://auth.example.com']});
  if(url==='https://auth.example.com/.well-known/oauth-authorization-server')return json({issuer:'https://auth.example.com',authorization_endpoint:'https://auth.example.com/authorize',token_endpoint,registration_endpoint:'https://auth.example.com/register'});
  if(url==='https://auth.example.com/register')return json({client_id:'c1'},201);
  return new Response('',{status:404});
 }) as typeof fetch;
 const bad=await new McpOAuth(secrets,{fetcher:make('http://127.0.0.1:9/token')}).start('remote','https://mcp.example.com/mcp',undefined,'https://niwa.test/api/mcp/oauth/callback');
 assert.equal(bad.ok,false);assert.equal((bad as {code:string}).code,'endpoint_insecure');assert.ok(!hits.includes('https://auth.example.com/register'));
 const good=await new McpOAuth(secrets,{fetcher:make('https://auth.example.com/token')}).start('remote','https://mcp.example.com/mcp',undefined,'https://niwa.test/api/mcp/oauth/callback');
 assert.equal(good.ok,true);
 assert.equal(oauthUrl('http://localhost:3000/x',true)?.hostname,'localhost');assert.equal(oauthUrl('http://localhost:3000/x',false),undefined);assert.equal(oauthUrl('http://[::1]/x',true)?.hostname,'[::1]');
 for(const value of ['ftp://example.com/x','https://a:b@example.com/x','https://example.com/x#f','https://exa mple.com','https://example.com/\n',42])assert.equal(oauthUrl(value,true),undefined,String(value));
});

test('the issuer parameter of the callback is checked when the provider supports it (RFC 9207) and rejected when wrong',async t=>{
 const as=await authorizationServer(t),mcp=await mcpServer(t,as),f=await niwa(t),file=credFile(mcp.url);
 as.overrides={authorization_response_iss_parameter_supported:true};
 const attempt=(iss:string|undefined)=>signIn(f,as,mcp.url,{},(state,code)=>`state=${state}&code=${code}${iss===undefined?'':`&iss=${encodeURIComponent(iss)}`}`);
 assert.equal((await attempt(undefined)).done.status,400);assert.ok(!existsSync(f.secret(file)));
 assert.equal((await attempt('http://127.0.0.1:1')).done.status,400);assert.ok(!existsSync(f.secret(file)));
 assert.equal((await attempt(as.url)).done.status,200);assert.ok(existsSync(f.secret(file)));rmSync(f.secret(file));
 // Without the flag an iss that is present must still match.
 as.overrides={};
 assert.equal((await attempt(undefined)).done.status,200);rmSync(f.secret(file));
 assert.equal((await attempt('http://127.0.0.1:1')).done.status,400);assert.ok(!existsSync(f.secret(file)));
 assert.equal((await attempt(as.url)).done.status,200);
});

test('token responses are validated before anything is stored; zero, fractional and long lifetimes and 12 KiB tokens are accepted',async t=>{
 const as=await authorizationServer(t),mcp=await mcpServer(t,as),f=await niwa(t),file=credFile(mcp.url);
 as.tokenType='mac';assert.equal((await signIn(f,as,mcp.url)).done.status,400);assert.ok(!existsSync(f.secret(file)));
 as.tokenType='bearer';as.expiresIn=-5;assert.equal((await signIn(f,as,mcp.url)).done.status,400);assert.ok(!existsSync(f.secret(file)));
 // Already expired is allowed with a refresh token (it is renewed before use), not without one.
 as.expiresIn=0;assert.equal((await signIn(f,as,mcp.url)).done.status,200);assert.ok(stored(f).expires_at!<=Date.now());
 rmSync(f.secret(file));as.omitInitialRefresh=true;assert.equal((await signIn(f,as,mcp.url)).done.status,400);assert.ok(!existsSync(f.secret(file)));as.omitInitialRefresh=false;
 as.expiresIn=1.9;assert.equal((await signIn(f,as,mcp.url)).done.status,200);assert.ok(stored(f).expires_at!-Date.now()<=1000);
 as.expiresIn=undefined;assert.equal((await signIn(f,as,mcp.url)).done.status,200);assert.equal(stored(f).expires_at,undefined);
 // Large tokens (Entra-sized JWTs) are kept and sent.
 as.expiresIn=3600;as.tokenLength=12000;assert.equal((await signIn(f,as,mcp.url)).done.status,200);
 const big=stored(f);assert.ok(big.access_token.length>12000&&big.refresh_token!.length>12000);assert.ok(statSync(f.secret(file)).size<65536);
 const oauth=new McpOAuth(join(f.root,'secrets'));
 await mcpRpc({url:mcp.url,oauth:oauth.source('remote',mcp.url)},'tools/list');assert.equal(mcp.calls.at(-1)!.auth,`Bearer ${big.access_token}`);
 as.tokenLength=17000;assert.equal((await signIn(f,as,mcp.url)).done.status,400);assert.equal(stored(f).access_token,big.access_token);
});

test('without a registration endpoint the client ID must be entered; a client secret follows the provider\'s authentication method and is never returned',async t=>{
 const as=await authorizationServer(t),mcp=await mcpServer(t,as),f=await niwa(t),secret='manual-client-secret-value';
 as.overrides={registration_endpoint:null};
 const none=await f.call('/api/mcp/oauth/start','POST',{id:'remote',url:mcp.url});
 assert.equal(none.json.ok,false);assert.equal(none.json.code,'client_registration_required');assert.match(none.json.message,/クライアントID/);assert.equal(as.registrations.length,0);
 assert.equal((await f.call('/api/mcp/oauth/start','POST',{id:'remote',url:mcp.url,client_secret:secret})).status,400);
 assert.equal((await f.call('/api/mcp/oauth/start','POST',{id:'remote',url:mcp.url,client_id:'bad id'})).status,400);
 // client_secret_post
 as.secret=secret;as.method='client_secret_post';
 const post=await signIn(f,as,mcp.url,{client_id:'manual-client',client_secret:secret});
 assert.equal(post.done.status,200);assert.equal(new URL(post.started.json.url).searchParams.get('client_id'),'manual-client');
 assert.equal(as.tokens[0]!.form.get('client_secret'),secret);assert.equal(as.tokens[0]!.auth,undefined);
 assert.equal(stored(f).token_endpoint_auth_method,'client_secret_post');assert.equal(stored(f).client_secret,secret);
 assert.equal(statSync(f.secret(credFile(mcp.url))).mode&0o777,0o600);
 const status=await f.call('/api/mcp');assert.ok(!status.text.includes(secret));assert.ok(!post.started.text.includes(secret));assert.ok(!post.done.text.includes(secret));
 // The refresh request authenticates the same way.
 const oauth=new McpOAuth(join(f.root,'secrets'));
 as.expiresIn=0;await signIn(f,as,mcp.url,{client_id:'manual-client',client_secret:secret});as.expiresIn=3600;
 await mcpRpc({url:mcp.url,oauth:oauth.source('remote',mcp.url)},'tools/list');
 assert.equal(as.refreshes().length,1);assert.equal(as.refreshes()[0]!.form.get('client_secret'),secret);assert.equal(as.refreshes()[0]!.auth,undefined);
 // client_secret_basic when that is all the provider lists
 as.overrides={registration_endpoint:null,token_endpoint_auth_methods_supported:['client_secret_basic']};as.method='client_secret_basic';
 as.expiresIn=0;const basic=await signIn(f,as,mcp.url,{client_id:'manual-client',client_secret:secret});as.expiresIn=3600;
 assert.equal(basic.done.status,200);const last=as.tokens.at(-1)!;
 assert.equal(last.auth,`Basic ${Buffer.from(`manual-client:${secret}`).toString('base64')}`);assert.equal(last.form.get('client_secret'),null);assert.equal(stored(f).token_endpoint_auth_method,'client_secret_basic');
 await mcpRpc({url:mcp.url,oauth:oauth.source('remote',mcp.url)},'tools/list');
 assert.equal(as.refreshes().length,2);assert.equal(as.refreshes()[1]!.auth,`Basic ${Buffer.from(`manual-client:${secret}`).toString('base64')}`);assert.equal(as.refreshes()[1]!.form.get('client_secret'),null);
 // A public client sends no secret at all.
 as.secret=undefined;as.expiresIn=3600;
 const pub=await signIn(f,as,mcp.url,{client_id:'public-client'});assert.equal(pub.done.status,200);assert.equal(stored(f).token_endpoint_auth_method,'none');assert.equal(stored(f).client_secret,undefined);
});

test('a client secret issued by registration is kept for token requests only; unsupported client authentication is refused',async t=>{
 const as=await authorizationServer(t),mcp=await mcpServer(t,as),f=await niwa(t);
 as.secret='registered-secret-value';as.method='client_secret_post';as.registration={client_secret:'registered-secret-value',token_endpoint_auth_method:'client_secret_post'};
 const done=await signIn(f,as,mcp.url);assert.equal(done.done.status,200);
 assert.equal(stored(f).client_secret,'registered-secret-value');assert.ok(!(await f.call('/api/mcp')).text.includes('registered-secret-value'));
 as.registration={client_secret:'x'.repeat(10),token_endpoint_auth_method:'private_key_jwt'};
 assert.equal((await f.call('/api/mcp/oauth/start','POST',{id:'other',url:mcp.url})).json.code,'client_auth_unsupported');
 as.registration={redirect_uris:['https://elsewhere.test/cb']};
 assert.equal((await f.call('/api/mcp/oauth/start','POST',{id:'other',url:mcp.url})).json.code,'registration_failed');
 as.registration={};as.registerStatus=500;assert.equal((await f.call('/api/mcp/oauth/start','POST',{id:'other',url:mcp.url})).json.code,'registration_failed');
});

test('a login is used only for the exact URL it was made for; deleting a connection or leaving OAuth removes it, and OAuth servers take no static token',async t=>{
 const as=await authorizationServer(t),mcp=await mcpServer(t,as),f=await niwa(t),file=credFile(mcp.url);
 as.accepted.add('static-token-0123456789');
 await signIn(f,as,mcp.url);
 const revision=()=>f.manager.status().revision;
 assert.equal((await f.call('/api/mcp','PUT',{revision:revision(),servers:[remoteConfig(mcp.url)]})).json.ok,true);
 // Another URL (same origin, only a query differs) does not use the login.
 const other=mcp.url+'?team=b',before=mcp.calls.length;
 const probe=await f.call('/api/mcp/probe','POST',{url:other,id:'remote',oauth:true});
 assert.equal(probe.json.ok,false);assert.match(probe.json.message,/ログインが必要です/);assert.equal(mcp.calls.length,before);
 const refused=await f.call('/api/mcp','PUT',{revision:revision(),servers:[remoteConfig(other)]});
 assert.equal(refused.json.ok,false);assert.match(refused.json.message,/login_required/);assert.ok(existsSync(f.secret(file)));assert.equal(readInstallation(f.root).mcpServers![0]!.url,mcp.url);
 const states=f.manager.status().oauth;assert.deepEqual(states[0]!.logins,[{resource:mcp.url,status:'signed_in'}]);
 // A static token cannot be set for an OAuth server, not even a removal.
 await assert.rejects(f.manager.save({revision:revision(),servers:[remoteConfig(mcp.url)],tokens:[{id:'remote',value:'static-token-0123456789'}]}),/Tokens apply only/);
 await assert.rejects(f.manager.save({revision:revision(),servers:[remoteConfig(mcp.url)],tokens:[{id:'remote',value:null}]}),/Tokens apply only/);
 assert.ok(!existsSync(f.secret('mcp-token-remote')));
 // OAuth never goes with a socket.
 assert.equal(mcpEndpointValid({socket:'/run/mcp.sock',oauth:true}),false);assert.equal(mcpEndpointValid({url:mcp.url,oauth:true}),true);
 await assert.rejects(f.manager.save({revision:revision(),servers:[{id:'remote',socket:'/run/mcp.sock',oauth:true,scope:'conversation',tools:[{name:'mail_search',readOnly:true}]}]}),/Choose unique IDs and tools/);
 // Switching to a static token removes the login.
 const token=await f.call('/api/mcp','PUT',{revision:revision(),servers:[{...remoteConfig(mcp.url),oauth:undefined}],tokens:[{id:'remote',value:'static-token-0123456789'}]});
 assert.equal(token.json.ok,true,token.text);assert.ok(!existsSync(f.secret(file)));assert.ok(existsSync(f.secret('mcp-token-remote')));assert.deepEqual(token.json.oauth,[]);assert.deepEqual(token.json.tokens,['remote']);
 // And back: a stored static token is removed when the server becomes OAuth.
 await signIn(f,as,mcp.url);
 const back=await f.call('/api/mcp','PUT',{revision:revision(),servers:[remoteConfig(mcp.url)]});
 assert.equal(back.json.ok,true,back.text);assert.ok(!existsSync(f.secret('mcp-token-remote')));assert.ok(existsSync(f.secret(file)));assert.deepEqual(back.json.tokens,[]);
 // Deleting the connection removes the login.
 const gone=await f.call('/api/mcp','PUT',{revision:revision(),servers:[]});
 assert.equal(gone.json.ok,true);assert.ok(!existsSync(f.secret(file)));assert.deepEqual(gone.json.oauth,[]);
 // A login made for a connection that was never saved is cleaned up by the next save.
 await signIn(f,as,mcp.url);assert.ok(existsSync(f.secret(file)));
 assert.equal((await f.call('/api/mcp','PUT',{revision:revision(),servers:[]})).json.ok,true);assert.ok(!existsSync(f.secret(file)));
});

test('a failed configuration write restores removed logins',async t=>{
 const as=await authorizationServer(t),mcp=await mcpServer(t,as),f=await niwa(t),file=credFile(mcp.url);
 await signIn(f,as,mcp.url);const before=f.read(file),state=join(f.root,'state/mcp.json');
 f.manager.status();
 // The saved state cannot be read, so the write that follows the credential removal fails.
 mkdirSync(state);
 try{await assert.rejects(f.manager.save({revision:f.manager.status().revision,servers:[]}));}finally{rmSync(state,{recursive:true});}
 assert.equal(f.read(file),before);assert.equal(statSync(f.secret(file)).mode&0o777,0o600);
});

test('logout removes the login, asks the provider to revoke it (failures ignored) and takes the connection out of service',async t=>{
 const as=await authorizationServer(t),mcp=await mcpServer(t,as),f=await niwa(t),file=credFile(mcp.url);
 await signIn(f,as,mcp.url);const credential=stored(f);
 assert.equal((await f.call('/api/mcp','PUT',{revision:f.manager.status().revision,servers:[remoteConfig(mcp.url)]})).json.ok,true);
 as.revokeStatus=500;
 const pending=await f.call('/api/mcp/oauth/start','POST',{id:'remote',url:mcp.url}),waiting=as.authorize(pending.json.url);
 const out=await f.call('/api/mcp/oauth/logout','POST',{id:'remote'});
 assert.equal(out.status,200);assert.equal(out.json.ok,true);assert.ok(!existsSync(f.secret(file)));
 assert.equal(as.revoked.length,1);assert.equal(as.revoked[0]!.form.get('token'),credential.refresh_token);assert.equal(as.revoked[0]!.form.get('token_type_hint'),'refresh_token');assert.equal(as.revoked[0]!.form.get('client_id'),'client-1');
 const status=(await f.call('/api/mcp')).json;
 assert.deepEqual(status.connected,[]);assert.deepEqual(status.failed,[{id:'remote',reason:'login_required'}]);assert.deepEqual(status.oauth,[{id:'remote',pending:false,logins:[],client_saved:false}]);
 // The pending login was dropped with it.
 assert.equal((await f.call(`/api/mcp/oauth/callback?state=${waiting.state}&code=${waiting.code}`,'GET',undefined,{cookie:false})).status,400);assert.ok(!existsSync(f.secret(file)));
 await assert.rejects(f.manager.connector.call('mcp_remote_mail_search',{},toolCtx()));
 assert.equal((await f.call('/api/mcp/oauth/logout','POST',{id:'Bad id'})).status,400);assert.equal((await f.call('/api/mcp/oauth/logout','POST',{id:'remote',extra:1})).status,400);
 assert.equal((await f.call('/api/mcp/oauth/logout','POST',{id:'unknown'})).json.ok,true);
});

test('a token echoed back by the remote server never reaches errors or tool results',async t=>{
 const as=await authorizationServer(t),mcp=await mcpServer(t,as),f=await niwa(t);
 await signIn(f,as,mcp.url);
 assert.equal((await f.call('/api/mcp/probe','POST',{url:mcp.url,id:'remote',oauth:true})).json.ok,true);
 const config=remoteConfig(mcp.url,{tools:[{name:'echo',readOnly:true}]});
 assert.equal((await f.call('/api/mcp','PUT',{revision:f.manager.status().revision,servers:[config]})).json.ok,true);
 const credential=stored(f),secrets=[credential.access_token,credential.refresh_token!];
 const result=JSON.stringify(await f.manager.connector.call('mcp_remote_echo',{},toolCtx()));
 assert.match(result,/\[REDACTED\]/);for(const value of secrets)assert.ok(!result.includes(value));
 const error=await f.manager.connector.call('mcp_remote_echo',{fail:true},toolCtx()).then(()=>'',e=>(e as Error).message);
 assert.match(error,/^MCP error -32000: failed for/);for(const value of secrets)assert.ok(!error.includes(value));
 // Also when the token is renewed during the call.
 const oauth=new McpOAuth(join(f.root,'secrets')),old=credential.access_token;as.accepted.clear();
 const renewed=await mcpRpc({url:mcp.url,oauth:oauth.source('remote',mcp.url)},'tools/call',{name:'echo',arguments:{fail:true}}).then(()=>'',e=>(e as Error).message);
 assert.ok(!renewed.includes(old));assert.ok(!renewed.includes(stored(f).access_token));assert.ok(!renewed.includes(stored(f).refresh_token!));
 // Bodies and tokens of the provider do not appear in any administrator message either.
 as.accepted.clear();as.refreshFailure='invalid_grant';
 const probe=await f.call('/api/mcp/probe','POST',{url:mcp.url,id:'remote',oauth:true});
 for(const value of [...secrets,stored(f).access_token,stored(f).refresh_token!,'invalid_grant'])assert.ok(!probe.text.includes(value));
});

test('startup with an OAuth server and no usable login still succeeds; the server waits for a login, and a stored login survives a restart',async t=>{
 const as=await authorizationServer(t),mcp=await mcpServer(t,as),f=await niwa(t),root=f.root,config=remoteConfig(mcp.url);
 writeFileSync(join(root,'config/niwa.json'),JSON.stringify({...readInstallation(root),mcpServers:[config]}));
 const open=async()=>{const m=await McpSettings.open(root,undefined,{initial:20,max:40});t.after(async()=>m.close());return m;};
 const waiting=[{id:'remote',reason:'login_required'}];
 let settings=await open(),status=settings.status();
 assert.deepEqual(status.failed,waiting);assert.deepEqual(status.connected,[]);assert.equal(loginStatus(status.oauth[0]!),'signed_out');assert.ok(status.error);
 await sleep(100);assert.equal(mcp.calls.length,0);
 // Unreadable, invalid and unsafe credential files are the same as no login.
 const file=join(root,'secrets',credFile(mcp.url)),valid={version:1,resource:mcp.url,issuer:as.url,token_endpoint:`${as.url}/token`,client_id:'c',token_endpoint_auth_method:'none',access_token:'at-valid-token-123456'};
 writeFileSync(file,'{broken',{mode:0o600});settings=await open();assert.deepEqual(settings.status().failed,waiting);
 writeFileSync(file,JSON.stringify({...valid,extra:true}),{mode:0o600});settings=await open();assert.deepEqual(settings.status().failed,waiting);
 writeFileSync(file,JSON.stringify({...valid,token_endpoint:'http://example.com/token'}),{mode:0o600});settings=await open();assert.deepEqual(settings.status().failed,waiting);
 if(process.platform!=='win32'){writeFileSync(file,JSON.stringify(valid));chmodSync(file,0o644);settings=await open();assert.deepEqual(settings.status().failed,waiting);}
 assert.equal(mcp.calls.length,0);rmSync(file);
 // A login made while the service is running, then a restart: the stored login is used.
 await signIn(f,as,mcp.url);
 settings=await open();status=settings.status();
 assert.deepEqual(status.connected,['remote']);assert.deepEqual(status.failed,[]);assert.equal(loginStatus(status.oauth[0]!),'signed_in');
 await settings.connector.call('mcp_remote_mail_search',{},toolCtx());
});

test('credential files are strictly validated: symlinks, extra links, wide permissions, oversize and malformed content are refused',{skip:process.platform==='win32'},async t=>{
 const dir=mkdtempSync(join(tmpdir(),'niwa-oauth-store-'));t.after(async()=>rmSync(dir,{recursive:true,force:true}));chmodSync(dir,0o700);
 const resource='https://mcp.example.com/mcp',credential:McpOAuthCredential={version:1,resource,issuer:'https://auth.example.com',token_endpoint:'https://auth.example.com/token',client_id:'c1',client_secret:'s3cret-value',token_endpoint_auth_method:'client_secret_post',access_token:'access-token-1234',refresh_token:'refresh-token-1234',expires_at:Date.now()+1000,lifetime:3600,scope:'a b',revocation_endpoint:'https://auth.example.com/revoke'};
 assert.equal(readMcpOAuth(dir,'srv',resource),undefined);
 writeMcpOAuth(dir,'srv',credential);assert.deepEqual(readMcpOAuth(dir,'srv',resource),credential);
 const name=mcpOAuthFile('srv',resource);assert.match(name,/^mcp-oauth-srv-[0-9a-f]{16}\.json$/);assert.equal(statSync(join(dir,name)).mode&0o777,0o600);
 assert.deepEqual(listMcpOAuth(dir),[{id:'srv',file:name,credential}]);assert.deepEqual(readdirSync(dir).filter(n=>n.endsWith('.tmp')),[]);
 for(const bad of [{...credential,access_token:'short'},{...credential,access_token:'with"quote-1234'},{...credential,resource:'https://mcp.example.com'},{...credential,token_endpoint:'http://auth.example.com/token'},{...credential,client_secret:undefined},{...credential,token_endpoint_auth_method:'none' as const},{...credential,version:2} as any,{...credential,extra:1} as any,{...credential,expires_at:-1}])
  assert.throws(()=>writeMcpOAuth(dir,'srv',bad),/Invalid MCP OAuth credential/);
 assert.throws(()=>writeMcpOAuth(dir,'Bad',credential),/Invalid MCP server id/);
 const file=join(dir,name);
 chmodSync(file,0o640);assert.throws(()=>readMcpOAuth(dir,'srv',resource),/Unsafe/);chmodSync(file,0o600);
 linkSync(file,join(dir,'hard'));assert.throws(()=>readMcpOAuth(dir,'srv',resource),/Unsafe/);rmSync(join(dir,'hard'));
 rmSync(file);symlinkSync(join(dir,'elsewhere'),file);assert.throws(()=>readMcpOAuth(dir,'srv',resource));rmSync(file);
 writeFileSync(file,' '.repeat(65537),{mode:0o600});assert.throws(()=>readMcpOAuth(dir,'srv',resource));
 writeFileSync(file,'[]',{mode:0o600});assert.throws(()=>readMcpOAuth(dir,'srv',resource),/Invalid/);
 // A file holding a login for another URL than its name says is refused.
 writeFileSync(file,JSON.stringify({...credential,resource:'https://other.example.com/mcp'}),{mode:0o600});assert.throws(()=>readMcpOAuth(dir,'srv',resource),/Invalid/);
 removeMcpOAuth(dir,'srv',resource);assert.equal(readMcpOAuth(dir,'srv',resource),undefined);removeMcpOAuth(dir,'srv',resource);
 // Several URLs of one connection live side by side.
 const other={...credential,resource:'https://other.example.com/mcp'};
 writeMcpOAuth(dir,'srv',credential);writeMcpOAuth(dir,'srv',other);
 assert.deepEqual(readMcpOAuth(dir,'srv',resource),credential);assert.deepEqual(readMcpOAuth(dir,'srv',other.resource),other);assert.equal(listMcpOAuth(dir).length,2);
 // A public client has no secret.
 const {client_secret:_,...rest}=credential,pub:McpOAuthCredential={...rest,token_endpoint_auth_method:'none'};
 writeMcpOAuth(dir,'pub',pub);assert.deepEqual(readMcpOAuth(dir,'pub',resource),pub);
});

test('WWW-Authenticate challenges are parsed robustly',()=>{
 const bearer=(header:string)=>parseChallenges(header).find(c=>c.scheme==='bearer')?.params;
 assert.deepEqual(bearer('Bearer resource_metadata="https://a.example/prm", scope="mail.read mail.send"'),{resource_metadata:'https://a.example/prm',scope:'mail.read mail.send'});
 assert.deepEqual(bearer('bEaReR Realm="x, y=z", ERROR="invalid_token"'),{realm:'x, y=z',error:'invalid_token'});
 assert.deepEqual(bearer('Basic realm="a", Bearer resource_metadata="https://a.example/prm", error=invalid_token'),{resource_metadata:'https://a.example/prm',error:'invalid_token'});
 assert.deepEqual(parseChallenges('Negotiate abc==, Bearer scope="s"').map(c=>c.scheme),['negotiate','bearer']);
 assert.deepEqual(bearer('Bearer realm="a \\"quoted\\" b", scope=read'),{realm:'a "quoted" b',scope:'read'});
 assert.deepEqual(bearer('Bearer scope="a",scope="b"'),{scope:'a'});
 assert.deepEqual(bearer('Bearer'),{});assert.deepEqual(parseChallenges(''),[]);assert.deepEqual(parseChallenges(null),[]);assert.deepEqual(parseChallenges(undefined),[]);
 assert.deepEqual(parseChallenges('Basic realm="x"').filter(c=>c.scheme==='bearer'),[]);
 assert.doesNotThrow(()=>parseChallenges('Bearer ",,,=="= " \\'));assert.deepEqual(parseChallenges('x'.repeat(9000)),[]);
 assert.deepEqual(bearer('Bearer resource_metadata=https://a.example/prm?x=1,scope=s'),{resource_metadata:'https://a.example/prm?x=1',scope:'s'});
});

test('well-known fallbacks: protected resource metadata by path, then root, then the server origin (legacy)',async t=>{
 const as=await authorizationServer(t),f=await niwa(t),oauth=new McpOAuth(join(f.root,'secrets'));
 const hits:string[]=[];
 // Resource server without WWW-Authenticate hints and with metadata at the origin level.
 const base=await listen(t,async(req,res)=>{
  hits.push(req.method+' '+req.url);
  if(req.url==='/.well-known/oauth-protected-resource'){send(res,200,{authorization_servers:[as.url],scopes_supported:['read']});return;}
  res.writeHead(401);res.end();
 });
 const started=await oauth.start('remote',`${base}/deep/mcp`,undefined,f.callback);
 assert.equal(started.ok,true);if(started.ok)assert.equal(new URL(started.url).searchParams.get('scope'),'read');
 assert.deepEqual(hits,['POST /deep/mcp','GET /.well-known/oauth-protected-resource/deep/mcp','GET /.well-known/oauth-protected-resource']);
 // Legacy server: no protected resource metadata at all, the origin is the authorization server.
 const legacy=await listen(t,async(req,res)=>{
  const origin=`http://${req.headers.host}`;
  if(req.url==='/.well-known/oauth-authorization-server'){send(res,200,{issuer:origin,authorization_endpoint:`${origin}/authorize`,token_endpoint:`${origin}/token`,registration_endpoint:`${origin}/register`});return;}
  if(req.url==='/register'){send(res,201,{client_id:'legacy-client'});return;}
  res.writeHead(401);res.end();
 });
 const old=await oauth.start('legacy',`${legacy}/mcp`,undefined,f.callback);
 assert.equal(old.ok,true);if(old.ok){assert.equal(new URL(old.url).origin,legacy);assert.equal(new URL(old.url).searchParams.get('client_id'),'legacy-client');assert.equal(new URL(old.url).searchParams.get('scope'),null);}
 // The issuer path is used for the metadata locations of the authorization server.
 const asPaths:string[]=[];
 const tenant=await listen(t,async(req,res)=>{
  const origin=`http://${req.headers.host}`;asPaths.push(req.url!);
  if(req.url==='/.well-known/openid-configuration/tenant1'){send(res,200,{issuer:`${origin}/tenant1`,authorization_endpoint:`${origin}/tenant1/authorize`,token_endpoint:`${origin}/tenant1/token`,registration_endpoint:`${origin}/tenant1/register`});return;}
  if(req.url==='/tenant1/register'){send(res,201,{client_id:'tenant-client'});return;}
  if(req.url==='/.well-known/oauth-protected-resource/mcp'){send(res,200,{resource:`${origin}/mcp`,authorization_servers:[`${origin}/tenant1`]});return;}
  res.writeHead(req.method==='POST'?401:404);res.end();
 });
 const t1=await oauth.start('tenant',`${tenant}/mcp`,undefined,f.callback);
 assert.equal(t1.ok,true);assert.deepEqual(asPaths.filter(p=>p.includes('/.well-known/o')&&!p.includes('protected')),['/.well-known/oauth-authorization-server/tenant1','/.well-known/openid-configuration/tenant1']);
});

test('start and callback inputs are validated',async t=>{
 const as=await authorizationServer(t),mcp=await mcpServer(t,as),f=await niwa(t);
 for(const payload of [{url:mcp.url},{id:'remote'},{id:'Remote',url:mcp.url},{id:'remote',url:'http://example.com/mcp'},{id:'remote',url:mcp.url,extra:1},{id:'remote',url:mcp.url+'#x'},{id:'remote',url:'ftp://x'}])
  assert.equal((await f.call('/api/mcp/oauth/start','POST',payload)).status,400,JSON.stringify(payload));
 assert.equal((await f.call('/api/mcp/probe','POST',{url:mcp.url,oauth:true})).status,400);
 assert.equal((await f.call('/api/mcp/probe','POST',{url:mcp.url,id:'remote',oauth:true,token:'static-token-0123'})).status,400);
 assert.equal((await f.call('/api/mcp/probe','POST',{socket:'/run/x.sock',id:'remote',oauth:true})).status,400);
 assert.equal((await f.call('/api/mcp/probe','POST',{url:mcp.url,id:'remote',oauth:true})).json.ok,false);
 assert.equal(mcp.calls.length,0);
});

test('the state of a login in progress is reported without any secret or address',async t=>{
 const as=await authorizationServer(t),mcp=await mcpServer(t,as),f=await niwa(t);
 const started=await f.call('/api/mcp/oauth/start','POST',{id:'remote',url:mcp.url});assert.equal(started.json.ok,true);
 const status=await f.call('/api/mcp');
 assert.deepEqual(status.json.oauth,[{id:'remote',pending:true,logins:[],client_saved:false}]);
 assert.ok(!status.text.includes(started.json.url));assert.ok(!status.text.includes(new URL(started.json.url).searchParams.get('state')!));
});

test('OAuth connections work with McpConnector directly: strict connect fails fast without a login and tools are registered after one',async t=>{
 const as=await authorizationServer(t),mcp=await mcpServer(t,as),f=await niwa(t),oauth=new McpOAuth(join(f.root,'secrets'));
 const config=remoteConfig(mcp.url);
 await assert.rejects(McpConnector.connect([config],undefined,false,{},c=>oauth.source(c.id,c.url!)),McpLoginRequired);
 await assert.rejects(McpConnector.connect([config]),/MCP OAuth unavailable/);
 const tolerant=await McpConnector.connect([config],undefined,true,{},c=>oauth.source(c.id,c.url!));
 assert.deepEqual(tolerant.failed().map(x=>[x.id,x.reason]),[['remote','login_required']]);assert.equal(mcp.calls.length,0);
 const s=await oauth.start('remote',mcp.url,undefined,f.callback);if(!s.ok)throw Error('start');assert.ok(await oauth.finish(as.authorize(s.url)));
 assert.equal(await tolerant.retryFailed(),false);assert.deepEqual(tolerant.connections(),['remote']);
 // A static token passed for an OAuth server is ignored.
 const ignoring=await McpConnector.connect([config],undefined,true,{remote:'static-token-0123456789'},c=>oauth.source(c.id,c.url!));assert.deepEqual(ignoring.connections(),['remote']);
 assert.ok(mcp.calls.every(c=>c.auth===undefined||c.auth.startsWith('Bearer at-')));
});

test('a login for an edited, unsaved URL is kept apart: the saved connection keeps working, the screen sees both, and saving cleans up without revoking what stays',async t=>{
 const as=await authorizationServer(t),mcp=await mcpServer(t,as),f=await niwa(t),{loggedIn,loginNote}=await import(pathToFileURL(resolve('web/src/mcp-login.js')).href);
 await signIn(f,as,mcp.url);
 assert.equal((await f.call('/api/mcp','PUT',{revision:f.manager.status().revision,servers:[remoteConfig(mcp.url)]})).json.ok,true);
 const firstLogin=stored(f);
 // The administrator edits the URL and logs in again before saving.
 const other=mcp.url+'?team=b';mcp.resource=other;
 await signIn(f,as,other);
 // The live connection is untouched and its login still there.
 assert.deepEqual(f.manager.status().connected,['remote']);await f.manager.connector.call('mcp_remote_mail_search',{},toolCtx());
 assert.equal(stored(f,'remote',mcp.url).refresh_token,firstLogin.refresh_token);assert.equal(listMcpOAuth(join(f.root,'secrets')).length,2);
 const status=(await f.call('/api/mcp')).json,entry=status.oauth[0];
 assert.equal(loginStatus(entry,mcp.url),'signed_in');
 assert.deepEqual(entry.logins.map((l:{resource:string})=>l.resource).sort(),[mcp.url,other].sort());
 const draft=(url:string)=>({id:'remote',url,savedId:'remote',savedOAuth:true});
 assert.equal(loggedIn(draft(other),status),true);assert.equal(loginNote(draft(other),status),'');
 assert.equal(loggedIn(draft(mcp.url),status),true);
 assert.equal(loggedIn(draft('https://elsewhere.example.com/mcp'),status),false);assert.match(loginNote(draft('https://elsewhere.example.com/mcp'),status),/別のURL/);
 // Probing uses the login of the URL that is probed.
 assert.equal((await f.call('/api/mcp/probe','POST',{url:other,id:'remote',oauth:true})).json.ok,true);
 assert.equal((await f.call('/api/mcp/probe','POST',{url:mcp.url,id:'remote',oauth:true})).json.ok,true);
 assert.match((await f.call('/api/mcp/probe','POST',{url:mcp.url+'?team=c',id:'remote',oauth:true})).json.message,/ログインが必要です/);
 // A login for a third, never saved URL is cleaned up by the save, and so is the old one once the URL is changed; both are revoked.
 const third=mcp.url+'?team=c';mcp.resource=third;await signIn(f,as,third);assert.equal(listMcpOAuth(join(f.root,'secrets')).length,3);const thirdLogin=stored(f,'remote',third);
 const saved=await f.call('/api/mcp','PUT',{revision:status.revision,servers:[remoteConfig(other)]});
 assert.equal(saved.json.ok,true,saved.text);
 assert.deepEqual(listMcpOAuth(join(f.root,'secrets')).map(e=>e.credential?.resource),[other]);
 // The login that stays shares its client with the ones that went, so the provider is not asked to revoke anything.
 await sleep(150);assert.equal(as.revoked.length,0);assert.ok(as.accepted.has(stored(f,'remote',other).access_token));void firstLogin;void thirdLogin;
 assert.deepEqual(f.manager.status().connected,['remote']);
 assert.equal(loggedIn(draft(other),(await f.call('/api/mcp')).json),true);
 // A login the provider ended is still reported as needing a new one.
 as.accepted.clear();as.refreshFailure='invalid_grant';
 await assert.rejects(f.manager.connector.call('mcp_remote_mail_search',{},toolCtx()),McpLoginRequired);
 const lost=(await f.call('/api/mcp')).json;assert.equal(loginStatus(lost.oauth[0]),'needs_login');assert.equal(loggedIn(draft(other),lost),false);assert.match(loginNote(draft(other),lost),/もう一度ログイン/);
});

test('the resource indicator has no lone trailing slash and the same value is used for login and renewal',async t=>{
 const as=await authorizationServer(t),f=await niwa(t),oauth=new McpOAuth(join(f.root,'secrets'));
 for(const variant of ['bare','slash','missing'] as const){
  let origin='';
  const server=await listen(t,async(req,res)=>{
   if(req.url==='/.well-known/oauth-protected-resource'){send(res,200,{...(variant==='missing'?{}:{resource:variant==='slash'?origin+'/':origin}),authorization_servers:[as.url]});return;}
   if(req.method==='POST'&&req.headers.authorization&&as.accepted.has(req.headers.authorization.slice(7))){send(res,200,{jsonrpc:'2.0',id:JSON.parse(await body(req)).id,result:{tools:[]}});return;}
   res.writeHead(401);res.end();
  });
  origin=server;
  as.expiresIn=0;
  const started=await oauth.start('remote',server,undefined,f.callback);assert.equal(started.ok,true,variant);if(!started.ok)return;
  const expected=variant==='slash'?server+'/':server;
  assert.equal(new URL(started.url).searchParams.get('resource'),expected,variant);
  assert.ok(await oauth.finish(as.authorize(started.url)));
  assert.equal(as.tokens.at(-1)!.form.get('resource'),expected);
  const credential=stored(f,'remote',server+'/');assert.equal(credential.resource,server+'/');assert.equal(credential.audience,expected);
  // Renewal sends the same audience, and the login stays bound to the canonical URL.
  as.expiresIn=3600;
  await mcpRpc({url:server,oauth:oauth.source('remote',server)},'tools/list');
  assert.equal(as.refreshes().at(-1)!.form.get('resource'),expected);
  assert.equal(oauth.states([{id:'remote',url:server,oauth:true}])[0]!.logins.some(l=>l.resource===server+'/'),true);
 }
});

test('the client secret is sent with the method RFC 8414 defaults to when the provider lists none',async t=>{
 const as=await authorizationServer(t),mcp=await mcpServer(t,as),f=await niwa(t),secret='manual-client-secret-value';
 as.secret=secret;as.overrides={registration_endpoint:null,token_endpoint_auth_methods_supported:null};
 const methods:[unknown,string][]=[[null,'client_secret_basic'],[['client_secret_post','client_secret_basic'],'client_secret_basic'],[['client_secret_post'],'client_secret_post'],[['none'],'client_secret_basic']];
 for(const [listed,expected] of methods){
  as.overrides={registration_endpoint:null,token_endpoint_auth_methods_supported:listed};as.method=expected;
  rmSync(f.secret(credFile(mcp.url)),{force:true});
  const done=await signIn(f,as,mcp.url,{client_id:'manual-client',client_secret:secret});
  assert.equal(done.done.status,200,JSON.stringify(listed));assert.equal(stored(f).token_endpoint_auth_method,expected,JSON.stringify(listed));
 }
});

test('deleting a connection while its login is open cancels that login, also while the code exchange is running',async t=>{
 const as=await authorizationServer(t),mcp=await mcpServer(t,as),f=await niwa(t),file=credFile(mcp.url);
 const pair=as.authorize((await f.call('/api/mcp/oauth/start','POST',{id:'remote',url:mcp.url})).json.url);
 assert.equal((await f.call('/api/mcp','PUT',{revision:f.manager.status().revision,servers:[]})).json.ok,true);
 assert.equal((await f.call(`/api/mcp/oauth/callback?state=${pair.state}&code=${pair.code}`,'GET',undefined,{cookie:false})).status,400);
 assert.ok(!existsSync(f.secret(file)));assert.deepEqual((await f.call('/api/mcp')).json.oauth,[]);
 // The exchange is already out when the connection is deleted.
 as.delay=200;
 const late=as.authorize((await f.call('/api/mcp/oauth/start','POST',{id:'remote',url:mcp.url})).json.url);
 const returning=f.call(`/api/mcp/oauth/callback?state=${late.state}&code=${late.code}`,'GET',undefined,{cookie:false});
 await until(()=>as.tokens.length>0);
 assert.equal((await f.call('/api/mcp','PUT',{revision:f.manager.status().revision,servers:[]})).json.ok,true);
 assert.equal((await returning).status,400);assert.ok(!existsSync(f.secret(file)));
 // A login for a connection that is still in the saved list is not touched by an unrelated save.
 as.delay=0;await signIn(f,as,mcp.url);
 const other=as.authorize((await f.call('/api/mcp/oauth/start','POST',{id:'remote',url:mcp.url})).json.url);
 assert.equal((await f.call('/api/mcp','PUT',{revision:f.manager.status().revision,servers:[remoteConfig(mcp.url)]})).json.ok,true);
 assert.equal((await f.call(`/api/mcp/oauth/callback?state=${other.state}&code=${other.code}`,'GET',undefined,{cookie:false})).status,200);
});

test('a second login reuses the client of the first one, with its secret and method, as long as the provider and callback are the same',async t=>{
 const as=await authorizationServer(t),mcp=await mcpServer(t,as),f=await niwa(t),secret='manual-client-secret-value';
 // Registered client.
 await signIn(f,as,mcp.url);const first=stored(f);
 const again=await signIn(f,as,mcp.url);assert.equal(again.done.status,200);
 assert.equal(as.registrations.length,1);assert.equal(stored(f).client_id,first.client_id);assert.equal(new URL(again.started.json.url).searchParams.get('client_id'),first.client_id);
 // Manual client with a secret: the form is not needed again.
 as.overrides={registration_endpoint:null};as.secret=secret;rmSync(f.secret(credFile(mcp.url)));
 await signIn(f,as,mcp.url,{client_id:'manual-client',client_secret:secret});
 const relogin=await signIn(f,as,mcp.url);
 assert.equal(relogin.done.status,200);assert.equal(stored(f).client_id,'manual-client');assert.equal(stored(f).client_secret,secret);assert.equal(stored(f).token_endpoint_auth_method,'client_secret_post');
 assert.equal(as.tokens.at(-1)!.form.get('client_secret'),secret);
 // Another callback address or provider needs its own client.
 const oauth=new McpOAuth(join(f.root,'secrets'));
 const moved=await oauth.start('remote',mcp.url,undefined,'https://other.test/api/mcp/oauth/callback');
 assert.equal(moved.ok,false);assert.equal((moved as {code:string}).code,'client_registration_required');
 const fresh=await oauth.start('other',mcp.url,undefined,f.callback);assert.equal(fresh.ok,false);
});

test('a renewed login that cannot be written yet is kept and used, and written when the disk allows',async t=>{
 const as=await authorizationServer(t),mcp=await mcpServer(t,as),f=await niwa(t),secrets=join(f.root,'secrets'),file=f.secret(credFile(mcp.url));
 const oauth=new McpOAuth(secrets),log=t.mock.method(console,'error',()=>{});
 as.expiresIn=0;const s=await oauth.start('remote',mcp.url,undefined,f.callback);if(!s.ok)throw Error('start');assert.ok(await oauth.finish(as.authorize(s.url)));
 const first=stored(f);as.expiresIn=3600;
 // Writing fails: the credential file is replaced by a directory while the provider renews.
 as.onRefresh=()=>{rmSync(file);mkdirSync(file);as.onRefresh=undefined;};
 const endpoint:McpEndpoint={url:mcp.url,oauth:oauth.source('remote',mcp.url)};
 await mcpRpc(endpoint,'tools/list');
 assert.equal(as.refreshes().length,1);assert.equal(mcp.calls.at(-1)!.auth,`Bearer ${[...as.accepted].at(-1)}`);
 assert.equal(log.mock.callCount(),1);const note=String(log.mock.calls[0]!.arguments.join(' '));
 assert.match(note,/remote/);assert.ok(!note.includes(first.refresh_token!)&&!note.includes([...as.accepted].at(-1)!)&&!note.includes(as.latestRefresh));
 assert.equal(loginStatus(oauth.states([])[0]!),'signed_in');assert.equal((oauth.states([])[0] as {unsaved?:boolean}).unsaved,true);
 // Further calls use the held login without asking the provider again.
 await mcpRpc(endpoint,'tools/list');assert.equal(as.refreshes().length,1);
 assert.ok(oauth.source('remote',mcp.url).secrets().includes(as.latestRefresh));
 // Once the disk works again the next access writes it.
 rmSync(file,{recursive:true});const now=Date.now;t.mock.method(Date,'now',()=>now()+6000);
 await mcpRpc(endpoint,'tools/list');
 assert.equal(stored(f).refresh_token,as.latestRefresh);assert.equal((oauth.states([])[0] as {unsaved?:boolean}).unsaved,undefined);assert.equal(as.refreshes().length,1);
});

test('a refusal that arrives after a new login does not end that login',async t=>{
 const as=await authorizationServer(t),mcp=await mcpServer(t,as),f=await niwa(t),oauth=new McpOAuth(join(f.root,'secrets'));
 const login=async()=>{const s=await oauth.start('remote',mcp.url,undefined,f.callback);if(!s.ok)throw Error('start');assert.ok(await oauth.finish(as.authorize(s.url)));};
 await login();const endpoint:McpEndpoint={url:mcp.url,oauth:oauth.source('remote',mcp.url)};
 as.accepted.clear();
 // The request with the renewed token is held at the server while the administrator logs in again.
 let arrived:()=>void=()=>{},release:()=>void=()=>{};const reached=new Promise<void>(r=>{arrived=r;}),gate=new Promise<void>(r=>{release=r;});
 const first=stored(f).access_token;
 let held=false;
 mcp.hold=auth=>{if(!held&&auth!==`Bearer ${first}`){held=true;arrived();return gate;}return undefined;};
 const running=mcpRpc(endpoint,'tools/list');
 await reached;
 const renewed=stored(f).access_token;assert.notEqual(renewed,first);
 await login();as.accepted.delete(renewed);
 release();
 assert.ok(Array.isArray((await running).tools));
 assert.equal(loginStatus(oauth.states([])[0]!),'signed_in');assert.equal(mcp.calls.at(-1)!.auth,`Bearer ${stored(f).access_token}`);
 // The source tells the caller whether the refused token was still the current one.
 const source=oauth.source('remote',mcp.url);
 assert.equal(source.reject(renewed),false);assert.equal(loginStatus(oauth.states([])[0]!),'signed_in');
 assert.equal(source.reject(stored(f).access_token),true);assert.equal(loginStatus(oauth.states([])[0]!),'needs_login');
});

test('the well-known address of the protected resource keeps the query of the MCP URL',async t=>{
 const as=await authorizationServer(t),f=await niwa(t),oauth=new McpOAuth(join(f.root,'secrets')),hits:string[]=[];
 const server=await listen(t,(req,res)=>{
  hits.push(req.method+' '+req.url);
  if(req.url==='/.well-known/oauth-protected-resource/mcp?team=a'){send(res,200,{resource:`http://${req.headers.host}/mcp?team=a`,authorization_servers:[as.url]});return;}
  res.writeHead(req.method==='POST'?401:404);res.end();
 });
 const started=await oauth.start('remote',`${server}/mcp?team=a`,undefined,f.callback);
 assert.equal(started.ok,true);assert.deepEqual(hits,['POST /mcp?team=a','GET /.well-known/oauth-protected-resource/mcp?team=a']);
 // Without a match the origin-level document is tried next, as before.
 hits.length=0;const bare=await oauth.start('remote',`${server}/mcp?team=b`,undefined,f.callback);
 assert.deepEqual(hits.slice(0,3),['POST /mcp?team=b','GET /.well-known/oauth-protected-resource/mcp?team=b','GET /.well-known/oauth-protected-resource']);void bare;
});

test('a renewal for one URL never hands its token to a request for another URL of the same connection ID',async t=>{
 const as=await authorizationServer(t),mcp=await mcpServer(t,as),f=await niwa(t),oauth=new McpOAuth(join(f.root,'secrets'));
 as.expiresIn=0;const s=await oauth.start('remote',mcp.url,undefined,f.callback);if(!s.ok)throw Error('start');assert.ok(await oauth.finish(as.authorize(s.url)));
 const old=stored(f).access_token;as.expiresIn=3600;as.delay=150;
 const owner=oauth.source('remote',mcp.url),stranger=oauth.source('remote',mcp.url+'?team=b');
 const renewing=owner.refresh(old);
 await until(()=>as.tokens.length>1);
 await assert.rejects(stranger.refresh(old),McpLoginRequired);
 await assert.rejects(stranger.access(),McpLoginRequired);
 assert.equal(await renewing,stored(f).access_token);assert.equal(as.refreshes().length,1);
});

test('a renewed login that is written after an earlier failed write replaces the held one everywhere',async t=>{
 const as=await authorizationServer(t),mcp=await mcpServer(t,as),f=await niwa(t),file=f.secret(credFile(mcp.url)),oauth=new McpOAuth(join(f.root,'secrets'));
 t.mock.method(console,'error',()=>{});
 as.expiresIn=0;const s=await oauth.start('remote',mcp.url,undefined,f.callback);if(!s.ok)throw Error('start');assert.ok(await oauth.finish(as.authorize(s.url)));
 // Renewal 1 cannot be written and is itself short-lived, so renewal 2 follows at once, from the held login.
 as.onRefresh=()=>{rmSync(file);mkdirSync(file);as.onRefresh=undefined;};
 const endpoint:McpEndpoint={url:mcp.url,oauth:oauth.source('remote',mcp.url)};
 await mcpRpc(endpoint,'tools/list');
 const held=as.latestRefresh;assert.equal((oauth.states([])[0] as {unsaved?:boolean}).unsaved,true);
 rmSync(file,{recursive:true});as.expiresIn=3600;
 await mcpRpc(endpoint,'tools/list');
 assert.equal(as.refreshes().length,2);assert.equal(as.refreshes()[1]!.form.get('refresh_token'),held);
 const second=[...as.accepted].at(-1)!;
 assert.equal(stored(f).access_token,second);assert.equal(stored(f).refresh_token,as.latestRefresh);assert.equal(mcp.calls.at(-1)!.auth,`Bearer ${second}`);
 assert.equal((oauth.states([])[0] as {unsaved?:boolean}).unsaved,undefined);
 assert.deepEqual(oauth.source('remote',mcp.url).secrets(),[second,as.latestRefresh]);
 // Later accesses use the stored login and do not write an old one back.
 await mcpRpc(endpoint,'tools/list');assert.equal(stored(f).refresh_token,as.latestRefresh);assert.equal(as.refreshes().length,2);
 // A new login also clears a held one.
 as.expiresIn=0;const relogin=await oauth.start('remote',mcp.url,undefined,f.callback);if(!relogin.ok)throw Error('start');assert.ok(await oauth.finish(as.authorize(relogin.url)));
 as.onRefresh=()=>{rmSync(file);mkdirSync(file);as.onRefresh=undefined;};
 await mcpRpc(endpoint,'tools/list');assert.equal((oauth.states([])[0] as {unsaved?:boolean}).unsaved,true);
 rmSync(file,{recursive:true});as.expiresIn=3600;
 const last=await oauth.start('remote',mcp.url,undefined,f.callback);if(!last.ok)throw Error('start');assert.ok(await oauth.finish(as.authorize(last.url)));
 assert.equal((oauth.states([])[0] as {unsaved?:boolean}).unsaved,undefined);
 assert.deepEqual(oauth.source('remote',mcp.url).secrets(),[stored(f).access_token,stored(f).refresh_token]);
});

test('a start that is still discovering when its connection is deleted cannot leave a login behind',async t=>{
 const as=await authorizationServer(t),mcp=await mcpServer(t,as),f=await niwa(t);
 as.metadataDelay=250;
 const starting=f.call('/api/mcp/oauth/start','POST',{id:'remote',url:mcp.url});
 await until(()=>(as.hits.get('/.well-known/oauth-authorization-server')??0)>0);
 assert.equal((await f.call('/api/mcp','PUT',{revision:f.manager.status().revision,servers:[]})).json.ok,true);
 const result=(await starting).json;
 assert.equal(result.ok,false);assert.equal(result.code,'changed');
 assert.deepEqual((await f.call('/api/mcp')).json.oauth,[]);assert.equal(as.registrations.length<=1,true);
 // Without a configuration change the same start completes.
 as.metadataDelay=0;assert.equal((await f.call('/api/mcp/oauth/start','POST',{id:'remote',url:mcp.url})).json.ok,true);
});

test('a stored client is reused after its login ended but not once the provider refused it, and the client ID can be entered instead',async t=>{
 const as=await authorizationServer(t),mcp=await mcpServer(t,as),f=await niwa(t),oauth=new McpOAuth(join(f.root,'secrets'));
 const login=async(manual?:{client_id:string;client_secret?:string})=>{const s=await oauth.start('remote',mcp.url,manual,f.callback);if(!s.ok)return s;return {...s,done:await oauth.finish(as.authorize(s.url)),client:new URL(s.url).searchParams.get('client_id')};};
 const endpoint=():McpEndpoint=>({url:mcp.url,oauth:oauth.source('remote',mcp.url)});
 // The provider deleted the client: renewal fails with invalid_client.
 as.expiresIn=0;await login();assert.equal(stored(f).client_id,'client-1');as.expiresIn=3600;as.clientGone='client-1';
 await assert.rejects(mcpRpc(endpoint(),'tools/list'),McpLoginRequired);assert.equal(loginStatus(oauth.states([])[0]!),'needs_login');
 const second=await login() as {client:string;done:unknown};
 assert.equal(second.client,'client-2');assert.ok(second.done);assert.equal(as.registrations.length,2);assert.equal(loginStatus(oauth.states([])[0]!),'signed_in');
 // The same happens when the code exchange itself is refused, and the next attempt registers again.
 as.clientGone='client-2';
 const reused=await login() as {client:string;done:unknown};assert.equal(reused.client,'client-2');assert.equal(reused.done,undefined);
 const third=await login() as {client:string;done:unknown};assert.equal(third.client,'client-3');assert.ok(third.done);
 // A login that merely ended keeps its client: nothing has to be typed again, also when the provider has no registration.
 as.clientGone=undefined;as.overrides={registration_endpoint:null};
 const manual=await login({client_id:'typed-client'}) as {client:string;done:unknown};assert.equal(manual.client,'typed-client');assert.ok(manual.done);
 as.expiresIn=0;await login();as.expiresIn=3600;as.refreshFailure='invalid_grant';
 await assert.rejects(mcpRpc(endpoint(),'tools/list'),McpLoginRequired);as.refreshFailure=undefined;
 const again=await login() as {client:string;done:unknown};assert.equal(again.client,'typed-client');assert.ok(again.done);
 // Only a client the provider refused is dropped, and then the form is asked for again.
 as.clientGone='typed-client';
 const refused=await login() as {client:string;done:unknown};assert.equal(refused.client,'typed-client');assert.equal(refused.done,undefined);
 const blocked=await login() as {ok:boolean;code:string};assert.equal(blocked.ok,false);assert.equal(blocked.code,'client_registration_required');
 const typed=await login({client_id:'typed-client-2'}) as {client:string;done:unknown};assert.equal(typed.client,'typed-client-2');assert.ok(typed.done);
});

test('logout revokes the renewed login that was only held in memory',async t=>{
 const as=await authorizationServer(t),mcp=await mcpServer(t,as),f=await niwa(t),file=f.secret(credFile(mcp.url)),oauth=new McpOAuth(join(f.root,'secrets'));
 t.mock.method(console,'error',()=>{});
 as.expiresIn=0;const s=await oauth.start('remote',mcp.url,undefined,f.callback);if(!s.ok)throw Error('start');assert.ok(await oauth.finish(as.authorize(s.url)));
 const original=stored(f).refresh_token;as.expiresIn=3600;
 as.onRefresh=()=>{rmSync(file);mkdirSync(file);as.onRefresh=undefined;};
 await mcpRpc({url:mcp.url,oauth:oauth.source('remote',mcp.url)},'tools/list');
 rmSync(file,{recursive:true});
 await oauth.logout('remote');
 assert.equal(as.revoked.length,1);assert.equal(as.revoked[0]!.form.get('token'),as.latestRefresh);assert.notEqual(as.revoked[0]!.form.get('token'),original);
 assert.ok(!existsSync(file));assert.equal(oauth.states([]).length,0);
});

test('unreadable credentials in a failing renewal keep the screen informed: the unsaved login is reported',async()=>{
 const {loginUnsaved}=await import(pathToFileURL(resolve('web/src/mcp-login.js')).href);
 const card={id:'remote'};
 assert.equal(loginUnsaved(card,{oauth:[{id:'remote',status:'signed_in',unsaved:true}]}),true);
 assert.equal(loginUnsaved(card,{oauth:[{id:'remote',status:'signed_in'}]}),false);assert.equal(loginUnsaved(card,undefined),false);
});

test('logout removes only the login of the URL in the form; a typed-in client stays on file, an automatically registered one does not, and deleting the connection removes and revokes everything',async t=>{
 const as=await authorizationServer(t),mcp=await mcpServer(t,as),f=await niwa(t),secrets=join(f.root,'secrets'),other=mcp.url+'?team=b';
 await signIn(f,as,mcp.url);
 assert.equal((await f.call('/api/mcp','PUT',{revision:f.manager.status().revision,servers:[remoteConfig(mcp.url)]})).json.ok,true);
 mcp.resource=other;await signIn(f,as,other);
 // Registered once, reused for the second URL.
 assert.equal(as.registrations.length,1);assert.equal(stored(f,'remote',other).client_id,stored(f,'remote',mcp.url).client_id);
 // Logging out of the edited URL (spelled with another case) leaves the live connection alone; the client is shared with it, so nothing is revoked at the provider.
 assert.equal((await f.call('/api/mcp/oauth/logout','POST',{id:'remote',url:other.replace('http://','HTTP://')})).json.ok,true);
 assert.deepEqual(listMcpOAuth(secrets).map(e=>e.credential?.resource),[mcp.url]);assert.deepEqual(f.manager.status().connected,['remote']);
 assert.equal(as.revoked.length,0);assert.ok(as.accepted.has(stored(f).access_token));
 // Logging out of the saved URL stops the connection.
 const liveLogin=stored(f);
 assert.equal((await f.call('/api/mcp/oauth/logout','POST',{id:'remote',url:mcp.url})).json.ok,true);
 assert.deepEqual(listMcpOAuth(secrets),[]);assert.deepEqual(f.manager.status().failed,[{id:'remote',reason:'login_required'}]);assert.equal(as.revoked.at(-1)!.form.get('token'),liveLogin.refresh_token);
 // A client that was registered automatically is registered again next time; the server comes back.
 assert.equal(readMcpOAuthClient(secrets,'remote'),undefined);
 mcp.resource=undefined;await signIn(f,as,mcp.url);
 assert.equal(as.registrations.length,2);assert.notEqual(stored(f).client_id,liveLogin.client_id);
 await until(()=>f.manager.status().connected.includes('remote'));
 // A bare logout removes every login of the connection.
 mcp.resource=other;await signIn(f,as,other);mcp.resource=undefined;
 assert.equal((await f.call('/api/mcp/oauth/logout','POST',{id:'remote'})).json.ok,true);assert.deepEqual(listMcpOAuth(secrets),[]);
 // Deleting the connection revokes its login and takes everything else too.
 await signIn(f,as,mcp.url);const doomed=stored(f).refresh_token;
 assert.equal((await f.call('/api/mcp','PUT',{revision:f.manager.status().revision,servers:[]})).json.ok,true);
 assert.deepEqual(listMcpOAuth(secrets),[]);assert.equal(readMcpOAuthClient(secrets,'remote'),undefined);assert.deepEqual(readdirSync(secrets).filter(n=>n.startsWith('mcp-oauth')),[]);
 await until(()=>as.revoked.some(r=>r.form.get('token')===doomed));
 // A client typed by hand is kept the same way.
 as.overrides={registration_endpoint:null};await signIn(f,as,mcp.url,{client_id:'typed-client'});
 await f.call('/api/mcp/oauth/logout','POST',{id:'remote'});
 assert.equal((await signIn(f,as,mcp.url)).done.status,200);assert.equal(stored(f).client_id,'typed-client');
});

test('a login for a URL that is not saved is cancelled when the configuration is saved, also while it is open',async t=>{
 const as=await authorizationServer(t),mcp=await mcpServer(t,as),f=await niwa(t),other=mcp.url+'?team=b';
 await signIn(f,as,mcp.url);
 assert.equal((await f.call('/api/mcp','PUT',{revision:f.manager.status().revision,servers:[remoteConfig(mcp.url)]})).json.ok,true);
 mcp.resource=other;
 const pair=as.authorize((await f.call('/api/mcp/oauth/start','POST',{id:'remote',url:other})).json.url);
 assert.equal((await f.call('/api/mcp')).json.oauth[0].pending,true);
 assert.equal((await f.call('/api/mcp','PUT',{revision:f.manager.status().revision,servers:[{...remoteConfig(mcp.url),enabled:false}]})).json.ok,true);
 assert.equal((await f.call(`/api/mcp/oauth/callback?state=${pair.state}&code=${pair.code}`,'GET',undefined,{cookie:false})).status,400);
 assert.deepEqual(listMcpOAuth(join(f.root,'secrets')).map(e=>e.credential?.resource),[mcp.url]);
 // The saved URL's own pending login survives an unrelated save.
 mcp.resource=undefined;
 const own=as.authorize((await f.call('/api/mcp/oauth/start','POST',{id:'remote',url:mcp.url})).json.url);
 assert.equal((await f.call('/api/mcp','PUT',{revision:f.manager.status().revision,servers:[remoteConfig(mcp.url)]})).json.ok,true);
 assert.equal((await f.call(`/api/mcp/oauth/callback?state=${own.state}&code=${own.code}`,'GET',undefined,{cookie:false})).status,200);
});

test('a short-lived token is renewed when half of its lifetime is gone, not before every request',async t=>{
 const as=await authorizationServer(t),mcp=await mcpServer(t,as),f=await niwa(t),oauth=new McpOAuth(join(f.root,'secrets'));
 as.expiresIn=40;const s=await oauth.start('remote',mcp.url,undefined,f.callback);if(!s.ok)throw Error('start');assert.ok(await oauth.finish(as.authorize(s.url)));
 assert.equal(stored(f).lifetime,40);
 const endpoint:McpEndpoint={url:mcp.url,oauth:oauth.source('remote',mcp.url)};
 // A probe is three requests: none of them renews.
 for(let i=0;i<3;i++)await mcpRpc(endpoint,'tools/list');
 assert.equal(as.refreshes().length,0);
 // After 25 s 15 s are left, less than half of 40 s.
 const now=Date.now;t.mock.method(Date,'now',()=>now()+25_000);
 as.expiresIn=7200;await mcpRpc(endpoint,'tools/list');await mcpRpc(endpoint,'tools/list');
 assert.equal(as.refreshes().length,1);assert.equal(stored(f).lifetime,7200);
 // A long-lived token still renews 60 s before its end.
 t.mock.method(Date,'now',()=>now()+25_000+7200_000-61_000);await mcpRpc(endpoint,'tools/list');assert.equal(as.refreshes().length,1);
 t.mock.method(Date,'now',()=>now()+25_000+7200_000-59_000);as.expiresIn=7200;await mcpRpc(endpoint,'tools/list');assert.equal(as.refreshes().length,2);
});

test('the reason of a failed login is kept per connection for the screen and logged without secrets',async t=>{
 const as=await authorizationServer(t),mcp=await mcpServer(t,as),f=await niwa(t),log=t.mock.method(console,'error',()=>{}),{loginFailure}=await import(pathToFileURL(resolve('web/src/mcp-login.js')).href);
 const failure=async()=>(await f.call('/api/mcp')).json.oauth.find((o:{id:string})=>o.id==='remote')?.failure;
 const card={id:'remote',url:mcp.url};
 // The provider refuses.
 const start=async()=>{const url=(await f.call('/api/mcp/oauth/start','POST',{id:'remote',url:mcp.url})).json.url as string;return {...as.authorize(url),client:new URL(url).searchParams.get('client_id')!};};
 const denied=await start();
 await f.call(`/api/mcp/oauth/callback?state=${denied.state}&error=access_denied`,'GET',undefined,{cookie:false});
 assert.equal((await failure()).code,'access_denied');assert.ok(Math.abs((await failure()).at-Date.now())<5000);
 assert.match(loginFailure(card,(await f.call('/api/mcp')).json),/^ログインに失敗しました（access_denied）。/);
 // A new start clears the old reason.
 const expired=await start();assert.equal(await failure(),undefined);
 const now=Date.now;t.mock.method(Date,'now',()=>now()+11*60_000);
 await f.call(`/api/mcp/oauth/callback?state=${expired.state}&code=${expired.code}`,'GET',undefined,{cookie:false});t.mock.restoreAll();
 assert.equal((await failure()).code,'state_expired');
 // The provider rejects the client at the token endpoint.
 const refused=await start();as.clientGone=refused.client;
 const log2=t.mock.method(console,'error',()=>{});
 await f.call(`/api/mcp/oauth/callback?state=${refused.state}&code=${refused.code}`,'GET',undefined,{cookie:false});
 assert.equal((await failure()).code,'invalid_client');assert.match(loginFailure(card,(await f.call('/api/mcp')).json),/クライアントIDとシークレットを確認/);
 // A start that cannot discover anything.
 as.clientGone=undefined;as.overrides={issuer:'http://127.0.0.1:1'};
 const bad=await f.call('/api/mcp/oauth/start','POST',{id:'remote',url:mcp.url});assert.equal(bad.json.ok,false);assert.equal((await failure()).code,'issuer_mismatch');
 // The log has one line per failure with the connection and the code, nothing else.
 const lines=[...log.mock.calls,...log2.mock.calls].map(c=>String(c.arguments.join(' ')));
 for(const code of ['access_denied','state_expired','invalid_client','issuer_mismatch'])assert.ok(lines.some(l=>l===`MCP OAuth: login of "remote" failed (${code})`),code);
 for(const line of lines)assert.doesNotMatch(line,/code-|state=|client-|at-\d|rt-\d/);
 // A login that works clears it.
 as.overrides={};await signIn(f,as,mcp.url);assert.equal(await failure(),undefined);
 // A start that needs the client ID is shown by the card's own form, not as a failure line.
 await f.call('/api/mcp/oauth/logout','POST',{id:'remote'});rmSync(join(f.root,'secrets','mcp-oauth-remote.client.json'),{force:true});
 as.overrides={registration_endpoint:null};await f.call('/api/mcp/oauth/start','POST',{id:'remote',url:mcp.url});
 assert.equal((await failure()).code,'client_registration_required');assert.equal(loginFailure(card,(await f.call('/api/mcp')).json),'');
});

test('when every failed connection waits for a login the form says so, otherwise it keeps the general message',async t=>{
 const as=await authorizationServer(t),mcp=await mcpServer(t,as),f=await niwa(t);
 writeFileSync(join(f.root,'config/niwa.json'),JSON.stringify({...readInstallation(f.root),mcpServers:[remoteConfig(mcp.url)]}));
 const settings=await McpSettings.open(f.root,undefined,{initial:60000,max:60000});t.after(()=>settings.close());
 assert.equal(settings.status().error,'ログインが必要な接続があります。各接続の「ログイン」からログインしてください。');
 writeFileSync(join(f.root,'config/niwa.json'),JSON.stringify({...readInstallation(f.root),mcpServers:[remoteConfig(mcp.url),{id:'late',socket:join(f.root,'none.sock'),scope:'conversation',tools:[{name:'read',readOnly:true}]}]}));
 const mixed=await McpSettings.open(f.root,undefined,{initial:60000,max:60000});t.after(()=>mixed.close());
 assert.match(String(mixed.status().error),/接続できませんでした/);
});

test('a card that waits for its login says so once, however many places could repeat it',async()=>{
 const {loginState,connectionState,connectionError}=await import(pathToFileURL(resolve('web/src/mcp-login.js')).href);
 const card={id:'remote',url:'https://mcp.example.com/mcp',auth:'oauth',enabled:true,savedId:'remote',savedOAuth:true};
 const status={connected:[],failed:[{id:'remote',reason:'login_required'}],oauth:[{id:'remote',status:'signed_out',pending:false,logins:[]}]};
 const texts=[loginState(card,status),connectionState(card,status,false),connectionError(card,status,false)];
 assert.equal(texts.filter(text=>text.includes('ログインが必要です')).length,1);
 assert.equal(connectionState(card,status,false),'未接続');assert.equal(connectionError(card,status,false),'');
 // Other failures, and connections that do not use OAuth, keep their own wording.
 const down={connected:[],failed:[{id:'remote',reason:'ECONNREFUSED'}],oauth:status.oauth};
 assert.equal(connectionState(card,down,false),'接続失敗（自動で再試行します）');assert.equal(connectionError(card,down,false),'接続できません: ECONNREFUSED');
 assert.match(connectionError({...card,auth:'token'},status,false),/ログインが必要です/);
 assert.equal(connectionState(card,{...status,connected:['remote']},false),'接続済み');assert.equal(connectionState(card,status,true),'未保存の変更あり');
 assert.equal(loginState(card,{oauth:[{id:'remote',pending:true,logins:[]}]}),'ログインを待っています');
});

test('a renewal that is out when the saved URL moves is discarded: nothing of the old URL comes back',async t=>{
 const as=await authorizationServer(t),mcp=await mcpServer(t,as),f=await niwa(t),secrets=join(f.root,'secrets'),other=mcp.url+'?team=b';
 as.expiresIn=0;await signIn(f,as,mcp.url);
 assert.equal((await f.call('/api/mcp','PUT',{revision:f.manager.status().revision,servers:[remoteConfig(mcp.url)]})).json.ok,true);
 as.expiresIn=3600;mcp.resource=other;await signIn(f,as,other);
 // The live connection renews (the provider is slow) while the administrator saves the other URL.
 as.delay=300;const before=as.refreshes().length;
 const running=f.manager.connector.call('mcp_remote_mail_search',{},toolCtx()).then(()=>'done',e=>(e as Error).message);
 await until(()=>as.refreshes().length>before);
 const saved=await f.call('/api/mcp','PUT',{revision:f.manager.status().revision,servers:[remoteConfig(other)]});
 assert.equal(saved.json.ok,true,saved.text);
 assert.equal(await running,'login_required');await sleep(100);
 assert.deepEqual(listMcpOAuth(secrets).map(e=>e.credential?.resource),[other]);
 const status=(await f.call('/api/mcp')).json.oauth[0];
 assert.deepEqual(status.logins,[{resource:other,status:'signed_in'}]);assert.equal(status.unsaved,undefined);
});

test('a client the provider no longer knows is forgotten on disk, so it is not tried again after a restart; automatically registered clients are dropped on logout, typed ones stay',async t=>{
 const as=await authorizationServer(t),mcp=await mcpServer(t,as),f=await niwa(t),secrets=join(f.root,'secrets');
 const fresh=()=>new McpOAuth(secrets);
 const login=async(oauth:McpOAuth,manual?:{client_id:string})=>{const s=await oauth.start('remote',mcp.url,manual,f.callback);if(!s.ok)return s;return {...s,client:new URL(s.url).searchParams.get('client_id')!,done:await oauth.finish(as.authorize(s.url))};};
 // (a) refused when renewing.
 let oauth=fresh();as.expiresIn=0;const first=await login(oauth) as {client:string};as.expiresIn=3600;
 assert.equal(readMcpOAuthClient(secrets,'remote')?.origin,'registered');
 as.clientGone=first.client;
 await assert.rejects(mcpRpc({url:mcp.url,oauth:oauth.source('remote',mcp.url)},'tools/list'),McpLoginRequired);
 assert.equal(readMcpOAuthClient(secrets,'remote'),undefined);
 oauth=fresh();const second=await login(oauth) as {client:string;done:unknown};
 assert.notEqual(second.client,first.client);assert.ok(second.done);assert.equal(as.registrations.length,2);
 // (a) refused at the token endpoint of a new login, with a fresh instance each time.
 as.clientGone=second.client;
 const refused=await login(fresh()) as {client:string;done:unknown};assert.equal(refused.client,second.client);assert.equal(refused.done,undefined);
 assert.equal(readMcpOAuthClient(secrets,'remote'),undefined);
 const third=await login(fresh()) as {client:string;done:unknown};assert.notEqual(third.client,second.client);assert.ok(third.done);
 // (b) an automatically registered client goes with the logout, also for a fresh instance.
 as.clientGone=undefined;assert.ok(readMcpOAuthClient(secrets,'remote'));
 await fresh().logout('remote');assert.equal(readMcpOAuthClient(secrets,'remote'),undefined);
 const registrations=as.registrations.length;await login(fresh());assert.equal(as.registrations.length,registrations+1);
 // (b) a client typed by hand stays, also across instances, and a record without origin is kept like one.
 as.overrides={registration_endpoint:null};await fresh().logout('remote');
 assert.ok((await login(fresh(),{client_id:'typed-client'}) as {done:unknown}).done);assert.equal(readMcpOAuthClient(secrets,'remote')?.origin,'manual');
 await fresh().logout('remote');assert.equal(readMcpOAuthClient(secrets,'remote')?.client_id,'typed-client');
 const again=await login(fresh()) as {client:string;done:unknown};assert.equal(again.client,'typed-client');assert.ok(again.done);
});

test('revoking a login that goes does not end the login that stays when both use the same client',async t=>{
 const as=await authorizationServer(t),mcp=await mcpServer(t,as),f=await niwa(t),secrets=join(f.root,'secrets'),other=mcp.url+'?team=b';
 as.revokeAll=true;
 await signIn(f,as,mcp.url);mcp.resource=other;await signIn(f,as,other);
 assert.equal(stored(f,'remote',mcp.url).client_id,stored(f,'remote',other).client_id);
 const keep=stored(f,'remote',other);
 // Saving the edited URL drops the old login.
 assert.equal((await f.call('/api/mcp','PUT',{revision:f.manager.status().revision,servers:[remoteConfig(other)]})).json.ok,true);
 await sleep(150);assert.equal(as.revoked.length,0);assert.ok(as.accepted.has(keep.access_token));
 assert.equal((await f.call('/api/mcp/probe','POST',{url:other,id:'remote',oauth:true})).json.ok,true);
 // Logging out of a draft URL is the same.
 mcp.resource=mcp.url+'?team=c';await signIn(f,as,mcp.url+'?team=c');
 assert.equal((await f.call('/api/mcp/oauth/logout','POST',{id:'remote',url:mcp.url+'?team=c'})).json.ok,true);
 assert.equal(as.revoked.length,0);assert.ok(as.accepted.has(keep.access_token));
 // With a client of its own the dropped login is revoked, and the one that stays is untouched.
 rmSync(join(secrets,'mcp-oauth-remote.client.json'),{force:true});
 const draft=mcp.url+'?team=d';mcp.resource=draft;await signIn(f,as,draft);
 assert.notEqual(stored(f,'remote',draft).client_id,keep.client_id);const gone=stored(f,'remote',draft);
 assert.equal((await f.call('/api/mcp/oauth/logout','POST',{id:'remote',url:draft})).json.ok,true);
 assert.deepEqual(as.revoked.map(r=>r.form.get('token')),[gone.refresh_token]);assert.ok(as.accepted.has(keep.access_token));
 // Without any other login the last one is revoked.
 assert.equal((await f.call('/api/mcp/oauth/logout','POST',{id:'remote'})).json.ok,true);
 assert.equal(as.revoked.length,2);assert.equal(as.revoked[1]!.form.get('token'),keep.refresh_token);
});

test('logging in again for the same URL revokes the login it replaces, unless the new one shares its client',async t=>{
 const as=await authorizationServer(t),mcp=await mcpServer(t,as),f=await niwa(t),secrets=join(f.root,'secrets');
 as.revokeAll=true;
 // Same provider and client: the provider would end both, so the old one is only overwritten.
 await signIn(f,as,mcp.url);const first=stored(f);
 await signIn(f,as,mcp.url);const second=stored(f);
 assert.equal(second.client_id,first.client_id);assert.notEqual(second.refresh_token,first.refresh_token);
 await sleep(150);assert.equal(as.revoked.length,0);assert.ok(as.accepted.has(second.access_token));
 // Another client: the replaced login is revoked and the new one is not touched.
 rmSync(join(secrets,'mcp-oauth-remote.client.json'));
 await signIn(f,as,mcp.url);const third=stored(f);
 assert.notEqual(third.client_id,second.client_id);
 await until(()=>as.revoked.length>0);
 assert.deepEqual(as.revoked.map(r=>r.form.get('token')),[second.refresh_token]);
 assert.ok(as.accepted.has(third.access_token));assert.ok(!as.accepted.has(second.access_token));
 // A first login has nothing to revoke.
 rmSync(join(secrets,credFile(mcp.url)));await signIn(f,as,mcp.url);await sleep(100);assert.equal(as.revoked.length,1);
});

test('a login failure is shown only for its own URL and only until that URL is signed in again after it',async t=>{
 const as=await authorizationServer(t),mcp=await mcpServer(t,as),f=await niwa(t),{loginFailure,failureFor}=await import(pathToFileURL(resolve('web/src/mcp-login.js')).href);
 const other=mcp.url+'?team=b',card=(url:string)=>({id:'remote',url});
 as.expiresIn=0;await signIn(f,as,mcp.url);as.expiresIn=3600;
 // A later attempt fails while the old login is still there.
 await sleep(5);
 const denied=as.authorize((await f.call('/api/mcp/oauth/start','POST',{id:'remote',url:mcp.url})).json.url);
 await f.call(`/api/mcp/oauth/callback?state=${denied.state}&error=access_denied`,'GET',undefined,{cookie:false});
 let status=(await f.call('/api/mcp')).json;
 assert.equal(loginStatus(status.oauth[0],mcp.url),'signed_in');assert.equal(status.oauth[0].failure.code,'access_denied');assert.equal(status.oauth[0].failure.resource,mcp.url);
 // The failure belongs to that URL: another draft URL does not show it.
 assert.match(loginFailure(card(mcp.url),status),/access_denied/);
 assert.equal(failureFor(card(other),status),undefined);assert.equal(loginFailure(card(other),status),'');
 // The old login is renewed afterwards (a newer login for the same URL): the failure is no longer reported.
 await sleep(5);
 const oauthSource=new McpOAuth(join(f.root,'secrets')).source('remote',mcp.url);
 await mcpRpc({url:mcp.url,oauth:oauthSource},'tools/list');
 assert.ok(as.refreshes().length>=1);
 status=(await f.call('/api/mcp')).json;
 assert.equal(status.oauth[0].failure,undefined);assert.equal(loginFailure(card(mcp.url),status),'');
 // A failure for a URL without any login stays until that URL is signed in.
 mcp.resource=other;
 const bad=await f.call('/api/mcp/oauth/start','POST',{id:'remote',url:other});assert.equal(bad.json.ok,true);
 const refused=as.authorize(bad.json.url);await f.call(`/api/mcp/oauth/callback?state=${refused.state}&error=access_denied`,'GET',undefined,{cookie:false});
 status=(await f.call('/api/mcp')).json;assert.equal(status.oauth[0].failure.resource,other);
 assert.match(loginFailure(card(other),status),/access_denied/);assert.equal(loginFailure(card(mcp.url),status),'');
});

test('the client ID form is offered when it may be needed and can be closed again',async()=>{
 const {clientChoice}=await import(pathToFileURL(resolve('web/src/mcp-login.js')).href);
 const card=(patch:Record<string,unknown>={})=>({id:'remote',url:'https://mcp.example.com/mcp',needClient:false,...patch});
 const signedIn={oauth:[{id:'remote',logins:[{resource:'https://mcp.example.com/mcp',status:'signed_in'}]}]};
 const signedOut={oauth:[{id:'remote',logins:[]}]};
 assert.equal(clientChoice(card(),signedIn),false);
 assert.equal(clientChoice(card(),signedOut),true);
 assert.equal(clientChoice(card({url:'https://other.example.com/mcp'}),signedIn),true);
 // Open forms can always be closed, and client trouble reopens the choice even for a signed-in URL.
 assert.equal(clientChoice(card({needClient:true}),signedIn),true);
 for(const code of ['invalid_client','client_registration_required'])assert.equal(clientChoice(card(),{oauth:[{...signedIn.oauth[0]!,failure:{code,at:1,resource:'https://mcp.example.com/mcp'}}]}),true);
 assert.equal(clientChoice(card(),{oauth:[{...signedIn.oauth[0]!,failure:{code:'access_denied',at:1,resource:'https://mcp.example.com/mcp'}}]}),false);
 assert.equal(clientChoice(card(),{oauth:[{...signedIn.oauth[0]!,failure:{code:'invalid_client',at:1,resource:'https://elsewhere.example.com/mcp'}}]}),false);
});

test('a wrong secret typed for the stored client does not delete it; only the stored client itself is dropped when refused',async t=>{
 const as=await authorizationServer(t),mcp=await mcpServer(t,as),f=await niwa(t),secrets=join(f.root,'secrets'),secret='stored-client-secret-value';
 as.overrides={registration_endpoint:null};as.secret=secret;as.method='client_secret_post';
 assert.equal((await signIn(f,as,mcp.url,{client_id:'typed-client',client_secret:secret})).done.status,200);
 const kept=readMcpOAuthClient(secrets,'remote');assert.equal(kept?.client_secret,secret);assert.equal(kept?.origin,'manual');
 // The form is submitted again with the same ID and a wrong (or missing) secret.
 for(const wrong of [{client_id:'typed-client',client_secret:'wrong-secret-value-0123'},{client_id:'typed-client'}]){
  const pair=as.authorize((await f.call('/api/mcp/oauth/start','POST',{id:'remote',url:mcp.url,...wrong})).json.url);
  assert.equal((await f.call(`/api/mcp/oauth/callback?state=${pair.state}&code=${pair.code}`,'GET',undefined,{cookie:false})).status,400);
  assert.deepEqual(readMcpOAuthClient(secrets,'remote'),kept);
 }
 // The stored client still works for the next login.
 assert.equal((await signIn(f,as,mcp.url)).done.status,200);assert.equal(stored(f).client_secret,secret);
});

test('the client ID form of a card closes when the login started from it succeeds, and keeps nothing typed',async()=>{
 const {settleClientForm,clientOnFile}=await import(pathToFileURL(resolve('web/src/mcp-login.js')).href);
 const url='https://mcp.example.com/mcp',card=(patch:Record<string,unknown>={})=>({id:'remote',url,needClient:true,clientId:'typed',clientSecret:'',awaitingLogin:true,...patch});
 const entry=(patch:Record<string,unknown>={})=>({oauth:[{id:'remote',pending:false,logins:[],client_saved:false,...patch}]});
 // Not started from the card, or still open: nothing happens.
 assert.equal(settleClientForm(card({awaitingLogin:false}),entry({logins:[{resource:url,status:'signed_in'}]})),undefined);
 assert.equal(settleClientForm(card(),entry({pending:true})),undefined);
 assert.equal(settleClientForm(card(),entry({pending:true,logins:[{resource:url,status:'signed_in'}]})),undefined);
 // Success closes the form and forgets what was typed.
 assert.deepEqual(settleClientForm(card(),entry({logins:[{resource:url,status:'signed_in'}]})),{awaitingLogin:false,loginLink:'',needClient:false,clientId:'',clientSecret:''});
 // A login that did not succeed keeps the form, also next to an older login.
 assert.deepEqual(settleClientForm(card(),entry()),{awaitingLogin:false,loginLink:''});
 assert.deepEqual(settleClientForm(card(),entry({logins:[{resource:url,status:'signed_in'}],failure:{code:'invalid_client',at:1,resource:url}})),{awaitingLogin:false,loginLink:''});
 // The "client is reused" hint needs a client on file.
 assert.equal(clientOnFile({id:'remote'},entry({client_saved:true})),true);assert.equal(clientOnFile({id:'remote'},entry()),false);
});

test('the client on file is reported without secrets and disappears with an automatically registered one',async t=>{
 const as=await authorizationServer(t),mcp=await mcpServer(t,as),f=await niwa(t);
 assert.deepEqual((await f.call('/api/mcp')).json.oauth,[]);
 await signIn(f,as,mcp.url);
 let entry=(await f.call('/api/mcp')).json.oauth[0];assert.equal(entry.client_saved,true);assert.doesNotMatch(JSON.stringify(entry),/client-1|secret/);
 await f.call('/api/mcp/oauth/logout','POST',{id:'remote'});
 assert.deepEqual((await f.call('/api/mcp')).json.oauth,[]);
 as.overrides={registration_endpoint:null};await signIn(f,as,mcp.url,{client_id:'typed-client'});await f.call('/api/mcp/oauth/logout','POST',{id:'remote'});
 entry=(await f.call('/api/mcp')).json.oauth[0];assert.deepEqual(entry,{id:'remote',pending:false,logins:[],client_saved:true});
});

test('revoking a login does not end a login of another connection that uses the same client',async t=>{
 const as=await authorizationServer(t),mcp=await mcpServer(t,as),f=await niwa(t);
 as.revokeAll=true;as.overrides={registration_endpoint:null};
 await signIn(f,as,mcp.url,{client_id:'shared-client'});const remote=stored(f);
 const pair=as.authorize((await f.call('/api/mcp/oauth/start','POST',{id:'other',url:mcp.url,client_id:'shared-client'})).json.url);
 assert.equal((await f.call(`/api/mcp/oauth/callback?state=${pair.state}&code=${pair.code}`,'GET',undefined,{cookie:false})).status,200);
 // The second connection goes away; the first keeps its login at the provider.
 assert.equal((await f.call('/api/mcp/oauth/logout','POST',{id:'other'})).json.ok,true);
 assert.equal(as.revoked.length,0);assert.ok(as.accepted.has(remote.access_token));
 // Alone, it is revoked as usual.
 assert.equal((await f.call('/api/mcp/oauth/logout','POST',{id:'remote'})).json.ok,true);
 assert.deepEqual(as.revoked.map(r=>r.form.get('token')),[remote.refresh_token]);
});

test('saving revokes the newest copy of a dropped login, also one that exists only in memory',async t=>{
 const as=await authorizationServer(t),mcp=await mcpServer(t,as),f=await niwa(t),secrets=join(f.root,'secrets'),other=mcp.url+'?team=b',file=f.secret(credFile(mcp.url));
 t.mock.method(console,'error',()=>{});
 as.expiresIn=0;await signIn(f,as,mcp.url);const older=stored(f);
 // The renewal made while connecting cannot be written: it is held in memory, the old copy stays on disk.
 as.onRefresh=()=>{rmSync(file);mkdirSync(file);as.onRefresh=undefined;};
 assert.equal((await f.call('/api/mcp','PUT',{revision:f.manager.status().revision,servers:[remoteConfig(mcp.url)]})).json.ok,true);
 const newest=as.latestRefresh;assert.notEqual(newest,older.refresh_token);
 rmSync(file,{recursive:true});writeMcpOAuth(secrets,'remote',older);
 // Another login with a client of its own, then the URL moves.
 as.expiresIn=3600;rmSync(join(secrets,'mcp-oauth-remote.client.json'));mcp.resource=other;await signIn(f,as,other);
 assert.equal((await f.call('/api/mcp','PUT',{revision:f.manager.status().revision,servers:[remoteConfig(other)]})).json.ok,true);
 await until(()=>as.revoked.length>0);
 assert.deepEqual(as.revoked.map(r=>r.form.get('token')),[newest]);
});

test('tokens issued to a login that was cancelled meanwhile are given back to the provider',async t=>{
 const as=await authorizationServer(t),mcp=await mcpServer(t,as),f=await niwa(t),oauth=new McpOAuth(join(f.root,'secrets'));
 // A code exchange that finishes after the logout.
 const s=await oauth.start('remote',mcp.url,undefined,f.callback);if(!s.ok)throw Error('start');
 as.delay=200;const running=oauth.finish(as.authorize(s.url));
 await until(()=>as.tokens.length>0);await oauth.logout('remote');
 assert.equal(await running,undefined);await until(()=>as.revoked.length>0);
 assert.equal(as.revoked[0]!.form.get('token'),as.latestRefresh);assert.deepEqual(listMcpOAuth(join(f.root,'secrets')),[]);
 // A renewal that finishes after the logout.
 as.delay=0;as.expiresIn=0;const again=await oauth.start('remote',mcp.url,undefined,f.callback);if(!again.ok)throw Error('start');assert.ok(await oauth.finish(as.authorize(again.url)));
 as.delay=200;as.expiresIn=3600;const before=as.refreshes().length,revoked=as.revoked.length;
 const renewing=mcpRpc({url:mcp.url,oauth:oauth.source('remote',mcp.url)},'tools/list').then(()=>'done',e=>e instanceof McpLoginRequired?'login_required':'other');
 await until(()=>as.refreshes().length>before);await oauth.logout('remote');
 assert.equal(await renewing,'login_required');await until(()=>as.revoked.length>revoked+1);
 assert.equal(as.revoked.at(-1)!.form.get('token'),as.latestRefresh);
});

test('forgetting a connection returns the held logins of every URL it had, not only the first',async t=>{
 const as=await authorizationServer(t),mcp=await mcpServer(t,as),f=await niwa(t),oauth=new McpOAuth(join(f.root,'secrets')),other=mcp.url+'?team=b';
 t.mock.method(console,'error',()=>{});
 const held:string[]=[];
 for(const url of [mcp.url,other]){
  mcp.resource=url;as.expiresIn=0;
  const s=await oauth.start('remote',url,undefined,f.callback);if(!s.ok)throw Error('start');assert.ok(await oauth.finish(as.authorize(s.url)));
  // The renewal cannot be written, so the renewed login is held in memory.
  const file=f.secret(credFile(url));as.onRefresh=()=>{rmSync(file);mkdirSync(file);as.onRefresh=undefined;};
  await mcpRpc({url,oauth:oauth.source('remote',url)},'tools/list');held.push(as.latestRefresh);
 }
 assert.equal(held.length,2);assert.equal(oauth.states([])[0]!.logins.filter(l=>l.unsaved).length,2);
 // The connection is removed: both held logins come back for revocation, and nothing is left held.
 const dropped=oauth.forgetExcept(new Map());
 assert.deepEqual(dropped.map(d=>d.credential.refresh_token).sort(),[...held].sort());assert.deepEqual(dropped.map(d=>d.id),['remote','remote']);
 assert.equal(oauth.states([]).some(entry=>entry.unsaved),false);
 // Kept URLs are not returned.
 assert.deepEqual(oauth.forgetExcept(new Map([['remote',mcp.url]])),[]);
});
