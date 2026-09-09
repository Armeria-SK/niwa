import {createHash} from 'node:crypto';
import {callWorkspace} from '../files/client.ts';
import {verifyExecutorEndpoint} from '../../config/executor-endpoint.ts';
import type {WorkareaTransport} from '../../runtime/workareas.ts';
import type {JsonObject} from '../../contracts/model.ts';
/** This capability is only held by the application composition root. */
export function workareaClient(socket:string,uid:number):WorkareaTransport{
 const verify=verifyExecutorEndpoint(socket,uid);
 return async(input,signal)=>{
  const result=await callWorkspace(socket,verify,input as unknown as JsonObject,signal,12*1024*1024,'/workareas', ['run','environment_prepare','environment_test','environment_run'].includes(input.operation) ? 3_000_000 : 10_000);
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
