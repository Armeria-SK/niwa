import assert from 'node:assert/strict';
import { get } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeInstallation, adminKey } from '../../dist/config/installation.js';
import { startService } from '../../dist/runtime/service.js';
import { restoreInstallation } from '../../dist/backup/restore.js';

// Separate installation, actual SQLite and HTTP service; never opens production state.
const temp=mkdtempSync(join(tmpdir(),'niwa-persistence-'));
const root=join(temp,'source'), destination=join(temp,'restored');
const paths=initializeInstallation(root,{version:1,origin:'http://127.0.0.1:3210',port:3210});
const resolve=async()=>{throw Error('No model operation expected in persistence acceptance');};
let service;
try {
  service=await startService(root,resolve,0);
  let runtime=service.runtime, admin=runtime.administrator();
  const leader=runtime.agents(admin)[0], room=runtime.createRoom(admin,'人工保存試験');
  const source=runtime.post(admin,room.id,'人工の出所');
  const memory=runtime.remember(runtime.agentSession(leader.id),source.id,'保存する人工記憶');
  runtime.updateSettings(admin,{paused:true});
  const manifest=await service.backups.create();
  runtime.deleteMemory(admin,leader.id,memory.id,memory.revision);
  const key=adminKey(paths);
  await service.close(); service=await startService(root,resolve,0);
  runtime=service.runtime; admin=runtime.administrator();
  assert.equal(runtime.settings(admin).paused,true);
  assert.equal(runtime.messages(admin,room.id)[0].body,'人工の出所');
  assert.equal(runtime.memories(admin,leader.id).length,0);
  assert.equal(adminKey(paths),key);
  await assert.rejects(restoreInstallation(root,manifest.id,destination),/already/);
  await service.close(); service=undefined;
  const restoredPaths=await restoreInstallation(root,manifest.id,destination);
  assert.notEqual(adminKey(restoredPaths),key); assert.equal(adminKey(paths),key);
  service=await startService(destination,resolve,0);
  runtime=service.runtime; admin=runtime.administrator();
  assert.equal(runtime.settings(admin).paused,true);
  assert.equal(runtime.messages(admin,room.id)[0].body,'人工の出所');
  assert.equal(runtime.memories(admin,leader.id).length,0,'Later deletion must survive older backup restoration');
  const address=service.server.address();
  await new Promise((resolve,reject)=>{
    get({hostname:'127.0.0.1',port:address.port,path:'/api/session',headers:{host:'127.0.0.1:3210'},signal:AbortSignal.timeout(5000)},res=>{
      let body=''; res.setEncoding('utf8'); res.on('data',chunk=>body+=chunk); res.on('error',reject);
      res.on('end',()=>{try {assert.equal(res.statusCode,200); assert.deepEqual(JSON.parse(body),{authenticated:false}); resolve();} catch(error){reject(error);}});
    }).on('error',reject);
  });
  console.log('PASS: isolated installation service restart, saved data, backup restore, later deletion, paused recovery and fresh authentication');
} finally { await service?.close(); rmSync(temp,{recursive:true,force:true}); }
