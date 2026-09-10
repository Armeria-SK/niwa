import type {ModelEvent} from '../../contracts/model.ts';
import {DomainError} from '../../domain/types.ts';
import {CredentialStoreUnavailableError} from '../../auth/credential-store.ts';
import {HttpError} from '../../shared/http-json.ts';
import {ModelCatalogError} from './catalog.ts';

type Failure = Extract<ModelEvent,{type:'failed'}>['error'];
/** Trusted classifications only: exception messages and response bodies never enter task records. */
export class ModelSetupError extends Error {
  constructor(readonly failure:Failure) {super('Model connection preparation failed');}
}
export function setupFailure(error:unknown):Failure {
  if(error instanceof ModelSetupError)return error.failure;
  if(error instanceof CredentialStoreUnavailableError)return {code:'AUTH_UNAVAILABLE',retryable:false,message:'認証情報の保存先を確認してください。'};
  if(error instanceof ModelCatalogError){
    const codes:Record<ModelCatalogError['code'],Failure['code']>={AUTH_UNAVAILABLE:'AUTH_UNAVAILABLE',AUTHENTICATION_FAILED:'AUTHENTICATION_FAILED',CATALOG_TIMED_OUT:'TIMED_OUT',CATALOG_NETWORK_ERROR:'NETWORK_ERROR',CATALOG_UNAVAILABLE:'PROVIDER_UNAVAILABLE',CATALOG_RATE_LIMITED:'RATE_LIMITED',CATALOG_INVALID_RESPONSE:'INVALID_RESPONSE',CATALOG_EMPTY_RESPONSE:'INVALID_RESPONSE',ABORTED:'ABORTED'};
    return {code:codes[error.code],retryable:error.retryable,message:`モデル一覧の確認に失敗しました (${error.code})。`};
  }
  if(error instanceof HttpError){
    const code:Failure['code']=error.kind==='network'?'NETWORK_ERROR':error.kind==='timeout'?'TIMED_OUT':error.kind==='aborted'?'ABORTED':error.status===401?'AUTHENTICATION_FAILED':error.status===403?'PERMISSION_DENIED':error.status===429?'RATE_LIMITED':error.status&&error.status>=500?'PROVIDER_UNAVAILABLE':'INVALID_RESPONSE';
    return {code,retryable:['NETWORK_ERROR','TIMED_OUT','RATE_LIMITED','PROVIDER_UNAVAILABLE'].includes(code),message:'モデル能力の確認に失敗しました。'};
  }
  return {code:error instanceof DomainError?'INVALID_REQUEST':'PROVIDER_ERROR',retryable:false,message:'モデル接続の設定または準備処理を確認してください。'};
}
