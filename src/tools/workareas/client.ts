import {createHash} from 'node:crypto';
import {callWorkspace,WorkspaceRequestError,definitiveRefusals} from '../files/client.ts';
import {verifyExecutorEndpoint} from '../../config/executor-endpoint.ts';
import type {WorkareaTransport} from '../../runtime/workareas.ts';
import type {JsonObject} from '../../contracts/model.ts';
/** This capability is only held by the application composition root. */
export function workareaClient(socket:string,uid:number):WorkareaTransport{
 const verify=verifyExecutorEndpoint(socket,uid);
 return async(input,signal)=>{
  // Preview starts a browser container, navigates and screenshots; keep this above the server-side limits.
  const timeout=['run','environment_prepare','environment_test','environment_run'].includes(input.operation)?3_000_000:input.operation==='execution_preview'?120_000:10_000;
  // A refusal before any work started is a result the caller can act on (busy is retryable), not an unknown outcome.
  const result=await callWorkspace(socket,verify,input as unknown as JsonObject,signal,12*1024*1024,'/workareas',timeout).catch(error=>{
   if(error instanceof WorkspaceRequestError&&definitiveRefusals.includes(error.code))return {error:error.code==='unavailable'?'busy':error.code,...(error.code==='busy'||error.code==='unavailable'?{retryable:true}:{})};
   throw error;
  });
  if(!result||typeof result!=='object'||Array.isArray(result))throw Error('Invalid workarea reply');
  const output=result as JsonObject;
  if (!output.error && ['download','published'].includes(input.operation)) {
   if(typeof output.data!=='string')throw Error('Invalid file bytes');
   const bytes=Buffer.from(output.data,'base64');
   if(bytes.length>8*1024*1024||bytes.toString('base64')!==output.data||createHash('sha256').update(bytes).digest('hex')!==output.revision)throw Error('File hash mismatch');
  }
  return output;
 };
}
