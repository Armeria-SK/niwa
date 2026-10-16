// OAuth login rules of the MCP settings screen, kept free of React so they can be tested on their own.
export const hrefOf=value=>{try{return new URL(value).href;}catch{return '';}};
export const loginEntry=(server,status)=>status?.oauth?.find(o=>o.id===server.id);
/** Every URL this connection ID has a login for. Older servers report only one. */
export const loginsOf=(server,status)=>{const entry=loginEntry(server,status);return entry?.logins??(entry?.resource?[{resource:entry.resource,status:entry.status}]:[]);};
/** The login for exactly the URL in the form (not for the saved one): a login belongs to the URL it was made for. */
export const loginFor=(server,status)=>loginsOf(server,status).find(login=>login.resource===hrefOf(server.url));
export const loggedIn=(server,status)=>loginFor(server,status)?.status==='signed_in';
/** Why a login in the list cannot be used for this card, if it cannot. */
export const loginNote=(server,status)=>{
 const logins=loginsOf(server,status),mine=loginFor(server,status);
 if(logins.length&&!mine)return 'このIDのログインは別のURLのものです。このURLでもう一度ログインしてください。';
 if(server.savedOAuth&&server.id!==server.savedId)return 'URLか接続IDを変えたため、もう一度ログインが必要です。';
 if(mine?.status==='needs_login')return 'ログインの有効期限が切れたか、取り消されました。もう一度ログインしてください。';
 return '';
};
const failureHints={
 invalid_client:'クライアントIDとシークレットを確認してください。',
 access_denied:'ログインが取り消されたか、拒否されました。',
 state_expired:'ログイン画面を開いてから10分以内に完了してください。',
 discovery_failed:'接続先のログイン情報を取得できませんでした。URLを確認してください。',
 network_error:'接続先に接続できませんでした。',
 token_exchange_failed:'接続先がログインを受け付けませんでした。',
 token_response_invalid:'接続先の返答が正しくありません。',
 pkce_unsupported:'この接続先はログインに必要なPKCEに対応していません。',
 endpoint_insecure:'この接続先のログイン用アドレスがHTTPSではありません。',
 issuer_mismatch:'接続先のログイン情報が一致しません。',
 resource_mismatch:'接続先のログイン情報が一致しません。',
 save_failed:'保存先の空き容量と権限を確認してください。',
};
/** The last failed login of this connection, as a line for the card. Empty when there is none, or when the card's own form already explains it. */
export const loginFailure=(server,status)=>{
 const failure=loginEntry(server,status)?.failure;
 if(!failure||failure.code==='client_registration_required'||failure.code==='changed')return '';
 return `ログインに失敗しました（${failure.code}）。${failureHints[failure.code]??'もう一度ログインしてください。'}`;
};
/** A renewed login that the server could not write to disk yet (it keeps it in memory meanwhile). */
export const loginUnsaved=(server,status)=>loginEntry(server,status)?.unsaved===true;
/** State line of an OAuth card. */
export const loginState=(server,status)=>loggedIn(server,status)?'ログイン済み':loginEntry(server,status)?.pending?'ログインを待っています':'ログインが必要です';
const failedOf=(server,status)=>status?.failed?.find(f=>f.id===server.id);
export const reasonText=reason=>reason==='login_required'?'ログインが必要です（「ログイン」を押してください）':reason;
/** Badge at the top of a card. A connection that only waits for its login is "not connected": the OAuth state line already says what to do. */
export const connectionState=(server,status,dirty)=>dirty?'未保存の変更あり':!server.enabled?'無効':status.connected?.includes(server.id)?'接続済み':failedOf(server,status)?.reason==='login_required'||!failedOf(server,status)?'未接続':'接続失敗（自動で再試行します）';
/** Error line of a card; the login wait of an OAuth card is not repeated here. */
export const connectionError=(server,status,dirty)=>{
 const failed=failedOf(server,status);
 return !failed||dirty||(server.auth==='oauth'&&failed.reason==='login_required')?'':`接続できません: ${reasonText(failed.reason)}`;
};
