import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,chmodSync,rmSync,statSync,readFileSync,writeFileSync,existsSync,symlinkSync,linkSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer,request,type IncomingMessage,type ServerResponse} from 'node:http';
import {once} from 'node:events';
import {createHash,randomBytes} from 'node:crypto';
import {initializeInstallation,readInstallation} from '../src/config/installation.ts';
import {McpSettings} from '../src/tools/mcp/settings.ts';
import {McpConnector,McpLoginRequired,mcpRpc,mcpScope,mcpEndpointValid,oauthUrl,type McpEndpoint} from '../src/tools/mcp/client.ts';
import {McpOAuth,parseChallenges} from '../src/tools/mcp/oauth.ts';
import {readMcpOAuth,writeMcpOAuth,listMcpOAuth,type McpOAuthCredential} from '../src/tools/mcp/oauth-store.ts';
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
  expiresIn:3600 as number|undefined,omitRefresh:false,refreshFailure:undefined as string|undefined,secret:undefined as string|undefined,method:'client_secret_post',delay:0,counter:0,latestRefresh:'',registerStatus:201,revokeStatus:200,tokenType:'Bearer',registration:{} as Record<string,unknown>,
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
 const issue=(res:ServerResponse,initial:boolean)=>{
  const access=`at-${++s.counter}-${randomBytes(6).toString('hex')}`;s.accepted.add(access);
  const omit=s.omitRefresh&&!initial,next=`rt-${s.counter}-${randomBytes(6).toString('hex')}`;
  if(!omit){s.refreshTokens.add(next);s.latestRefresh=next;}
  send(res,200,{access_token:access,token_type:s.tokenType,...(s.expiresIn!==undefined?{expires_in:s.expiresIn}:{}),...(omit?{}:{refresh_token:next}),scope:'mail.read'});
 };
 s.url=await listen(t,async(req,res)=>{
  const path=new URL(req.url!,'http://x').pathname;s.hits.set(path,(s.hits.get(path)??0)+1);
  if(s.redirects.has(path)){res.writeHead(302,{Location:`${s.url}/elsewhere`});res.end();return;}
  if(path==='/.well-known/oauth-authorization-server'){send(res,200,s.metadata());return;}
  if(path==='/register'){
   const value=JSON.parse(await body(req));s.registrations.push(value);
   send(res,s.registerStatus,{client_id:`client-${s.registrations.length}`,redirect_uris:value.redirect_uris,token_endpoint_auth_method:'none',...s.registration});return;
  }
  if(path==='/revoke'){s.revoked.push({form:new URLSearchParams(await body(req)),auth:req.headers.authorization});res.writeHead(s.revokeStatus);res.end();return;}
  if(path==='/token'){
   const form=new URLSearchParams(await body(req));s.tokens.push({form,auth:req.headers.authorization});
   if(s.delay)await sleep(s.delay);
   if(s.secret!==undefined){
    const sent=s.method==='client_secret_basic'?req.headers.authorization===`Basic ${Buffer.from(`${encodeURIComponent(form.get('client_id')!)}:${encodeURIComponent(s.secret)}`).toString('base64')}`:form.get('client_secret')===s.secret;
    if(!sent){send(res,401,{error:'invalid_client'});return;}
   }
   if(form.get('grant_type')==='authorization_code'){
    const known=s.codes.get(form.get('code')!);s.codes.delete(form.get('code')!);
    const challenge=createHash('sha256').update(form.get('code_verifier')??'').digest('base64url');
    if(!known||known.challenge!==challenge||known.redirect!==form.get('redirect_uri')||known.client!==form.get('client_id')||known.resource!==form.get('resource')){send(res,400,{error:'invalid_grant'});return;}
    issue(res,true);return;
   }
   if(form.get('grant_type')==='refresh_token'){
    if(s.refreshFailure){send(res,400,{error:s.refreshFailure});return;}
    const old=form.get('refresh_token')!;
    if(!s.refreshTokens.has(old)){send(res,400,{error:'invalid_grant'});return;}
    if(!s.omitRefresh)s.refreshTokens.delete(old);
    issue(res,false);return;
   }
  }
  res.writeHead(404);res.end();
 });
 return s;
}
type As=Awaited<ReturnType<typeof authorizationServer>>;

/** Artificial MCP server that wants a Bearer token the authorization server issued. */
async function mcpServer(t:After,as:As){
 const s={url:'',base:'',hits:new Map<string,number>(),calls:[] as {method:string;auth:string|undefined}[],resource:undefined as string|undefined|null,rejectAll:false,prm:true,header:undefined as string|undefined,
  unauthenticated:()=>s.calls.filter(c=>c.auth===undefined).length};
 s.base=await listen(t,async(req,res)=>{
  const path=new URL(req.url!,'http://x').pathname;s.hits.set(path,(s.hits.get(path)??0)+1);
  if(path==='/.well-known/oauth-protected-resource/mcp'&&s.prm){send(res,200,{...(s.resource===null?{}:{resource:s.resource??s.url}),authorization_servers:[as.url],scopes_supported:['mail.read','mail.send']});return;}
  if(path!=='/mcp'||req.method!=='POST'){res.writeHead(404);res.end();return;}
  const message=JSON.parse(await body(req)),auth=req.headers.authorization;s.calls.push({method:message.method,auth});
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
 const manager=await McpSettings.open(root,undefined,retry),runtime=new Runtime(join(root,'state')),origin='https://niwa.test',key='k'.repeat(43);runtime.bootstrap(runtime.administrator());
 const api=createApiServer(runtime,new WebAuth(origin,key),undefined,undefined,undefined,undefined,undefined,undefined,manager);api.listen(0,'127.0.0.1');await once(api,'listening');
 t.after(async()=>{manager.close();api.closeAllConnections();await new Promise<void>(resolve=>api.close(()=>resolve()));runtime.close();rmSync(root,{recursive:true,force:true});});
 const port=(api.address() as {port:number}).port;let cookie='';
 const call=(path:string,method='GET',payload?:unknown,options:{cookie?:boolean;origin?:string}={})=>new Promise<{status:number;text:string;json:any;headers:IncomingMessage['headers']}>((resolve,reject)=>{
  const headers:Record<string,string>={host:'niwa.test','Content-Type':'application/json',...(method==='GET'?{}:{origin:options.origin??origin})};
  if(options.cookie!==false&&cookie)headers.cookie=cookie;
  const req=request({host:'127.0.0.1',port,path,method,headers},res=>{
   const chunks:Buffer[]=[];res.on('data',chunk=>chunks.push(Buffer.from(chunk)));
   res.on('end',()=>{const text=Buffer.concat(chunks).toString();let json:unknown;try{json=JSON.parse(text);}catch{}resolve({status:res.statusCode!,text,json,headers:res.headers});});
  });req.on('error',reject);req.end(payload===undefined?undefined:JSON.stringify(payload));
 });
 cookie=(await new Promise<string>((resolve,reject)=>{
  const req=request({host:'127.0.0.1',port,path:'/api/login',method:'POST',headers:{host:'niwa.test',origin,'Content-Type':'application/json'}},res=>{res.resume();res.on('end',()=>resolve(res.headers['set-cookie']![0]!.split(';')[0]!));});
  req.on('error',reject);req.end(JSON.stringify({key}));
 }));
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
const stored=(f:Niwa,id='remote')=>JSON.parse(f.read(`mcp-oauth-${id}.json`)) as McpOAuthCredential;
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
 assert.equal(done.status,200);assert.match(done.text,/MCPの接続先にログインしました。Niwaの画面に戻って「接続を確認」を押してください。/);
 assert.equal(done.headers['referrer-policy'],'no-referrer');assert.match(String(done.headers['content-security-policy']),/default-src 'none'/);
 // The authorization code exchange carried the PKCE verifier, redirect and resource.
 const exchange=as.tokens[0]!.form;assert.equal(exchange.get('grant_type'),'authorization_code');assert.equal(exchange.get('resource'),mcp.url);assert.equal(exchange.get('client_id'),'client-1');
 const file=f.secret('mcp-oauth-remote.json'),credential=stored(f);
 assert.equal(statSync(file).mode&0o777,0o600);assert.equal(credential.resource,mcp.url);assert.equal(credential.issuer,as.url);assert.equal(credential.token_endpoint_auth_method,'none');assert.ok(credential.refresh_token);
 const status=await f.call('/api/mcp');
 assert.deepEqual(status.json.oauth,[{id:'remote',status:'signed_in',pending:false,resource_matches:true,resource:mcp.url}]);
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
 assert.deepEqual(readdirSync(join(f.root,'secrets')).filter(n=>n.startsWith('mcp-')),['mcp-oauth-remote.json']);
});

test('OAuth access tokens are renewed before they expire; the rotated refresh token is saved and concurrent callers share one renewal',async t=>{
 const as=await authorizationServer(t),mcp=await mcpServer(t,as),f=await niwa(t),oauth=new McpOAuth(join(f.root,'secrets'));
 as.expiresIn=30;
 const login=async()=>{const s=await oauth.start('remote',mcp.url,undefined,f.callback);assert.equal(s.ok,true);if(!s.ok)return;const {code,state}=as.authorize(s.url);assert.ok(await oauth.finish({state,code}));};
 await login();const first=stored(f);assert.ok(first.expires_at!-Date.now()<=30_000);
 as.expiresIn=3600;
 await mcpRpc({url:mcp.url,oauth:oauth.source('remote',mcp.url)},'tools/list');
 const second=stored(f);assert.equal(as.refreshes().length,1);
 assert.equal(as.refreshes()[0]!.form.get('refresh_token'),first.refresh_token);assert.equal(as.refreshes()[0]!.form.get('resource'),mcp.url);assert.equal(as.refreshes()[0]!.form.get('client_id'),'client-1');
 assert.notEqual(second.refresh_token,first.refresh_token);assert.notEqual(second.access_token,first.access_token);assert.ok(second.expires_at!-Date.now()>3000_000);
 assert.equal(statSync(f.secret('mcp-oauth-remote.json')).mode&0o777,0o600);assert.equal(mcp.calls.at(-1)!.auth,`Bearer ${second.access_token}`);
 // A valid token is not renewed again.
 await mcpRpc({url:mcp.url,oauth:oauth.source('remote',mcp.url)},'tools/list');assert.equal(as.refreshes().length,1);
 // Expired again: six simultaneous requests cause one renewal.
 as.expiresIn=30;await login();as.expiresIn=3600;as.delay=100;const before=as.refreshes().length;
 const endpoint:McpEndpoint={url:mcp.url,oauth:oauth.source('remote',mcp.url)};
 await Promise.all(Array.from({length:6},()=>mcpRpc(endpoint,'tools/list')));
 assert.equal(as.refreshes().length,before+1);
 // A refresh response without a new refresh token keeps the old one.
 as.expiresIn=30;await login();const old=stored(f);as.expiresIn=3600;as.omitRefresh=true;
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
 assert.equal(oauth.states([]).find(x=>x.id==='remote')!.status,'needs_login');
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
 assert.deepEqual(status.connected,[]);assert.deepEqual(status.failed,[{id:'remote',reason:'login_required'}]);assert.equal(status.oauth[0]!.status,'needs_login');assert.equal(status.applied,false);
 const refreshes=as.refreshes().length;await sleep(150);
 // Waiting for a login costs no requests.
 assert.equal(as.refreshes().length,refreshes);
 assert.equal((await f.call('/api/mcp/probe','POST',{url:mcp.url,id:'remote',oauth:true})).json.ok,false);
 as.refreshFailure=undefined;await signIn(f,as,mcp.url);
 await until(()=>f.manager.status().connected.includes('remote'));
 status=f.manager.status();assert.deepEqual(status.connected,['remote']);assert.deepEqual(status.failed,[]);assert.equal(status.oauth[0]!.status,'signed_in');assert.equal(status.applied,true);assert.equal(status.error,null);
 await f.manager.connector.call('mcp_remote_mail_search',{},toolCtx());
});

test('temporary refresh failures are retried and never mistaken for a lost login',async t=>{
 const as=await authorizationServer(t),mcp=await mcpServer(t,as),f=await niwa(t),secrets=join(f.root,'secrets'),oauth=new McpOAuth(secrets);
 as.expiresIn=30;const s=await oauth.start('remote',mcp.url,undefined,f.callback);if(!s.ok)throw Error('start');assert.ok(await oauth.finish(as.authorize(s.url)));as.expiresIn=3600;
 const before=readFileSync(f.secret('mcp-oauth-remote.json'),'utf8');
 const outage=(respond:()=>Response|Promise<Response>)=>new McpOAuth(secrets,{fetcher:(async(input:any,init:any)=>String(input).endsWith('/token')?respond():fetch(input,init)) as typeof fetch});
 for(const flaky of [outage(()=>new Response('busy',{status:503})),outage(()=>{throw new TypeError('fetch failed');}),outage(()=>new Response('<html>',{status:200,headers:{'Content-Type':'text/html'}})),outage(()=>new Response(JSON.stringify({access_token:'x'}),{status:200,headers:{'Content-Type':'application/json'}}))]){
  await assert.rejects(mcpRpc({url:mcp.url,oauth:flaky.source('remote',mcp.url)},'tools/list'),(e:Error)=>!(e instanceof McpLoginRequired)&&e.message==='oauth_refresh_failed');
  assert.equal(flaky.states([])[0]!.status,'signed_in');assert.equal(readFileSync(f.secret('mcp-oauth-remote.json'),'utf8'),before);
 }
 assert.equal(as.refreshes().length,0);
 await mcpRpc({url:mcp.url,oauth:oauth.source('remote',mcp.url)},'tools/list');assert.equal(as.refreshes().length,1);
});

test('callback states are single use, expire and are validated; the callback needs no cookie but other MCP routes do',async t=>{
 const as=await authorizationServer(t),mcp=await mcpServer(t,as),f=await niwa(t),file='mcp-oauth-remote.json';
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
 // Only the callback is reachable without the admin cookie.
 for(const [path,method,payload] of [['/api/mcp','GET',undefined],['/api/mcp/probe','POST',{url:mcp.url}],['/api/mcp/oauth/start','POST',{id:'remote',url:mcp.url}],['/api/mcp/oauth/logout','POST',{id:'remote'}]] as const)
  assert.equal((await f.call(path,method,payload,{cookie:false})).status,401,path);
 assert.equal((await f.call('/api/mcp/oauth/callback','POST',{},{cookie:false})).status,401);
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
 assert.deepEqual(listMcpOAuth(join(f.root,'secrets')).sort(),['remote','srv8']);
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
 assert.equal(page.status,400);assert.equal(as.hits.get('/elsewhere')??0,0);assert.ok(!existsSync(f.secret('mcp-oauth-remote.json')));
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
 const as=await authorizationServer(t),mcp=await mcpServer(t,as),f=await niwa(t),file='mcp-oauth-remote.json';
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

test('token responses are validated before anything is stored',async t=>{
 const as=await authorizationServer(t),mcp=await mcpServer(t,as),f=await niwa(t),file='mcp-oauth-remote.json';
 as.tokenType='mac';assert.equal((await signIn(f,as,mcp.url)).done.status,400);assert.ok(!existsSync(f.secret(file)));
 as.tokenType='bearer';as.expiresIn=0;assert.equal((await signIn(f,as,mcp.url)).done.status,400);assert.ok(!existsSync(f.secret(file)));
 as.expiresIn=undefined;assert.equal((await signIn(f,as,mcp.url)).done.status,200);assert.equal(stored(f).expires_at,undefined);
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
 assert.equal(statSync(f.secret('mcp-oauth-remote.json')).mode&0o777,0o600);
 const status=await f.call('/api/mcp');assert.ok(!status.text.includes(secret));assert.ok(!post.started.text.includes(secret));assert.ok(!post.done.text.includes(secret));
 // The refresh request authenticates the same way.
 const oauth=new McpOAuth(join(f.root,'secrets'));
 as.expiresIn=30;await signIn(f,as,mcp.url,{client_id:'manual-client',client_secret:secret});as.expiresIn=3600;
 await mcpRpc({url:mcp.url,oauth:oauth.source('remote',mcp.url)},'tools/list');
 assert.equal(as.refreshes().length,1);assert.equal(as.refreshes()[0]!.form.get('client_secret'),secret);assert.equal(as.refreshes()[0]!.auth,undefined);
 // client_secret_basic when that is all the provider lists
 as.overrides={registration_endpoint:null,token_endpoint_auth_methods_supported:['client_secret_basic']};as.method='client_secret_basic';
 as.expiresIn=30;const basic=await signIn(f,as,mcp.url,{client_id:'manual-client',client_secret:secret});as.expiresIn=3600;
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
 assert.equal((await f.call('/api/mcp/oauth/start','POST',{id:'remote',url:mcp.url})).json.code,'client_auth_unsupported');
 as.registration={redirect_uris:['https://elsewhere.test/cb']};
 assert.equal((await f.call('/api/mcp/oauth/start','POST',{id:'remote',url:mcp.url})).json.code,'registration_failed');
 as.registration={};as.registerStatus=500;assert.equal((await f.call('/api/mcp/oauth/start','POST',{id:'remote',url:mcp.url})).json.code,'registration_failed');
});

test('a login is used only for the exact URL it was made for; deleting a connection or leaving OAuth removes it, and OAuth servers take no static token',async t=>{
 const as=await authorizationServer(t),mcp=await mcpServer(t,as),f=await niwa(t),file='mcp-oauth-remote.json';
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
 const states=f.manager.status().oauth;assert.equal(states[0]!.resource_matches,true);
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
 const as=await authorizationServer(t),mcp=await mcpServer(t,as),f=await niwa(t),file='mcp-oauth-remote.json';
 await signIn(f,as,mcp.url);const before=f.read(file),state=join(f.root,'state/mcp.json');
 f.manager.status();
 // The saved state cannot be read, so the write that follows the credential removal fails.
 mkdirSync(state);
 try{await assert.rejects(f.manager.save({revision:f.manager.status().revision,servers:[]}));}finally{rmSync(state,{recursive:true});}
 assert.equal(f.read(file),before);assert.equal(statSync(f.secret(file)).mode&0o777,0o600);
});

test('logout removes the login, asks the provider to revoke it (failures ignored) and takes the connection out of service',async t=>{
 const as=await authorizationServer(t),mcp=await mcpServer(t,as),f=await niwa(t),file='mcp-oauth-remote.json';
 await signIn(f,as,mcp.url);const credential=stored(f);
 assert.equal((await f.call('/api/mcp','PUT',{revision:f.manager.status().revision,servers:[remoteConfig(mcp.url)]})).json.ok,true);
 as.revokeStatus=500;
 const pending=await f.call('/api/mcp/oauth/start','POST',{id:'remote',url:mcp.url}),waiting=as.authorize(pending.json.url);
 const out=await f.call('/api/mcp/oauth/logout','POST',{id:'remote'});
 assert.equal(out.status,200);assert.equal(out.json.ok,true);assert.ok(!existsSync(f.secret(file)));
 assert.equal(as.revoked.length,1);assert.equal(as.revoked[0]!.form.get('token'),credential.refresh_token);assert.equal(as.revoked[0]!.form.get('token_type_hint'),'refresh_token');assert.equal(as.revoked[0]!.form.get('client_id'),'client-1');
 const status=(await f.call('/api/mcp')).json;
 assert.deepEqual(status.connected,[]);assert.deepEqual(status.failed,[{id:'remote',reason:'login_required'}]);assert.deepEqual(status.oauth,[{id:'remote',status:'signed_out',pending:false,resource_matches:false,resource:null}]);
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
 assert.deepEqual(status.failed,waiting);assert.deepEqual(status.connected,[]);assert.equal(status.oauth[0]!.status,'signed_out');assert.ok(status.error);
 await sleep(100);assert.equal(mcp.calls.length,0);
 // Unreadable, invalid and unsafe credential files are the same as no login.
 const file=join(root,'secrets/mcp-oauth-remote.json'),valid={version:1,resource:mcp.url,issuer:as.url,token_endpoint:`${as.url}/token`,client_id:'c',token_endpoint_auth_method:'none',access_token:'at-valid-token-123456'};
 writeFileSync(file,'{broken',{mode:0o600});settings=await open();assert.deepEqual(settings.status().failed,waiting);
 writeFileSync(file,JSON.stringify({...valid,extra:true}),{mode:0o600});settings=await open();assert.deepEqual(settings.status().failed,waiting);
 writeFileSync(file,JSON.stringify({...valid,token_endpoint:'http://example.com/token'}),{mode:0o600});settings=await open();assert.deepEqual(settings.status().failed,waiting);
 if(process.platform!=='win32'){writeFileSync(file,JSON.stringify(valid));chmodSync(file,0o644);settings=await open();assert.deepEqual(settings.status().failed,waiting);}
 assert.equal(mcp.calls.length,0);rmSync(file);
 // A login made while the service is running, then a restart: the stored login is used.
 await signIn(f,as,mcp.url);
 settings=await open();status=settings.status();
 assert.deepEqual(status.connected,['remote']);assert.deepEqual(status.failed,[]);assert.equal(status.oauth[0]!.status,'signed_in');
 await settings.connector.call('mcp_remote_mail_search',{},toolCtx());
});

test('credential files are strictly validated: symlinks, extra links, wide permissions, oversize and malformed content are refused',{skip:process.platform==='win32'},async t=>{
 const dir=mkdtempSync(join(tmpdir(),'niwa-oauth-store-'));t.after(async()=>rmSync(dir,{recursive:true,force:true}));chmodSync(dir,0o700);
 const credential:McpOAuthCredential={version:1,resource:'https://mcp.example.com/mcp',issuer:'https://auth.example.com',token_endpoint:'https://auth.example.com/token',client_id:'c1',client_secret:'s3cret-value',token_endpoint_auth_method:'client_secret_post',access_token:'access-token-1234',refresh_token:'refresh-token-1234',expires_at:Date.now()+1000,scope:'a b',revocation_endpoint:'https://auth.example.com/revoke'};
 assert.equal(readMcpOAuth(dir,'srv'),undefined);
 writeMcpOAuth(dir,'srv',credential);assert.deepEqual(readMcpOAuth(dir,'srv'),credential);assert.equal(statSync(join(dir,'mcp-oauth-srv.json')).mode&0o777,0o600);assert.deepEqual(listMcpOAuth(dir),['srv']);
 assert.deepEqual(readdirSync(dir).filter(n=>n.endsWith('.tmp')),[]);
 for(const bad of [{...credential,access_token:'short'},{...credential,access_token:'with"quote-1234'},{...credential,resource:'https://mcp.example.com'},{...credential,token_endpoint:'http://auth.example.com/token'},{...credential,client_secret:undefined},{...credential,token_endpoint_auth_method:'none' as const},{...credential,version:2} as any,{...credential,extra:1} as any,{...credential,expires_at:-1}])
  assert.throws(()=>writeMcpOAuth(dir,'srv',bad),/Invalid MCP OAuth credential/);
 assert.throws(()=>writeMcpOAuth(dir,'Bad',credential),/Invalid MCP server id/);
 const file=join(dir,'mcp-oauth-srv.json');
 chmodSync(file,0o640);assert.throws(()=>readMcpOAuth(dir,'srv'),/Unsafe/);chmodSync(file,0o600);
 linkSync(file,join(dir,'hard'));assert.throws(()=>readMcpOAuth(dir,'srv'),/Unsafe/);rmSync(join(dir,'hard'));
 rmSync(file);symlinkSync(join(dir,'elsewhere'),file);assert.throws(()=>readMcpOAuth(dir,'srv'));rmSync(file);
 writeFileSync(file,' '.repeat(65537),{mode:0o600});assert.throws(()=>readMcpOAuth(dir,'srv'));
 writeFileSync(file,'[]',{mode:0o600});assert.throws(()=>readMcpOAuth(dir,'srv'),/Invalid/);
 writeMcpOAuth(dir,'srv',undefined);assert.equal(readMcpOAuth(dir,'srv'),undefined);writeMcpOAuth(dir,'srv',undefined);
 // A public client has no secret.
 const {client_secret:_,...rest}=credential,pub:McpOAuthCredential={...rest,token_endpoint_auth_method:'none'};
 writeMcpOAuth(dir,'pub',pub);assert.deepEqual(readMcpOAuth(dir,'pub'),pub);
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
 assert.deepEqual(status.json.oauth,[{id:'remote',status:'signed_out',pending:true,resource_matches:false,resource:null}]);
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
