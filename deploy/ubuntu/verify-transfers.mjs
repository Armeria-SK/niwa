// Artificial binary file and simulated external send; uses live protected workspace/program IPC.
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {readInstallation} from '../../dist/config/installation.js';
import {configuredWorkspaceWriter,configuredWorkspaceDownloader} from '../../dist/tools/files/client.js';
import {configuredProgramExecutor} from '../../dist/sandbox/client.js';
import {readPublicFile} from '../../dist/tools/web/public-page.js';
import {FormLog} from '../../dist/tools/browser/form-log.js';
import {submitPublicForm} from '../../dist/tools/browser/form.js';
assert.deepEqual(process.argv.slice(2),['--apply']);
assert.equal(process.getuid(),1000);
const root='/home/niwa/niwa',config=readInstallation(root),id=randomUUID(),directory=`.transfer-acceptance-${id}`;
const write=configuredWorkspaceWriter(`${root}/runtime/sockets/workspace.sock`,config.workspaceExecutorUid);
const read=configuredWorkspaceDownloader(`${root}/runtime/sockets/workspace.sock`,config.workspaceExecutorUid);
const program=configuredProgramExecutor(`${root}/runtime/sockets/program.sock`,config.programExecutorUid);
const stage=mkdtempSync(`${root}/runtime/transfer-acceptance-`),bytes=Buffer.from([0,255,128,42]);
const file={name:'attachment',path:`${directory}/file.bin`,filename:'file.bin',revision:createHash('sha256').update(bytes).digest('hex'),size:bytes.length};
const input={operation_id:id,path:file.path,content:bytes.toString('base64'),encoding:'base64',expected_revision:null};
let journal,created=false,publicCreated=false,sends=0;
try {
 const saved=await write(input);assert.equal(saved.revision,file.revision);created=true;
 assert.deepEqual(await write(input),saved);
 assert.equal((await read(file.path)).data,bytes.toString('base64'));
 const publicFile=await readPublicFile('https://www.iana.org/help/example-domains');
 const downloaded=await write({operation_id:randomUUID(),path:`${directory}/public.html`,content:publicFile.body_base64,encoding:'base64',expected_revision:null});
 assert.ok(downloaded.revision);publicCreated=true;
 assert.equal((await read(`${directory}/public.html`)).data,publicFile.body_base64);
 const send=async(form,signal)=>submitPublicForm(form,signal,async(_url,_method,body)=>{
   sends++;assert.ok(Buffer.isBuffer(body));assert.ok(body.includes(bytes));
   return {url:form.url,status:200,text:'synthetic upload received',truncated:false,untrusted:true};
 },async()=> '8.8.8.8',async(path,signal)=>read(path,signal));
 journal=new FormLog(`${stage}/forms.db`,send);
 const operation={operation_id:id,agent_id:'fixture',room_id:'fixture',task_id:'fixture',allow_start:true,form:{url:'https://forms.example.com/upload',method:'POST',fields:[],files:[file]}};
 const result=await journal.execute(operation);assert.equal(result.status,200);assert.equal(sends,1);
 await journal.close();journal=new FormLog(`${stage}/forms.db`,send);
 assert.deepEqual(await journal.execute({...operation,allow_start:false}),result);assert.equal(sends,1);
 await write({...input,operation_id:randomUUID(),expected_revision:file.revision,content:Buffer.from('changed').toString('base64')});
 assert.equal((await journal.execute({...operation,operation_id:randomUUID()})).error,'outcome_unknown');assert.equal(sends,1);
 writeFileSync(`${root}/runtime/transfer-acceptance.json`,JSON.stringify({verified_at:new Date().toISOString(),checks:['public-https-download-to-workspace','live-binary-ipc','bytes-and-revision','write-replay','multipart-synthetic-send','journal-reopen-no-resend','changed-file-no-send'],external_send:false})+'\n',{mode:0o600});
 console.log('PASS: live binary IPC, synthetic multipart upload, reopened journal and changed-file rejection; no external send');
} finally {
 await journal?.close();
 if(created){const result=await program({operation_id:randomUUID(),agent_id:'fixture',room_id:'fixture',task_id:'fixture',allow_start:true,seconds:10,command:['python3','-c',`from pathlib import Path\np=Path(${JSON.stringify(directory)})\n(p/'file.bin').unlink()\n${publicCreated ? "(p/'public.html').unlink()\n" : ''}p.rmdir()`]});assert.equal(result.code,0,'Fixture cleanup failed');}
 rmSync(stage,{recursive:true,force:true});
}
