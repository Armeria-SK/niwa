// Trusted administrator bootstrap: adopt the locally verified production image once.
// Run as the delegated executor, with its service stopped. No downloads or apt rerun.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,renameSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {PackageCatalog} from '../../dist/tools/packages/catalog.js';
import {PackageLog} from '../../dist/tools/packages/log.js';
import {acquireProcessLock} from '../../dist/runtime/process-lock.js';
import {configuredProgramRunner} from '../../dist/sandbox/program.js';

assert.equal(process.argv[2],'--apply');
assert.equal(process.getuid(),1001,'Run as the dedicated executor');
const root='/home/niwa/niwa',state=`${root}/runtime/executor/state`;
const receipt=JSON.parse(readFileSync(`${state}/production-catalog-acceptance.json`,'utf8'));
assert.match(receipt.stage,new RegExp(`^${root}/runtime/executor/home/production-catalog-[a-f0-9-]{36}$`));
for(const check of ['offline-dependencies','committed-versions','nonroot-png-japanese-font','pdf','xlsx-readback']) assert.ok(receipt.checks.includes(check));
const source=new PackageCatalog(`${receipt.stage}/archives`),names=source.list().map(item=>item.name);
assert.ok(names.length && !names.includes('niwa-acceptance'),'Do not adopt artificial packages');
assert.deepEqual(source.select(names),receipt.entries);
const runner=configuredProgramRunner({workspace:`${root}/workspace`,image:receipt.image,uid:process.getuid(),gid:process.getgid(),home:process.env.HOME,runtime:process.env.XDG_RUNTIME_DIR});
const unlock=acquireProcessLock(`${state}/program-lock.db`);
let log;
try {
 const path=`${root}/runtime/executor/environments/catalog`,old=new PackageCatalog(path);
 log=new PackageLog(`${state}/packages.db`,receipt.base,source,async(current,_name,entries)=>{
  assert.equal(current,receipt.base,'An existing adopted image must not be replaced');
  const result=await runner({command:['/usr/bin/dpkg-query','-W','-f=${Package}\t${Version}\t${db:Status-Status}\n',...names],seconds:30});
  assert.equal(result.code,0,result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n').sort(),entries.map(x=>`${x.name}\t${x.version}\tinstalled`).sort());
  return {image:receipt.image,installed:entries.map(({name,version})=>({name,version}))};
 });
 const id=`production-${receipt.image.slice(7)}`;
 if(log.currentImage()===receipt.image) {
  assert.equal(old.revision,source.revision,'Adopted catalog mismatch');
  assert.deepEqual(log.list().installed.map(x=>({...x})),source.select(names).map(({name,version})=>({name,version})));
  console.log('PASS: production catalog and image already adopted');
 } else {
  assert.equal(log.currentImage(),receipt.base);
  assert.deepEqual(log.list().installed,[]);
  assert.deepEqual(log.pending(),[],'Unresolved package operations require review');
  assert.deepEqual(old.list(),[],'Existing production catalog must be preserved');
  const next=`${path}.prepared-${randomUUID()}`;
  const entries=source.stage(names,next); // Rechecks every archive hash before publication.
  for(const [index,entry] of entries.entries()) renameSync(`${next}/${index}.deb`,`${next}/${entry.file}`);
  writeFileSync(`${next}/catalog.json`,readFileSync(`${receipt.stage}/archives/catalog.json`),{flag:'wx',mode:0o600});
  const previous=`${path}.before-production-${randomUUID()}`;
  renameSync(path,previous);
  try {renameSync(next,path);} catch(error) {renameSync(previous,path);throw error;}
  // Publish the catalog first: a crash leaves approved packages visible, never an unverified image.
  const result=await log.execute({operation_id:id,agent_id:'administrator',room_id:'production-bootstrap',task_id:id,allow_start:true,names});
  assert.equal(result.image,receipt.image,'Adoption unresolved; inspect journal before retrying');
  writeFileSync(`${state}/production-catalog-adopted.json`,JSON.stringify({image:receipt.image,catalog_revision:source.revision,count:names.length,previous_catalog:previous,adopted_at:new Date().toISOString()})+'\n',{mode:0o600});
  console.log(`PASS: ${names.length} production packages adopted; original catalog retained`);
 }
} finally {await log?.close();unlock();}
