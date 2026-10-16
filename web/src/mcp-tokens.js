// Static-token rules of the MCP settings screen, kept free of React so they can be tested on their own.
export const origin=value=>{try{return new URL(value).origin;}catch{return '';}};
/** The saved token belongs to the card it was saved with: same connection ID and URL origin. The server applies the same rule. */
export const savedToken=(server,status)=>server.transport==='url'&&server.id===server.savedId&&!!server.savedUrl&&origin(server.url)===origin(server.savedUrl)&&!!status?.tokens?.includes(server.savedId);
/** The field keeps what was typed (a value like "Basic abc" has a space); only the payload is trimmed. */
export const tokenText=server=>(server.token??'').trim();
/** "Delete the saved token" only counts while the checkbox that sets it is still shown. */
export const tokenCleared=(server,status)=>server.clearToken===true&&savedToken(server,status);
/** Token part of a probe request. */
export const probeToken=(server,status)=>{
 if(server.auth!=='token')return {};
 const typed=tokenText(server);
 return typed?{token:typed}:savedToken(server,status)&&!tokenCleared(server,status)?{id:server.id}:{};
};
/** Token changes sent with a save: a string sets, null removes. A stored token for an ID that this card was not saved with (a connection removed and added again, a new ID or origin) is removed unless the user types one. */
export function tokenChanges(servers,status){
 return servers.filter(s=>s.transport==='url'&&s.auth!=='oauth').flatMap(s=>{
  const typed=s.auth==='token'?tokenText(s):'';
  if(typed)return [{id:s.id,value:typed}];
  // An unreadable token file is never listed as saved; choosing "none" is how the administrator removes it.
  if(status?.token_errors?.includes(s.id))return s.auth==='none'?[{id:s.id,value:null}]:[];
  const has=!!status?.tokens?.includes(s.id);
  return has&&(s.auth==='none'||tokenCleared(s,status)||!savedToken(s,status))?[{id:s.id,value:null}]:[];
 });
}
