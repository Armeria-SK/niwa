import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {pendingRequest} from '../src/tools/browser/pending-request.ts';
import {submitPublicForm} from '../src/tools/browser/form.ts';
import {FormLog} from '../src/tools/browser/form-log.ts';
import {Runtime} from '../src/runtime/runtime.ts';
import {executeAsyncTurnTool,turnTools} from '../src/runtime/turn-tools.ts';
import type {BrowserExecutor} from '../src/tools/browser/client.ts';

const url='https://fixture.example.com/api';
const request={url,method:'POST',headers:{'Content-Type':'application/json'},postData:'{ "value":42 }'};
const form=pendingRequest(url,request,'Fetch');
test('script request normalization refuses credentials, cross-origin destinations and unsupported bodies',async()=>{
  for(const changed of [{url:'https://other.example.com/api'},{method:'DELETE'},{headers:{Authorization:'synthetic'}},{headers:{Cookie:'synthetic'}},{headers:{'X-Token':'synthetic'}},{postData:'invalid json'}]) assert.throws(()=>pendingRequest(url,{...request,...changed},'Fetch'));
  assert.throws(()=>pendingRequest(url,request,'Image'));
  let calls=0;
  await submitPublicForm(form,undefined,async(destination,method,body,_address,_signal,type)=>{
    calls++;assert.equal(destination.href,url);assert.equal(method,'POST');assert.equal(type,'application/json');assert.equal(body,request.postData);
    return {url,status:200,text:'{}',untrusted:true,truncated:false,content_type:'application/json'};
  },async()=> '8.8.8.8');assert.equal(calls,1);
});

test('script approval binds the captured content and journals one send across repeated model call IDs',async()=>{
  const root=mkdtempSync(join(tmpdir(),'niwa-script-')),runtime=new Runtime(join(root,'state'));
  let sends=0,completions=0;
  const response={url,status:200,text:'{"saved":true}',untrusted:true as const,truncated:false,content_type:'application/json'};
  const forms=new FormLog(join(root,'forms.db'),async()=>{sends++;return response;});
  const request_id=randomUUID();let observed=form;
  const browser:BrowserExecutor=async input=>{
    if(input.action.kind==='complete'){completions++;assert.deepEqual(input.action.input.form,form);}
    return {url,title:'SPA',revision:'one',text:'Waiting',elements:[],blocked:[],untrusted:true,requests:[{request_id,form:observed}]};
  };
  const external={forms,browser};
  try {
    const admin=runtime.administrator(),leader=runtime.bootstrap(admin),actor=runtime.agentSession(leader.id),room=runtime.createRoom(admin,'SPA');
    runtime.tasks.create(admin,leader.id,room.id,'Synthetic request');let lease=runtime.tasks.claim(admin)!;
    const call={name:'browser_request_submit',tool_call_id:'api',arguments:{request_id,form}};
    for(const operation of ['0:0','1:0']) {
      assert.deepEqual(await executeAsyncTurnTool(runtime,actor,lease,call,operation,undefined,external),{waiting_for_approval:true});
      assert.equal(sends,operation==='0:0'?0:1);
      const approval=runtime.approvals(admin)[0]!;assert.deepEqual(JSON.parse(String(approval.detail)),call.arguments);
      runtime.decideApproval(admin,lease.task.id,true,String(approval.version));lease=runtime.tasks.claim(admin)!;
      assert.equal((await executeAsyncTurnTool(runtime,actor,lease,call,operation,undefined,external)).status,200);
      assert.equal(sends,1);
    }
    assert.equal(completions,2);
    assert.deepEqual(await executeAsyncTurnTool(runtime,actor,lease,call,'2:0',undefined,external),{waiting_for_approval:true});
    const approval=runtime.approvals(admin)[0]!;runtime.decideApproval(admin,lease.task.id,true,String(approval.version));lease=runtime.tasks.claim(admin)!;
    observed={...form,json:'{"value":43}'};
    assert.deepEqual(await executeAsyncTurnTool(runtime,actor,lease,call,'2:0',undefined,external),{error:'Pending request changed or expired'});assert.equal(sends,1);
    assert.ok(!turnTools(true,{browser},true).some(tool=>tool.name==='browser_request_submit'));
  } finally {await forms.close();runtime.close();rmSync(root,{recursive:true,force:true});}
});
