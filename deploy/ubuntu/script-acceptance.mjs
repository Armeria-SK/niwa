import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Runtime} from '../../dist/runtime/runtime.js';
import {FormLog} from '../../dist/tools/browser/form-log.js';
import {submitPublicForm} from '../../dist/tools/browser/form.js';
import {executeAsyncTurnTool} from '../../dist/runtime/turn-tools.js';

// Full runtime approval -> journal -> artificial HTTPS -> real container page continuation.
export async function verifyApprovedScript(session,pending) {
 const root=mkdtempSync(join(tmpdir(),'niwa-script-acceptance-'));
 let runtime=new Runtime(join(root,'state')),sends=0;
 const send=(form,signal)=>submitPublicForm(form,signal,async(url,method,body,_address,_signal,type)=>{
  sends++;assert.equal(url.href,pending.form.url);assert.equal(method,'POST');
  assert.equal(body,pending.form.json);assert.equal(type,'application/json');
  return {url:url.href,status:200,text:'{"message":"Approved SPA result"}',truncated:false,untrusted:true,content_type:'application/json'};
 },async()=> '8.8.8.8');
 let forms=new FormLog(join(root,'forms.db'),send);
 let browser=async input=>input.action.kind==='complete'?session.completeRequest(input.action.input):session.snapshot();
 try {
  let admin=runtime.administrator();const leader=runtime.bootstrap(admin),room=runtime.createRoom(admin,'人工SPA受入');
  runtime.tasks.create(admin,leader.id,room.id,'人工JSON通信');let lease=runtime.tasks.claim(admin);
  const call={name:'browser_request_submit',arguments:pending,tool_call_id:'spa'};
  const execute=()=>executeAsyncTurnTool(runtime,runtime.agentSession(leader.id),lease,call,'0:0',undefined,{forms,browser});
  assert.deepEqual(await execute(),{waiting_for_approval:true});assert.equal(sends,0);
  assert.deepEqual(JSON.parse(String(runtime.approvals(admin)[0].detail)),pending);
  runtime.decideApproval(admin,lease.task.id,true,String(runtime.approvals(admin)[0].version));lease=runtime.tasks.claim(admin);
  const result=await execute();assert.equal(result.status,200);assert.equal(sends,1);
  let page=await session.snapshot();
  for(let i=0;i<10 && !page.text.includes('Approved SPA result');i++) page=await session.snapshot();
  assert.match(page.text,/Approved SPA result/);assert.equal(page.requests,undefined);
  runtime.close();await forms.close();runtime=new Runtime(join(root,'state'));forms=new FormLog(join(root,'forms.db'),send);
  browser=async()=>{throw Error('Expired page after restart');};
  assert.equal((await execute()).status,200);assert.equal(sends,1);
  console.log('PASS: real SPA paused until exact approval, JSON response rendered, reopened journal did not resend');
  return page;
 } finally {await forms.close();runtime.close();rmSync(root,{recursive:true,force:true});}
}
