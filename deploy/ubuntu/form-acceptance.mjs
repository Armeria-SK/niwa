import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runtime } from '../../dist/runtime/runtime.js';
import { FormLog } from '../../dist/tools/browser/form-log.js';
import { submitPublicForm } from '../../dist/tools/browser/form.js';
import { executeAsyncTurnTool } from '../../dist/runtime/turn-tools.js';

// Real approval/journal/encoding path; DNS and HTTPS are synthetic, with no socket opened.
export async function verifyApprovedForm(form) {
  const root = mkdtempSync(join(tmpdir(), 'niwa-form-acceptance-'));
  let runtime = new Runtime(join(root, 'state')), sends = 0;
  const response = {url:form.url,status:201,text:'Artificial acceptance response',truncated:false,untrusted:true};
  const send = (input, signal) => submitPublicForm(input, signal, async (url, method, body) => {
    sends++; assert.equal(url.href,form.url); assert.equal(method,form.method);
    assert.equal(body,new URLSearchParams(form.fields.map(({name,value})=>[name,value])).toString());
    return response;
  }, async ()=>'8.8.8.8');
  let forms = new FormLog(join(root,'forms.db'),send);
  try {
    let admin=runtime.administrator(); const leader=runtime.bootstrap(admin);
    const room=runtime.createRoom(admin,'人工フォーム受入');
    runtime.tasks.create(admin,leader.id,room.id,'人工応答で承認経路を検証');
    let lease=runtime.tasks.claim(admin);
    const call={name:'browser_form_submit',arguments:form,tool_call_id:'acceptance'};
    const execute=()=>executeAsyncTurnTool(runtime,runtime.agentSession(leader.id),lease,call,'0:0',undefined,{forms,browser:async()=>{throw Error('Unexpected browser read during submission');}});
    assert.deepEqual(await execute(),{waiting_for_approval:true}); assert.equal(sends,0);
    assert.deepEqual(JSON.parse(String(runtime.approvals(admin)[0].detail)),form);
    runtime.close(); await forms.close();
    runtime=new Runtime(join(root,'state')); forms=new FormLog(join(root,'forms.db'),send); admin=runtime.administrator();
    runtime.decideApproval(admin,lease.task.id,true,String(runtime.approvals(admin)[0].version));
    lease=runtime.tasks.claim(admin);
    assert.deepEqual(await execute(),response); assert.equal(sends,1);
    runtime.close(); await forms.close();
    runtime=new Runtime(join(root,'state')); forms=new FormLog(join(root,'forms.db'),send);
    assert.deepEqual(await execute(),response); assert.equal(sends,1);
    console.log('PASS: exact form approval, encoded synthetic submission and durable result after reopening; no external send');
  } finally { await forms.close(); runtime.close(); rmSync(root,{recursive:true,force:true}); }
}
