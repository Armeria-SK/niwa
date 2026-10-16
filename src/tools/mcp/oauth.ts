import {createHash,randomBytes} from 'node:crypto';
import {createPkcePair} from '../../auth/codex-oauth.ts';
import {McpLoginRequired,mcpUrl,oauthUrl,type McpOAuthSource} from './client.ts';
import {listMcpOAuth,listMcpOAuthClients,readMcpOAuth,readMcpOAuthClient,removeMcpOAuth,removeMcpOAuthFile,writeMcpOAuth,writeMcpOAuthClient,type McpOAuthClient,type McpOAuthCredential} from './oauth-store.ts';

type AuthMethod=McpOAuthCredential['token_endpoint_auth_method'];
interface Client{client_id:string;client_secret?:string;method:AuthMethod;origin:'manual'|'registered'}
interface Flow{id:string;slot:string;resource:string;audience:string;issuer:string;token_endpoint:string;revocation_endpoint?:string;client:Client;verifier:string;redirect:string;scope?:string;requireIss:boolean;generation:number;expires:number}
interface Reply{status:number;headers:Headers;json:Record<string,unknown>|undefined}
interface Server{token_endpoint:string;authorization_endpoint:string;registration_endpoint?:string;revocation_endpoint?:string;requireIss:boolean;useBasic:boolean}
export interface McpOAuthLogin{resource:string;status:'signed_in'|'needs_login';unsaved?:true}
/** Login state of one connection ID: every URL it has a login for, whether a login is in progress, the last failure, and whether a client is on file (no secret). `unsaved` is present while a renewed login could not be written to disk. */
export interface McpOAuthState{id:string;logins:McpOAuthLogin[];pending:boolean;client_saved:boolean;unsaved?:true;failure?:{code:string;at:number;resource:string}}
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
/** Client authentication of a request to the token or revocation endpoint: the secret in the body or as HTTP Basic, as the client was registered. */
function authenticate(body:URLSearchParams,headers:Record<string,string>,client:{client_id:string;client_secret?:string|undefined;method:AuthMethod}){
 if(client.client_secret===undefined)return;
 if(client.method==='client_secret_post')body.set('client_secret',client.client_secret);
 else headers.Authorization='Basic '+Buffer.from(`${encodeURIComponent(client.client_id)}:${encodeURIComponent(client.client_secret)}`).toString('base64');
}
/** A login after a renewal: the tokens and their lifetime are new, everything else stays. */
const renewed=(known:McpOAuthCredential,t:{access_token:string;refresh_token?:string;expires_at?:number;lifetime?:number;scope?:string}):McpOAuthCredential=>{
 const {expires_at:_,lifetime:__,scope:___,...rest}=known;
 return {...rest,issued_at:Date.now(),access_token:t.access_token,...((t.refresh_token??known.refresh_token)!==undefined?{refresh_token:(t.refresh_token??known.refresh_token)!}:{}),...(t.expires_at!==undefined?{expires_at:t.expires_at}:{}),...(t.lifetime!==undefined?{lifetime:t.lifetime}:{}),...((t.scope??known.scope)!==undefined?{scope:(t.scope??known.scope)!}:{})};
};
const slotOf=(id:string,resource:string)=>`${id}\n${resource}`;
const idOf=(slot:string)=>slot.slice(0,slot.indexOf('\n'));
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

/** OAuth login for remote MCP servers (MCP Authorization 2025-06-18): discovery, registration, PKCE login, refresh. Pending logins live in memory only.
 * Everything that belongs to one login is kept per connection ID and URL (a "slot"), so a login made for an edited, unsaved URL never touches the one the saved connection uses. */
export class McpOAuth{
 private pending=new Map<string,Flow>();
 private flights=new Map<string,Promise<McpOAuthCredential>>();
 private generations=new Map<string,number>();
 private needs=new Map<string,string>();
 /** Renewed logins that could not be written yet, by slot; valid only for the generation they were made in. */
 private held=new Map<string,{credential:McpOAuthCredential;generation:number;retry:number}>();
 /** Logins whose code exchange is running, by slot, so a configuration change can still cancel them. */
 private exchanging=new Map<string,number>();
 /** Logins whose discovery or registration is still running, by slot. */
 private starting=new Map<string,number>();
 /** Ids whose client the provider refused (invalid_client): the stored client is not tried again. */
 private clientRejected=new Set<string>();
 /** The last failed login per id: a short reason code and the time, nothing else. */
 private failures=new Map<string,{code:string;at:number;resource:string}>();
 private lifetime=new AbortController();
 private fetcher:typeof fetch;
 private onLogin:(id:string)=>void;
 constructor(private secrets:string,options:{fetcher?:typeof fetch;onLogin?:(id:string)=>void}={}){this.fetcher=options.fetcher??fetch;this.onLogin=options.onLogin??(()=>{});}
 private generation(slot:string){return this.generations.get(slot)??0;}
 private bump(slot:string){const next=this.generation(slot)+1;this.generations.set(slot,next);return next;}
 private prune(){const now=Date.now();for(const [state,flow] of this.pending)if(flow.expires<=now)this.pending.delete(state);}
 private dropSlot(slot:string){for(const [state,flow] of this.pending)if(flow.slot===slot)this.pending.delete(state);}
 /** Every slot of one connection that has anything in memory. */
 private slotsOf(id:string){
  const slots=new Set<string>();
  for(const source of [this.generations,this.needs,this.held,this.exchanging,this.starting,this.flights])for(const slot of source.keys())if(idOf(slot)===id)slots.add(slot);
  for(const flow of this.pending.values())if(flow.id===id)slots.add(flow.slot);
  return slots;
 }
 private fail(id:string,code:string,resource:string){
  // A start cancelled by a configuration change is not a failure of the login.
  if(code==='changed')return;
  this.failures.set(id,{code,at:Date.now(),resource});
  if(code!=='client_registration_required')console.error(`MCP OAuth: login of "${id}" failed (${code})`);
 }
 private credential(id:string,resource:string){
  const slot=slotOf(id,resource),held=this.held.get(slot);
  if(held){
   if(held.generation!==this.generation(slot))this.held.delete(slot);
   else{
    if(Date.now()>=held.retry){
     held.retry=Date.now()+5000;
     try{writeMcpOAuth(this.secrets,id,held.credential);this.held.delete(slot);}catch{}
    }
    return held.credential;
   }
  }
  try{return readMcpOAuth(this.secrets,id,resource);}catch{return undefined;}
 }
 /** All readable logins of one connection (held ones in place of their files). */
 private credentials(id:string){
  const found=new Map<string,McpOAuthCredential>();
  try{for(const entry of listMcpOAuth(this.secrets))if(entry.id===id&&entry.credential)found.set(entry.credential.resource,entry.credential);}catch{}
  for(const slot of this.held.keys())if(idOf(slot)===id){const resource=slot.slice(id.length+1),credential=this.credential(id,resource);if(credential)found.set(resource,credential);}
  return [...found.values()].sort((a,b)=>a.resource<b.resource?-1:1);
 }
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
  const candidates=hinted?[hinted]:[new URL(base+path+resource.search),...(path||resource.search?[new URL(base)]:[])];
  let document:Record<string,unknown>|undefined,source:URL|undefined;
  for(const candidate of candidates){
   const reply=await this.send(candidate,{method:'GET'},signal).catch(()=>undefined);
   if(reply?.status===200&&reply.json){document=reply.json;source=candidate;break;}
  }
  const hint=scope!==undefined&&scope.length<=2048&&scopePattern.test(scope)?scope:undefined;
  // The server named its metadata itself, so a failure there is a failure; only an unmarked server may fall back.
  if(hinted&&!document)throw new OAuthError('discovery_failed');
  // Servers from before RFC 9728 act as their own authorization server.
  // RFC 8707 asks for the identifier without a lone trailing slash (https://host, not https://host/).
  const bare=resource.pathname==='/'&&!resource.search?resource.origin:resource.href;
  if(!document||!source)return {issuer:resource.origin,scope:hint,audience:bare};
  const servers=strings(document.authorization_servers),issuer=servers?.[0];
  if(!servers?.length||issuer===undefined)throw new OAuthError('metadata_invalid');
  const parsed=oauthUrl(issuer,local);
  if(!parsed)throw new OAuthError('endpoint_insecure');
  if(parsed.search)throw new OAuthError('metadata_invalid');
  if(document.resource===undefined){if(source.origin!==resource.origin)throw new OAuthError('resource_mismatch');}
  else if(typeof document.resource!=='string'||normal(document.resource)!==normal(resource.href))throw new OAuthError('resource_mismatch');
  const supported=strings(document.scopes_supported)?.filter(s=>/^[\x21-\x7e]+$/.test(s)).join(' ');
  return {issuer,scope:hint??(supported&&supported.length<=2048?supported:undefined),audience:typeof document.resource==='string'?document.resource:bare};
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
   requireIss:document.authorization_response_iss_parameter_supported===true,useBasic:!(methods?.includes('client_secret_post')&&!methods.includes('client_secret_basic'))};
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
  if(method==='none')return {client_id,method,origin:'registered'};
  if(client_secret===undefined)throw new OAuthError('registration_failed');
  return {client_id,client_secret,method,origin:'registered'};
 }
 /** A second login at the same authorization server and callback keeps the client of the first (manual ones included), also after logout, so nothing has to be entered or registered again. */
 private reusable(id:string,issuer:string,redirect:string):Client|undefined{
  if(this.clientRejected.has(id))return undefined;
  let saved:McpOAuthClient|undefined;
  try{saved=readMcpOAuthClient(this.secrets,id);}catch{}
  if(!saved||saved.issuer!==issuer||saved.redirect_uri!==redirect)return undefined;
  return {client_id:saved.client_id,...(saved.client_secret!==undefined?{client_secret:saved.client_secret}:{}),method:saved.token_endpoint_auth_method,origin:saved.origin};
 }
 /** The provider no longer knows this client: forget it for good, so the next login registers again or asks for a client ID. */
 private dropClient(id:string,refused:{client_id:string;client_secret?:string|undefined;method:AuthMethod}){
  // Only the client on file itself: a variant typed into the form (a wrong secret, say) says nothing about it.
  try{
   const saved=readMcpOAuthClient(this.secrets,id);
   if(saved?.client_id!==refused.client_id||saved.client_secret!==refused.client_secret||saved.token_endpoint_auth_method!==refused.method)return;
   this.clientRejected.add(id);writeMcpOAuthClient(this.secrets,id,undefined);
  }catch{}
 }
 /** Discovers the authorization server, obtains a client and returns the address the administrator logs in at. */
 async start(id:string,url:string,manual:{client_id:string;client_secret?:string|undefined}|undefined,callback:string,signal?:AbortSignal):Promise<McpOAuthStart>{
  const resource=mcpUrl(url),redirect=oauthUrl(callback,true);
  if(!resource||!idPattern.test(id)||!redirect||redirect.search||(manual&&!/^[\x21-\x7e]{1,512}$/.test(manual.client_id)))throw Error('Invalid MCP OAuth request');
  const slot=slotOf(id,resource.href),begun=this.generation(slot),all=AbortSignal.any([AbortSignal.timeout(60000),this.lifetime.signal,...(signal?[signal]:[])]),local=resource.protocol==='http:';
  this.starting.set(slot,(this.starting.get(slot)??0)+1);
  try{
   const found=await this.protectedResource(resource,local,all);
   const server=await this.authorizationServer(found.issuer,local,all);
   const client:Client=manual?{client_id:manual.client_id,...(manual.client_secret!==undefined?{client_secret:manual.client_secret}:{}),method:manual.client_secret===undefined?'none':server.useBasic?'client_secret_basic':'client_secret_post',origin:'manual'}
    :this.reusable(id,found.issuer,redirect.href)??(server.registration_endpoint?await this.register(server,redirect.href,all):(()=>{throw new OAuthError('client_registration_required');})());
   if(this.generation(slot)!==begun)throw new OAuthError('changed');
   this.prune();this.dropSlot(slot);
   while(this.pending.size>=8)this.pending.delete(this.pending.keys().next().value!);
   const pkce=createPkcePair(),state=randomBytes(32).toString('base64url'),expires=Date.now()+10*60_000,generation=this.generation(slot);
   this.pending.set(state,{id,slot,resource:resource.href,audience:found.audience,issuer:found.issuer,token_endpoint:server.token_endpoint,...(server.revocation_endpoint?{revocation_endpoint:server.revocation_endpoint}:{}),client,verifier:pkce.verifier,redirect:redirect.href,...(found.scope?{scope:found.scope}:{}),requireIss:server.requireIss,generation,expires});
   const target=new URL(server.authorization_endpoint);
   for(const [key,value] of Object.entries({response_type:'code',client_id:client.client_id,redirect_uri:redirect.href,code_challenge:pkce.challenge,code_challenge_method:'S256',state,resource:found.audience,...(found.scope?{scope:found.scope}:{})}))target.searchParams.set(key,value);
   this.failures.delete(id);
   return {ok:true,url:target.href,expires_at:expires};
  }catch(error){
   const code=error instanceof OAuthError?error.code:'start_failed';
   this.fail(id,code,resource.href);
   return {ok:false,code,message:`${messages[code]??generic}（${code}）`};
  }finally{const left=(this.starting.get(slot)??1)-1;if(left>0)this.starting.set(slot,left);else this.starting.delete(slot);}
 }
 private async token(credential:{token_endpoint:string;client_id:string;client_secret?:string|undefined;method:AuthMethod},form:Record<string,string>,signal:AbortSignal){
  const body=new URLSearchParams({...form,client_id:credential.client_id}),headers:Record<string,string>={'Content-Type':'application/x-www-form-urlencoded'};
  authenticate(body,headers,credential);
  return this.send(new URL(credential.token_endpoint),{method:'POST',headers,body:body.toString()},signal);
 }
 private tokens(reply:Reply){
  const value=reply.json;
  const token=/^[\x21\x23-\x5b\x5d-\x7e]{8,16384}$/;
  if(reply.status!==200||!value||typeof value.access_token!=='string'||!token.test(value.access_token)||typeof value.token_type!=='string'||!/^bearer$/i.test(value.token_type))throw new OAuthError('token_response_invalid');
  const {refresh_token,scope}=value,seconds=typeof value.expires_in==='string'&&/^[0-9]{1,10}(?:\.[0-9]{1,9})?$/.test(value.expires_in)?Number(value.expires_in):value.expires_in;
  if(refresh_token!==undefined&&(typeof refresh_token!=='string'||!token.test(refresh_token)))throw new OAuthError('token_response_invalid');
  if(seconds!==undefined&&(typeof seconds!=='number'||!Number.isFinite(seconds)||seconds<0))throw new OAuthError('token_response_invalid');
  return {access_token:value.access_token,...(refresh_token!==undefined?{refresh_token}:{}),...(seconds!==undefined?{expires_at:Date.now()+Math.floor(Math.min(seconds,10*365*86400))*1000,lifetime:Math.floor(Math.min(seconds,10*365*86400))}:{}),
   ...(typeof scope==='string'&&scope.length<=2048&&/^[\x20-\x7e]*$/.test(scope)?{scope}:{})};
 }
 /** Completes a login from the browser's return. Callable without the admin session: the single-use state created by an authenticated start is the proof. Failures carry no detail, but their reason code is kept for the settings screen. */
 async finish(input:{state?:string|undefined;code?:string|undefined;error?:string|undefined;iss?:string|undefined}){
  const {state,code,error,iss}=input,flow=state!==undefined&&statePattern.test(state)?this.pending.get(state):undefined;
  if(!flow||state===undefined){this.prune();return undefined;}
  this.pending.delete(state);this.prune();
  if(flow.expires<=Date.now()){this.fail(flow.id,'state_expired',flow.resource);return undefined;}
  if(error!==undefined){this.fail(flow.id,/^[a-z_]{1,40}$/.test(error)?error:'access_denied',flow.resource);return undefined;}
  if(code===undefined||!codePattern.test(code)){this.fail(flow.id,'invalid_callback',flow.resource);return undefined;}
  if(flow.requireIss?iss!==flow.issuer:(iss!==undefined&&iss!==flow.issuer)){this.fail(flow.id,'issuer_mismatch',flow.resource);return undefined;}
  if(flow.generation!==this.generation(flow.slot)||this.lifetime.signal.aborted)return undefined;
  this.exchanging.set(flow.slot,(this.exchanging.get(flow.slot)??0)+1);
  let replaced:McpOAuthCredential|undefined;
  try{
   const reply=await this.token({...flow.client,token_endpoint:flow.token_endpoint},{grant_type:'authorization_code',code,redirect_uri:flow.redirect,code_verifier:flow.verifier,resource:flow.audience},AbortSignal.any([AbortSignal.timeout(30000),this.lifetime.signal]));
   if(reply.json?.error==='invalid_client'){this.dropClient(flow.id,flow.client);throw new OAuthError('invalid_client');}
   if(reply.status!==200)throw new OAuthError('token_exchange_failed');
   const t=this.tokens(reply);
   // A login that is already out of date and cannot be renewed would only look signed in.
   if(t.expires_at!==undefined&&t.expires_at<=Date.now()&&t.refresh_token===undefined)throw new OAuthError('token_response_invalid');
   const issued:McpOAuthCredential={version:1,issued_at:Date.now(),resource:flow.resource,audience:flow.audience,redirect_uri:flow.redirect,issuer:flow.issuer,token_endpoint:flow.token_endpoint,client_id:flow.client.client_id,...(flow.client.client_secret!==undefined?{client_secret:flow.client.client_secret}:{}),
    token_endpoint_auth_method:flow.client.method,...t,...(t.scope===undefined&&flow.scope?{scope:flow.scope}:{}),...(flow.revocation_endpoint?{revocation_endpoint:flow.revocation_endpoint}:{})};
   // The login was cancelled while the provider answered: the tokens it just issued are of no use to anyone and are given back.
   if(flow.generation!==this.generation(flow.slot)){void this.revoke(issued);return undefined;}
   replaced=this.credential(flow.id,flow.resource);
   try{writeMcpOAuth(this.secrets,flow.id,issued);}catch{throw new OAuthError('save_failed');}
   // The client stays on file after logout; failing to keep this copy does not undo the login.
   try{writeMcpOAuthClient(this.secrets,flow.id,{version:1,issuer:flow.issuer,redirect_uri:flow.redirect,client_id:flow.client.client_id,...(flow.client.client_secret!==undefined?{client_secret:flow.client.client_secret}:{}),token_endpoint_auth_method:flow.client.method,origin:flow.client.origin});}catch{}
  }catch(error){this.fail(flow.id,error instanceof OAuthError?error.code:'token_exchange_failed',flow.resource);return undefined;}
  finally{const left=(this.exchanging.get(flow.slot)??1)-1;if(left>0)this.exchanging.set(flow.slot,left);else this.exchanging.delete(flow.slot);}
  // A renewal that started with the previous login must not overwrite this one.
  this.bump(flow.slot);this.held.delete(flow.slot);this.needs.delete(flow.slot);this.clientRejected.delete(flow.id);this.failures.delete(flow.id);
  // The login this one replaces is revoked too, unless the provider would take the new one with it (same client at the same provider).
  if(replaced&&(replaced.issuer!==flow.issuer||replaced.client_id!==flow.client.client_id))void this.revoke(replaced);
  try{this.onLogin(flow.id);}catch{}
  return {id:flow.id};
 }
 private flag(id:string,credential:McpOAuthCredential){this.needs.set(slotOf(id,credential.resource),fingerprint(credential));}
 private flagged(id:string,credential:McpOAuthCredential){return this.needs.get(slotOf(id,credential.resource))===fingerprint(credential);}
 /** The credential for this server and exact URL, or "login required". */
 private usable(id:string,resource:string){
  const credential=this.credential(id,resource);
  if(!credential||credential.resource!==resource||this.flagged(id,credential))throw new McpLoginRequired();
  return credential;
 }
 private renew(id:string,resource:string,rejected:string,signal?:AbortSignal){
  // One renewal per login and URL: a request for another URL never receives this login's token.
  const key=slotOf(id,resource);let flight=this.flights.get(key);
  if(!flight){
   // Shared by every caller and bound to the connector's lifetime: a caller that gives up only stops waiting.
   const created=this.exchange(id,resource,rejected);flight=created;this.flights.set(key,created);
   const clear=()=>{if(this.flights.get(key)===created)this.flights.delete(key);};created.then(clear,clear);
  }
  return abandon(flight,signal).then(c=>c.access_token);
 }
 private async exchange(id:string,resource:string,rejected:string){
  const known=this.usable(id,resource),slot=slotOf(id,resource),generation=this.generation(slot);
  // Another caller already renewed it.
  if(known.access_token!==rejected)return known;
  if(!known.refresh_token){this.flag(id,known);throw new McpLoginRequired();}
  let reply:Reply;
  try{reply=await this.token({...known,method:known.token_endpoint_auth_method},{grant_type:'refresh_token',refresh_token:known.refresh_token,resource:known.audience??known.resource},this.lifetime.signal);}
  catch{throw Error('oauth_refresh_failed');}
  // The login was replaced or removed while the request was out: whatever is stored now wins, and what the provider just issued is given back.
  if(generation!==this.generation(slot)){
   if(reply.status===200)try{const t=this.tokens(reply);void this.revoke(renewed(known,t));}catch{}
   return this.usable(id,resource);
  }
  if(reply.status===400||reply.status===401){if(reply.json?.error==='invalid_client')this.dropClient(id,{client_id:known.client_id,client_secret:known.client_secret,method:known.token_endpoint_auth_method});this.flag(id,known);throw new McpLoginRequired();}
  let t:ReturnType<McpOAuth['tokens']>;
  try{t=this.tokens(reply);}catch{throw Error('oauth_refresh_failed');}
  const next=renewed(known,t);
  try{writeMcpOAuth(this.secrets,id,next);this.held.delete(slot);}
  catch{
   // The provider may have retired the old refresh token already, so the renewed login is kept in memory and written again later.
   this.held.set(slot,{credential:next,generation,retry:Date.now()+5000});
   console.error(`MCP OAuth: could not save the renewed login of "${id}"; it is kept in memory and saving is retried`);
  }
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
    // A short-lived token is renewed when half of its lifetime is gone (at the latest 60 s before the end), not before every request.
    const margin=credential.lifetime===undefined?60_000:Math.min(60_000,credential.lifetime*500);
    if(credential.expires_at!==undefined&&credential.expires_at-Date.now()<=margin){
     if(!credential.refresh_token){this.flag(id,credential);throw new McpLoginRequired();}
     return this.renew(id,resource,credential.access_token,signal);
    }
    return credential.access_token;
   },
   refresh:async(rejected,signal)=>{signal?.throwIfAborted();return this.renew(id,resource,rejected,signal);},
   // Only a login that is still the rejected one is marked; a refusal that arrives after a new login says nothing about it.
   reject:token=>{const credential=this.credential(id,resource);if(!credential||credential.access_token!==token)return false;this.flag(id,credential);return true;},
   secrets:()=>{const credential=this.credential(id,resource);return credential?[credential.access_token,...(credential.refresh_token?[credential.refresh_token]:[])]:[];},
  };
 }
 /** Login state per server id, for ids saved as OAuth and for any id that has a login or one in progress. The top-level fields describe the login for the saved URL; `logins` lists every URL that has one, so the screen can tell whether an edited URL is covered. Never returns token values. */
 states(servers:readonly {id:string;url?:string|undefined;oauth?:true|undefined}[]):McpOAuthState[]{
  this.prune();
  const saved=new Map(servers.filter(s=>s.oauth&&s.url!==undefined).map(s=>[s.id,mcpUrl(s.url!)?.href]));
  let listed:{id:string}[]=[];try{listed=listMcpOAuth(this.secrets);}catch{}
  const pending=new Set([...this.pending.values()].map(f=>f.id));
  const held=[...this.held.keys()].map(idOf);
  let clients:string[]=[];try{clients=listMcpOAuthClients(this.secrets);}catch{}
  return [...new Set([...saved.keys(),...listed.map(e=>e.id),...pending,...held,...this.failures.keys(),...clients])].sort().slice(0,32).map(id=>{
   const creds=this.credentials(id);
   const logins:McpOAuthLogin[]=creds.map(c=>({resource:c.resource,status:this.flagged(id,c)?'needs_login' as const:'signed_in' as const,...(this.held.has(slotOf(id,c.resource))?{unsaved:true as const}:{})}));
   const last=this.failures.get(id);
   // A failure stays relevant only until a login for the same URL is made or renewed after it.
   const failure=last&&!creds.some(c=>c.resource===last.resource&&c.issued_at!==undefined&&c.issued_at>last.at&&!this.flagged(id,c))?last:undefined;
   let client_saved=false;try{client_saved=readMcpOAuthClient(this.secrets,id)!==undefined;}catch{}
   return {id,pending:pending.has(id),logins,client_saved,...(logins.some(l=>l.unsaved)?{unsaved:true as const}:{}),...(failure?{failure}:{})};
  });
 }
 /** Forgets in-memory state of a server whose logins are gone or replaced: every URL of it, the client rejection and the last failure. */
 forget(id:string){
  for(const slot of this.slotsOf(id))this.forgetSlot(slot);
  this.clientRejected.delete(id);this.failures.delete(id);
 }
 private forgetSlot(slot:string){this.bump(slot);this.dropSlot(slot);this.held.delete(slot);this.needs.delete(slot);}
 /** A configuration was saved (`keep`: connection ID to its saved URL for every OAuth connection): logins in progress for other connections, and for other URLs of kept ones, are cancelled, so a late return cannot store a login nobody uses. Returns the renewed logins that were only held in memory and are now dropped, so they can be revoked instead of an older copy. */
 forgetExcept(keep:ReadonlyMap<string,string>){
  for(const id of this.failures.keys())if(!keep.has(id))this.failures.delete(id);
  const active=new Set([...this.pending.values()].map(f=>f.slot));
  for(const source of [this.exchanging,this.starting,this.held,this.flights])for(const slot of source.keys())active.add(slot);
  const dropped:{id:string;credential:McpOAuthCredential}[]=[];
  for(const slot of active){
   const id=idOf(slot);
   if(keep.get(id)===slot.slice(id.length+1))continue;
   const held=this.held.get(slot);
   if(held)dropped.push({id,credential:held.credential});
   if(!keep.has(id))this.forget(id);else this.forgetSlot(slot);
  }
  return dropped;
 }
 /** Every login there is, on disk or only held in memory, whatever connection it belongs to. */
 private everyCredential(){
  const found:McpOAuthCredential[]=[];
  try{for(const entry of listMcpOAuth(this.secrets))if(entry.credential)found.push(entry.credential);}catch{}
  for(const held of this.held.values())found.push(held.credential);
  return found;
 }
 /** Asks the provider to revoke a login (best effort, 10 s, failures ignored). The refresh token and the client secret go along, so only the token endpoint's own origin is trusted with them. */
 async revoke(credential:McpOAuthCredential){
  // Some providers end every token of a user and client when one is revoked: a login that stays (of any connection) with the same client must not be asked to share the fate of the one that goes.
  if(this.everyCredential().some(other=>other.access_token!==credential.access_token&&other.issuer===credential.issuer&&other.client_id===credential.client_id))return;
  const endpoint=credential.revocation_endpoint?oauthUrl(credential.revocation_endpoint,mcpUrl(credential.resource)?.protocol==='http:'):undefined;
  if(!endpoint||endpoint.origin!==new URL(credential.token_endpoint).origin)return;
  const refresh=credential.refresh_token!==undefined;
  try{
   const body=new URLSearchParams({token:refresh?credential.refresh_token!:credential.access_token,token_type_hint:refresh?'refresh_token':'access_token',client_id:credential.client_id}),headers:Record<string,string>={'Content-Type':'application/x-www-form-urlencoded'};
   authenticate(body,headers,{...credential,method:credential.token_endpoint_auth_method});
   await this.send(endpoint,{method:'POST',headers,body:body.toString()},this.lifetime.signal,false,10);
  }catch{}
 }
 /** Removes the login for one URL (or every URL of the connection) first, then asks the provider to revoke it. The client on file stays, so the next login needs no form. Returns the URLs that lost their login. */
 async logout(id:string,resource?:string){
  if(!idPattern.test(id))throw Error('Invalid MCP OAuth request');
  // Read first: a renewed login that is only held in memory is the one to revoke.
  const targets=this.credentials(id).filter(c=>resource===undefined||c.resource===resource);
  if(resource===undefined){
   this.forget(id);
   for(const entry of listMcpOAuth(this.secrets))if(entry.id===id)removeMcpOAuthFile(this.secrets,entry.file);
  }else{this.forgetSlot(slotOf(id,resource));removeMcpOAuth(this.secrets,id,resource);}
  // A client that was registered automatically is registered again next time (cheap); one typed in by hand stays.
  try{if(readMcpOAuthClient(this.secrets,id)?.origin==='registered')writeMcpOAuthClient(this.secrets,id,undefined);}catch{}
  for(const credential of targets)await this.revoke(credential);
  return targets.map(c=>c.resource);
 }
 close(){this.pending.clear();this.lifetime.abort();}
}
