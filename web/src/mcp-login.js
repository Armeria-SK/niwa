// OAuth login rules of the MCP settings screen, kept free of React so they can be tested on their own.
import {serverText,t} from './i18n.js';
export const hrefOf=value=>{try{return new URL(value).href;}catch{return '';}};
export const loginEntry=(server,status)=>status?.oauth?.find(o=>o.id===server.id);
/** Every URL this connection ID has a login for. */
export const loginsOf=(server,status)=>loginEntry(server,status)?.logins??[];
/** The login for exactly the URL in the form (not for the saved one): a login belongs to the URL it was made for. */
export const loginFor=(server,status)=>loginsOf(server,status).find(login=>login.resource===hrefOf(server.url));
export const loggedIn=(server,status)=>loginFor(server,status)?.status==='signed_in';
/** Why a login in the list cannot be used for this card, if it cannot. */
export const loginNote=(server,status)=>{
 const logins=loginsOf(server,status),mine=loginFor(server,status);
 if(logins.length&&!mine)return t('connections.loginOtherUrl');
 if(server.savedOAuth&&server.id!==server.savedId)return t('connections.loginChanged');
 if(mine?.status==='needs_login')return t('connections.loginExpired');
 return '';
};
// Keys of the hint for each failure code; the text is looked up when it is shown, in the language of that moment.
const failureHints={
 invalid_client:'loginHintInvalidClient',
 access_denied:'loginHintAccessDenied',
 state_expired:'loginHintStateExpired',
 discovery_failed:'loginHintDiscoveryFailed',
 network_error:'loginHintNetworkError',
 token_exchange_failed:'loginHintTokenExchangeFailed',
 token_response_invalid:'loginHintTokenResponseInvalid',
 pkce_unsupported:'loginHintPkceUnsupported',
 endpoint_insecure:'loginHintEndpointInsecure',
 issuer_mismatch:'loginHintMismatch',
 resource_mismatch:'loginHintMismatch',
 save_failed:'checkStorage',
};
/** The last failed login, if it was for the URL in the form: a failure of another URL says nothing about this one. */
export const failureFor=(server,status)=>{const failure=loginEntry(server,status)?.failure;return failure?.resource===hrefOf(server.url)?failure:undefined;};
/** The last failed login of this connection, as a line for the card. Empty when there is none, or when the card's own form already explains it. */
export const loginFailure=(server,status)=>{
 const failure=failureFor(server,status);
 if(!failure||failure.code==='client_registration_required'||failure.code==='changed')return '';
 return t('connections.loginFailed',{code:failure.code,hint:t(`connections.${Object.hasOwn(failureHints,failure.code)?failureHints[failure.code]:'loginHintRetry'}`)});
};
/** A renewed login that the server could not write to disk yet (it keeps it in memory meanwhile). */
export const loginUnsaved=(server,status)=>loginEntry(server,status)?.unsaved===true;
/** State line of an OAuth card. */
export const loginState=(server,status)=>t(loggedIn(server,status)?'connections.loginSignedIn':loginEntry(server,status)?.pending?'connections.stateWaitingLogin':'connections.loginNeeded');
const failedOf=(server,status)=>status?.failed?.find(f=>f.id===server.id);
export const reasonText=reason=>reason==='login_required'?t('connections.reasonLoginRequired'):serverText(reason);
/** Badge at the top of a card. A connection that only waits for its login is "not connected": the OAuth state line already says what to do. */
export const connectionState=(server,status,dirty)=>t(dirty?'connections.stateUnsaved':!server.enabled?'connections.stateDisabled':status.connected?.includes(server.id)?'connections.stateConnected':failedOf(server,status)?.reason==='login_required'||!failedOf(server,status)?'connections.stateNotConnected':'connections.stateFailedRetrying');
/** Error line of a card; the login wait of an OAuth card is not repeated here. */
export const connectionError=(server,status,dirty)=>{
 const failed=failedOf(server,status);
 return !failed||dirty||(server.auth==='oauth'&&failed.reason==='login_required')?'':t('connections.connectionError',{reason:reasonText(failed.reason)});
};
/** Whether the card offers to type a client ID: not needed while the URL is signed in, unless the last failure points at the client. A form that is already open can always be closed. */
export const clientChoice=(server,status)=>server.needClient===true||!loggedIn(server,status)||['invalid_client','client_registration_required'].includes(failureFor(server,status)?.code);
/** What to do with the client ID form of a card once a login was started from it: leave it while the login is open, close it (and forget what was typed) when the login succeeded, keep it when it ended otherwise. Either way the fallback link of the finished login goes. Nothing when no login was started from the card. */
export const settleClientForm=(server,status)=>{
 if(!server.awaitingLogin)return undefined;
 const entry=loginEntry(server,status);
 if(entry?.pending)return undefined;
 return loggedIn(server,status)&&!failureFor(server,status)?{awaitingLogin:false,loginLink:'',needClient:false,clientId:'',clientSecret:''}:{awaitingLogin:false,loginLink:''};
};
/** The hint that a client is reused is only true while one is on file. */
export const clientOnFile=(server,status)=>loginEntry(server,status)?.client_saved===true;
