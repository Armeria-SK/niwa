// OAuth login rules of the MCP settings screen, kept free of React so they can be tested on their own.
export const hrefOf=value=>{try{return new URL(value).href;}catch{return '';}};
export const loginEntry=(server,status)=>status?.oauth?.find(o=>o.id===server.id);
/** Signed in for exactly the URL in the form, whatever URL is saved: the login belongs to the URL it was made for. */
export const loggedIn=(server,status)=>{const entry=loginEntry(server,status);return !!entry&&entry.status==='signed_in'&&entry.resource===hrefOf(server.url);};
/** Why a login in the list cannot be used for this card, if it cannot. */
export const loginNote=(server,status)=>{
 const entry=loginEntry(server,status);
 if(entry?.resource&&entry.resource!==hrefOf(server.url))return 'このIDのログインは別のURLのものです。このURLでもう一度ログインしてください。';
 if(server.savedOAuth&&server.id!==server.savedId)return 'URLか接続IDを変えたため、もう一度ログインが必要です。';
 if(entry?.status==='needs_login')return 'ログインの有効期限が切れたか、取り消されました。もう一度ログインしてください。';
 return '';
};
/** A renewed login that the server could not write to disk yet (it keeps it in memory meanwhile). */
export const loginUnsaved=(server,status)=>loginEntry(server,status)?.unsaved===true;
