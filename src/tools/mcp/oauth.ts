import {createHash,randomBytes} from 'node:crypto';
import {createPkcePair} from '../../auth/codex-oauth.ts';
import {McpLoginRequired,mcpUrl,oauthUrl,type McpOAuthSource} from './client.ts';
import {listMcpOAuth,readMcpOAuth,writeMcpOAuth,type McpOAuthCredential} from './oauth-store.ts';

type AuthMethod=McpOAuthCredential['token_endpoint_auth_method'];
interface Client{client_id:string;client_secret?:string;method:AuthMethod}
interface Flow{id:string;resource:string;issuer:string;token_endpoint:string;revocation_endpoint?:string;client:Client;verifier:string;redirect:string;scope?:string;requireIss:boolean;generation:number;expires:number}
interface Reply{status:number;headers:Headers;json:Record<string,unknown>|undefined}
interface Server{token_endpoint:string;authorization_endpoint:string;registration_endpoint?:string;revocation_endpoint?:string;requireIss:boolean;basicOnly:boolean}
export interface McpOAuthState{id:string;status:'signed_in'|'needs_login'|'signed_out';pending:boolean;resource_matches:boolean;resource:string|null}
export type McpOAuthStart={ok:true;url:string;expires_at:number}|{ok:false;code:string;message:string};
/** Failure with a short code only. Messages never carry response bodies, tokens, codes or secrets. */
class OAuthError extends Error{constructor(readonly code:string){super(code);}}
const messages:Record<string,string>={
 client_registration_required:'この接続先は、クライアントの自動登録に対応していません。提供元の開発者向け画面で発行したクライアントIDを入力してください。',
 pkce_unsupported:'この接続先はPKCE（S256）に対応していないため、ログインできません。',
 endpoint_insecure:'この接続先のログイン用アドレスがHTTPSではないため、ログインできません。',
 issuer_mismatch:'この接続先のログイン情報が一致しないため、ログインできません。',
 resource_mismatch:'この接続先のログイン情報が一致しないため、ログインできません。',
};
const generic='ログインを開始できませんでした。接続先のURLと、OAuthへの対応を確認してください。';
const idPattern=/^[a-z][a-z0-9_]{0,19}$/,statePattern=/^[A-Za-z0-9_-]{43}$/,codePattern=/^[\x21-\x7e]{1,4096}$/,scopePattern=/^[\x21-\x7e]+(?: [\x21-\x7e]+)*$/;
const jsonType=/^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)/i;
const initialize=JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'niwa',version:'0.1.0'}}});
const fingerprint=(c:McpOAuthCredential)=>createHash('sha256').update(c.refresh_token??c.access_token).digest('hex');
const abandon=<T>(promise:Promise<T>,signal?:AbortSignal)=>signal?new Promise<T>((resolve,reject)=>{
 const stop=()=>reject(signal.reason);signal.addEventListener('abort',stop,{once:true});if(signal.aborted)stop();
 promise.then(resolve,reject).finally(()=>signal.removeEventListener('abort',stop));
}):promise;

/** Challenges of a WWW-Authenticate value: quoted strings with escapes and commas, several challenges, any case. */
export function parseChallenges(header:string|null|undefined){
 const out:{scheme:string;params:Record<string,string>}[]=[];
 if(!header||header.length>8192)return out;
 const n=header.length,tchar=/[!#$%&'*+\-.^_`|~0-9A-Za-z]/;let i=0,current:(typeof out)[number]|undefined;
 const blank=(c:string|undefined)=>c===' '||c==='\t';
 const token=()=>{const start=i;while(i<n&&tchar.test(header[i]!))i++;return header.slice(start,i);};
 while(i<n){
  while(i<n&&(header[i]===','||blank(header[i])))i++;
  if(i>=n)break;
  const word=token();
  if(!word){i++;continue;}
  while(blank(header[i]))i++;
  if(header[i]!=='='){current={scheme:word.toLowerCase(),params:{}};out.push(current);continue;}
  let after=i;while(header[after]==='=')after++;
  let next=after;while(blank(header[next]))next++;
  // "abc==" is a token68 credential of the current challenge, not a parameter.
  if(after-i>1||next>=n||header[next]===','){i=next;continue;}
  i=next;let value='';
  if(header[i]==='"'){i++;while(i<n&&header[i]!=='"'){if(header[i]==='\\'&&i+1<n)i++;value+=header[i++];}i++;}
  else{const start=i;while(i<n&&header[i]!==','&&!blank(header[i]))i++;value=header.slice(start,i);}
  if(current)current.params[word.toLowerCase()]??=value;
 }
 return out;
}
const bearer=(header:string|null|undefined)=>{const list=parseChallenges(header).filter(c=>c.scheme==='bearer');return list.find(c=>c.params.resource_metadata!==undefined)??list[0];};
const normal=(value:string)=>value.replace(/\/$/,'');
const strings=(value:unknown)=>Array.isArray(value)&&value.every(v=>typeof v==='string')?value as string[]:undefined;

/** OAuth login for remote MCP servers (MCP Authorization 2025-06-18): discovery, registration, PKCE login, refresh. Pending logins live in memory only. */
export class McpOAuth{
 private pending=new Map<string,Flow>();
 private flights=new Map<string,Promise<McpOAuthCredential>>();
 private generations=new Map<string,number>();
 private needs=new Map<string,string>();
 private lifetime=new AbortController();
 private fetcher:typeof fetch;
 private onLogin:(id:string)=>void;
 constructor(private secrets:string,options:{fetcher?:typeof fetch;onLogin?:(id:string)=>void}={}){this.fetcher=options.fetcher??fetch;this.onLogin=options.onLogin??(()=>{});}
 private generation(id:string){return this.generations.get(id)??0;}
 private bump(id:string){const next=this.generation(id)+1;this.generations.set(id,next);return next;}
 private prune(){const now=Date.now();for(const [state,flow] of this.pending)if(flow.expires<=now)this.pending.delete(state);}
 private drop(id:string){for(const [state,flow] of this.pending)if(flow.id===id)this.pending.delete(state);}
 private credential(id:string){try{return readMcpOAuth(this.secrets,id);}catch{return undefined;}}
 /** One request. Redirects are never followed, the answer is capped at 64 KiB and only JSON objects are parsed. */
 private async send(url:URL,init:{method:'GET'|'POST';headers?:Record<string,string>;body?:string},signal:AbortSignal,read=true,seconds=20):Promise<Reply>{
  let response:Response;
  try{response=await this.fetcher(url,{method:init.method,headers:{Accept:'application/json',...init.headers},...(init.body!==undefined?{body:init.body}:{}),redirect:'error',signal:AbortSignal.any([AbortSignal.timeout(seconds*1000),signal])});}
  catch{throw new OAuthError('network_error');}
  if(response.redirected||response.type==='opaqueredirect'||(response.status>=300&&response.status<400)){void response.body?.cancel().catch(()=>{});throw new OAuthError('redirect');}
  if(!read){void response.body?.cancel().catch(()=>{});return {status:response.status,headers:response.headers,json:undefined};}
  const chunks:Buffer[]=[];let size=0;
  try{if(response.body)for await(const chunk of response.body as unknown as AsyncIterable<Uint8Array>){size+=chunk.length;if(size>65536)throw new OAuthError('response_too_large');chunks.push(Buffer.from(chunk));}}
  catch(error){throw error instanceof OAuthError?error:new OAuthError('network_error');}
  let json:Record<string,unknown>|undefined;
  if(jsonType.test(response.headers.get('content-type')??'')){
   try{const value:unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(value&&typeof value==='object'&&!Array.isArray(value))json=value as Record<string,unknown>;}catch{}
  }
  return {status:response.status,headers:response.headers,json};
 }
 private async protectedResource(resource:URL,local:boolean,signal:AbortSignal){
  let header:string|null=null;
  try{
   const reply=await this.send(resource,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-06-18'},body:initialize},signal,false);
   if(reply.status===401)header=reply.headers.get('www-authenticate');
  }catch{}
  const challenge=bearer(header),scope=challenge?.params.scope,given=challenge?.params.resource_metadata;
  const hinted=given===undefined?undefined:oauthUrl(given,local);
  if(given!==undefined&&!hinted)throw new OAuthError('endpoint_insecure');
  const path=resource.pathname.replace(/\/$/,''),base=`${resource.origin}/.well-known/oauth-protected-resource`;
  const candidates=hinted?[hinted]:[new URL(base+path),...(path?[new URL(base)]:[])];
  let document:Record<string,unknown>|undefined,source:URL|undefined;
  for(const candidate of candidates){
   const reply=await this.send(candidate,{method:'GET'},signal).catch(()=>undefined);
   if(reply?.status===200&&reply.json){document=reply.json;source=candidate;break;}
  }
  const hint=scope!==undefined&&scope.length<=2048&&scopePattern.test(scope)?scope:undefined;
  // The server named its metadata itself, so a failure there is a failure; only an unmarked server may fall back.
  if(hinted&&!document)throw new OAuthError('discovery_failed');
  // Servers from before RFC 9728 act as their own authorization server.
  if(!document||!source)return {issuer:resource.origin,legacy:true,scope:hint};
  const servers=strings(document.authorization_servers),issuer=servers?.[0];
  if(!servers?.length||issuer===undefined)throw new OAuthError('metadata_invalid');
  const parsed=oauthUrl(issuer,local);
  if(!parsed)throw new OAuthError('endpoint_insecure');
  if(parsed.search)throw new OAuthError('metadata_invalid');
  if(document.resource===undefined){if(source.origin!==resource.origin)throw new OAuthError('resource_mismatch');}
  else if(typeof document.resource!=='string'||normal(document.resource)!==normal(resource.href))throw new OAuthError('resource_mismatch');
  const supported=strings(document.scopes_supported)?.filter(s=>/^[\x21-\x7e]+$/.test(s)).join(' ');
  return {issuer,legacy:false,scope:hint??(supported&&supported.length<=2048?supported:undefined)};
 }
 private async authorizationServer(issuer:string,local:boolean,signal:AbortSignal):Promise<Server>{
  const base=new URL(issuer),path=base.pathname.replace(/\/$/,''),origin=base.origin;
  const urls=path?[`${origin}/.well-known/oauth-authorization-server${path}`,`${origin}/.well-known/openid-configuration${path}`,`${origin}${path}/.well-known/openid-configuration`]
   :[`${origin}/.well-known/oauth-authorization-server`,`${origin}/.well-known/openid-configuration`];
  let document:Record<string,unknown>|undefined;
  for(const url of urls){
   const reply=await this.send(new URL(url),{method:'GET'},signal).catch(()=>undefined);
   if(reply?.status===200&&reply.json){document=reply.json;break;}
  }
  if(!document)throw new OAuthError('discovery_failed');
  if(document.issuer!==issuer)throw new OAuthError('issuer_mismatch');
  const endpoint=(key:string,required:boolean)=>{
   const value=document![key];
   if(value===undefined){if(required)throw new OAuthError('metadata_invalid');return undefined;}
   const url=typeof value==='string'?oauthUrl(value,local):undefined;
   if(!url)throw new OAuthError('endpoint_insecure');
   return url.href;
  };
  const authorization_endpoint=endpoint('authorization_endpoint',true)!,token_endpoint=endpoint('token_endpoint',true)!,registration_endpoint=endpoint('registration_endpoint',false),revocation_endpoint=endpoint('revocation_endpoint',false);
  const list=(key:string)=>{const value=document![key];if(value===undefined)return undefined;const array=strings(value);if(!array)throw new OAuthError('metadata_invalid');return array;};
  if(list('code_challenge_methods_supported')?.includes('S256')===false)throw new OAuthError('pkce_unsupported');
  if(list('response_types_supported')?.includes('code')===false||list('grant_types_supported')?.includes('authorization_code')===false)throw new OAuthError('unsupported_flow');
  const methods=list('token_endpoint_auth_methods_supported');
  return {authorization_endpoint,token_endpoint,...(registration_endpoint?{registration_endpoint}:{}),...(revocation_endpoint?{revocation_endpoint}:{}),
   requireIss:document.authorization_response_iss_parameter_supported===true,basicOnly:!!methods&&methods.includes('client_secret_basic')&&!methods.includes('client_secret_post')};
 }
 private async register(server:Server,redirect:string,signal:AbortSignal):Promise<Client>{
  const reply=await this.send(new URL(server.registration_endpoint!),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_name:'Niwa',redirect_uris:[redirect],grant_types:['authorization_code','refresh_token'],response_types:['code'],token_endpoint_auth_method:'none'})},signal);
  const value=reply.json;
  if((reply.status!==200&&reply.status!==201)||!value)throw new OAuthError('registration_failed');
  const {client_id,client_secret,redirect_uris}=value;
  if(typeof client_id!=='string'||!/^[\x21-\x7e]{1,512}$/.test(client_id)||(client_secret!==undefined&&(typeof client_secret!=='string'||!/^[\x21-\x7e]{1,4096}$/.test(client_secret))))throw new OAuthError('registration_failed');
  if(redirect_uris!==undefined&&!strings(redirect_uris)?.includes(redirect))throw new OAuthError('registration_failed');
  const method=value.token_endpoint_auth_method??(client_secret!==undefined?'client_secret_basic':'none');
  if(method!=='none'&&method!=='client_secret_post'&&method!=='client_secret_basic')throw new OAuthError('client_auth_unsupported');
  if(method==='none')return {client_id,method};
  if(client_secret===undefined)throw new OAuthError('registration_failed');
  return {client_id,client_secret,method};
 }
 /** Discovers the authorization server, obtains a client and returns the address the administrator logs in at. */
 async start(id:string,url:string,manual:{client_id:string;client_secret?:string|undefined}|undefined,callback:string,signal?:AbortSignal):Promise<McpOAuthStart>{
  const resource=mcpUrl(url),redirect=oauthUrl(callback,true);
  if(!resource||!idPattern.test(id)||!redirect||redirect.search||(manual&&!/^[\x21-\x7e]{1,512}$/.test(manual.client_id)))throw Error('Invalid MCP OAuth request');
  const begun=this.generation(id),all=AbortSignal.any([AbortSignal.timeout(60000),this.lifetime.signal,...(signal?[signal]:[])]),local=resource.protocol==='http:';
  try{
   const found=await this.protectedResource(resource,local,all);
   const server=await this.authorizationServer(found.issuer,local,all);
   const client:Client=manual?{client_id:manual.client_id,...(manual.client_secret!==undefined?{client_secret:manual.client_secret}:{}),method:manual.client_secret===undefined?'none':server.basicOnly?'client_secret_basic':'client_secret_post'}
    :server.registration_endpoint?await this.register(server,redirect.href,all):(()=>{throw new OAuthError('client_registration_required');})();
   if(this.generation(id)!==begun)throw new OAuthError('changed');
   this.prune();this.drop(id);
   while(this.pending.size>=8)this.pending.delete(this.pending.keys().next().value!);
   const pkce=createPkcePair(),state=randomBytes(32).toString('base64url'),expires=Date.now()+10*60_000,generation=this.generation(id);
   this.pending.set(state,{id,resource:resource.href,issuer:found.issuer,token_endpoint:server.token_endpoint,...(server.revocation_endpoint?{revocation_endpoint:server.revocation_endpoint}:{}),client,verifier:pkce.verifier,redirect:redirect.href,...(found.scope?{scope:found.scope}:{}),requireIss:server.requireIss,generation,expires});
   const target=new URL(server.authorization_endpoint);
   for(const [key,value] of Object.entries({response_type:'code',client_id:client.client_id,redirect_uri:redirect.href,code_challenge:pkce.challenge,code_challenge_method:'S256',state,resource:resource.href,...(found.scope?{scope:found.scope}:{})}))target.searchParams.set(key,value);
   return {ok:true,url:target.href,expires_at:expires};
  }catch(error){
   const code=error instanceof OAuthError?error.code:'start_failed';
   return {ok:false,code,message:`${messages[code]??generic}（${code}）`};
  }
 }
 private async token(credential:{token_endpoint:string;client_id:string;client_secret?:string|undefined;method:AuthMethod},form:Record<string,string>,signal:AbortSignal){
  const body=new URLSearchParams({...form,client_id:credential.client_id}),headers:Record<string,string>={'Content-Type':'application/x-www-form-urlencoded'};
  if(credential.client_secret!==undefined){
   if(credential.method==='client_secret_post')body.set('client_secret',credential.client_secret);
   else if(credential.method==='client_secret_basic')headers.Authorization='Basic '+Buffer.from(`${encodeURIComponent(credential.client_id)}:${encodeURIComponent(credential.client_secret)}`).toString('base64');
  }
  return this.send(new URL(credential.token_endpoint),{method:'POST',headers,body:body.toString()},signal);
 }
 private tokens(reply:Reply){
  const value=reply.json;
  const token=/^[\x21\x23-\x5b\x5d-\x7e]{8,4096}$/;
  if(reply.status!==200||!value||typeof value.access_token!=='string'||!token.test(value.access_token)||typeof value.token_type!=='string'||!/^bearer$/i.test(value.token_type))throw new OAuthError('token_response_invalid');
  const {refresh_token,scope}=value,seconds=typeof value.expires_in==='string'&&/^[0-9]{1,10}$/.test(value.expires_in)?Number(value.expires_in):value.expires_in;
  if(refresh_token!==undefined&&(typeof refresh_token!=='string'||!token.test(refresh_token)))throw new OAuthError('token_response_invalid');
  if(seconds!==undefined&&(typeof seconds!=='number'||!Number.isSafeInteger(seconds)||seconds<1))throw new OAuthError('token_response_invalid');
  return {access_token:value.access_token,...(refresh_token!==undefined?{refresh_token}:{}),...(seconds!==undefined?{expires_at:Date.now()+Math.min(seconds,10*365*86400)*1000}:{}),
   ...(typeof scope==='string'&&scope.length<=2048&&/^[\x20-\x7e]*$/.test(scope)?{scope}:{})};
 }
 /** Completes a login from the browser's return. Callable without the admin session: the single-use state created by an authenticated start is the proof. Failures carry no detail. */
 async finish(input:{state?:string|undefined;code?:string|undefined;error?:string|undefined;iss?:string|undefined}){
  this.prune();
  const {state,code,error,iss}=input,flow=state!==undefined&&statePattern.test(state)?this.pending.get(state):undefined;
  if(!flow||state===undefined)return undefined;
  this.pending.delete(state);
  if(error!==undefined||code===undefined||!codePattern.test(code))return undefined;
  if(flow.requireIss?iss!==flow.issuer:(iss!==undefined&&iss!==flow.issuer))return undefined;
  if(flow.generation!==this.generation(flow.id)||this.lifetime.signal.aborted)return undefined;
  try{
   const reply=await this.token({...flow.client,token_endpoint:flow.token_endpoint},{grant_type:'authorization_code',code,redirect_uri:flow.redirect,code_verifier:flow.verifier,resource:flow.resource},AbortSignal.any([AbortSignal.timeout(30000),this.lifetime.signal]));
   const t=this.tokens(reply);
   if(flow.generation!==this.generation(flow.id))return undefined;
   writeMcpOAuth(this.secrets,flow.id,{version:1,resource:flow.resource,issuer:flow.issuer,token_endpoint:flow.token_endpoint,client_id:flow.client.client_id,...(flow.client.client_secret!==undefined?{client_secret:flow.client.client_secret}:{}),
    token_endpoint_auth_method:flow.client.method,...t,...(t.scope===undefined&&flow.scope?{scope:flow.scope}:{}),...(flow.revocation_endpoint?{revocation_endpoint:flow.revocation_endpoint}:{})});
  }catch{return undefined;}
  // A renewal that started with the previous login must not overwrite this one.
  this.bump(flow.id);this.needs.delete(flow.id);
  try{this.onLogin(flow.id);}catch{}
  return {id:flow.id};
 }
 private flag(id:string,credential:McpOAuthCredential){this.needs.set(id,fingerprint(credential));}
 /** The credential for this server and exact URL, or "login required". */
 private usable(id:string,resource:string){
  const credential=this.credential(id);
  if(!credential||credential.resource!==resource||this.needs.get(id)===fingerprint(credential))throw new McpLoginRequired();
  return credential;
 }
 private renew(id:string,resource:string,rejected:string,signal?:AbortSignal){
  let flight=this.flights.get(id);
  if(!flight){
   // Shared by every caller and bound to the connector's lifetime: a caller that gives up only stops waiting.
   const created=this.exchange(id,resource,rejected);flight=created;this.flights.set(id,created);
   const clear=()=>{if(this.flights.get(id)===created)this.flights.delete(id);};created.then(clear,clear);
  }
  return abandon(flight,signal).then(c=>c.access_token);
 }
 private async exchange(id:string,resource:string,rejected:string){
  const known=this.usable(id,resource),generation=this.generation(id);
  // Another caller already renewed it.
  if(known.access_token!==rejected)return known;
  if(!known.refresh_token){this.flag(id,known);throw new McpLoginRequired();}
  let reply:Reply;
  try{reply=await this.token({...known,method:known.token_endpoint_auth_method},{grant_type:'refresh_token',refresh_token:known.refresh_token,resource:known.resource},this.lifetime.signal);}
  catch{throw Error('oauth_refresh_failed');}
  // The login was replaced or removed while the request was out: whatever is stored now wins.
  if(generation!==this.generation(id))return this.usable(id,resource);
  if(reply.status===400||reply.status===401){this.flag(id,known);throw new McpLoginRequired();}
  let t:ReturnType<McpOAuth['tokens']>;
  try{t=this.tokens(reply);}catch{throw Error('oauth_refresh_failed');}
  const {expires_at:_,scope:__,...rest}=known;
  const next:McpOAuthCredential={...rest,access_token:t.access_token,refresh_token:t.refresh_token??known.refresh_token,...(t.expires_at!==undefined?{expires_at:t.expires_at}:{}),...((t.scope??known.scope)!==undefined?{scope:(t.scope??known.scope)!}:{})};
  try{writeMcpOAuth(this.secrets,id,next);}catch{throw Error('oauth_refresh_failed');}
  return next;
 }
 /** Token source for one connection. Tokens stay inside; the transport only ever asks for the current Bearer value. */
 source(id:string,url:string):McpOAuthSource{
  const resource=mcpUrl(url)?.href;
  if(!resource||!idPattern.test(id))throw Error('Invalid MCP OAuth request');
  return {
   access:async signal=>{
    signal?.throwIfAborted();
    const credential=this.usable(id,resource);
    if(credential.expires_at!==undefined&&credential.expires_at-Date.now()<=60_000){
     if(!credential.refresh_token){this.flag(id,credential);throw new McpLoginRequired();}
     return this.renew(id,resource,credential.access_token,signal);
    }
    return credential.access_token;
   },
   refresh:async(rejected,signal)=>{signal?.throwIfAborted();return this.renew(id,resource,rejected,signal);},
   reject:token=>{const credential=this.credential(id);if(credential&&credential.resource===resource&&credential.access_token===token)this.flag(id,credential);},
   secrets:()=>{const credential=this.credential(id);return credential?[credential.access_token,...(credential.refresh_token?[credential.refresh_token]:[])]:[];},
  };
 }
 /** Login state per server id, for ids saved as OAuth and for any id that has a credential or a login in progress. Never returns token values. */
 states(servers:readonly {id:string;url?:string|undefined;oauth?:true|undefined}[]):McpOAuthState[]{
  this.prune();
  const saved=new Map(servers.filter(s=>s.oauth&&s.url!==undefined).map(s=>[s.id,mcpUrl(s.url!)?.href]));
  let stored:string[]=[];try{stored=listMcpOAuth(this.secrets);}catch{}
  const pending=new Set([...this.pending.values()].map(f=>f.id));
  return [...new Set([...saved.keys(),...stored,...pending])].sort().slice(0,32).map(id=>{
   const credential=this.credential(id),want=saved.get(id),matches=!!credential&&(!saved.has(id)||credential.resource===want);
   return {id,pending:pending.has(id),resource_matches:matches,resource:credential?.resource??null,
    status:!credential?'signed_out' as const:!matches||this.needs.get(id)===fingerprint(credential)?'needs_login' as const:'signed_in' as const};
  });
 }
 /** Forgets in-memory state of a server whose credential is gone or replaced. */
 forget(id:string){this.bump(id);this.drop(id);this.needs.delete(id);}
 /** Removes the credential first, then asks the provider to revoke the token (best effort, 10 s, failures ignored). */
 async logout(id:string){
  if(!idPattern.test(id))throw Error('Invalid MCP OAuth request');
  this.forget(id);
  const credential=this.credential(id);
  writeMcpOAuth(this.secrets,id,undefined);
  const endpoint=credential?.revocation_endpoint?oauthUrl(credential.revocation_endpoint,mcpUrl(credential.resource)?.protocol==='http:'):undefined;
  // The client secret goes along, so only the token endpoint's own origin is trusted with it.
  if(!credential||!endpoint||endpoint.origin!==new URL(credential.token_endpoint).origin)return;
  const refresh=credential.refresh_token!==undefined;
  try{
   const body=new URLSearchParams({token:refresh?credential.refresh_token!:credential.access_token,token_type_hint:refresh?'refresh_token':'access_token',client_id:credential.client_id}),headers:Record<string,string>={'Content-Type':'application/x-www-form-urlencoded'};
   if(credential.client_secret!==undefined){
    if(credential.token_endpoint_auth_method==='client_secret_post')body.set('client_secret',credential.client_secret);
    else headers.Authorization='Basic '+Buffer.from(`${encodeURIComponent(credential.client_id)}:${encodeURIComponent(credential.client_secret)}`).toString('base64');
   }
   await this.send(endpoint,{method:'POST',headers,body:body.toString()},this.lifetime.signal,false,10);
  }catch{}
 }
 close(){this.pending.clear();this.lifetime.abort();}
}
