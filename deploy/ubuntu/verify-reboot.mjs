// Read-only continuity check. Stores IDs/settings only in a root-private receipt.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
assert.equal(process.getuid(),0,'Run with sudo');
assert.ok(['--prepare','--check'].includes(process.argv[2]));
const root='/home/niwa/niwa',file=`${root}/runtime/reboot-acceptance/receipt.json`;
const boot=readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();
const db=new DatabaseSync(`${root}/state/control.db`,{readOnly:true});
assert.equal(db.prepare('PRAGMA quick_check').get().quick_check,'ok');
const tables=['agents','rooms','messages','tasks','schedules'];
const ids=Object.fromEntries(tables.map(table=>[table,db.prepare(`SELECT id FROM ${table}`).all().map(row=>row.id)]));
const settings=db.prepare('SELECT * FROM settings').all();
db.close();
const exec=(command,args)=>execFileSync(command,args,{encoding:'utf8'}).trim();
for(const mount of ['workspace','runtime/executor']) exec('mountpoint',['-q',`${root}/${mount}`]);
for(const unit of ['niwa.service','niwa-workspace.service']) {
 assert.equal(exec('systemctl',['is-active',unit]),'active');
 assert.equal(exec('systemctl',['is-enabled',unit]),'enabled');
}
const env=['-u','niwa-exec','--','env','-i','PATH=/usr/bin:/bin',`HOME=${root}/runtime/executor/home`,'XDG_RUNTIME_DIR=/run/user/1001','DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1001/bus','systemctl','--user'];
assert.equal(exec('runuser',[...env,'is-active','niwa-executor.service']),'active');
assert.equal(exec('runuser',[...env,'is-enabled','niwa-executor.service']),'enabled');
const catalog=JSON.parse(readFileSync(`${root}/runtime/executor/environments/catalog/catalog.json`,'utf8'));
assert.deepEqual(catalog,[],'Production catalog changed; review before acceptance');
const packageDb=new DatabaseSync(`${root}/runtime/executor/state/packages.db`,{readOnly:true});
const environment=packageDb.prepare('SELECT * FROM environment').all();packageDb.close();
if(process.argv[2]==='--prepare') {
 mkdirSync(`${root}/runtime/reboot-acceptance`,{recursive:true,mode:0o700});
 writeFileSync(file,JSON.stringify({boot,ids,settings,environment,prepared_at:new Date().toISOString()})+'\n',{mode:0o600});
 console.log('PASS: reboot baseline saved; services active/enabled, mounts and database valid, production catalog empty');
} else {
 const before=JSON.parse(readFileSync(file,'utf8'));assert.notEqual(boot,before.boot,'WSL/OS has not restarted');
 for(const table of tables) {const current=new Set(ids[table]);assert.ok(before.ids[table].every(id=>current.has(id)),`${table}: IDs changed; review explicit deletions`);}
 assert.deepEqual(settings,before.settings,'Settings changed; review activity state before acceptance');
 assert.deepEqual(environment,before.environment,'Adopted package environment changed');
 execFileSync('runuser',['-u','niwa','--',process.execPath,`${root}/deploy/ubuntu/verify-services.mjs`],{stdio:'inherit'});
 writeFileSync(file,JSON.stringify({...before,checked_boot:boot,checked_at:new Date().toISOString()})+'\n',{mode:0o600});
 console.log('PASS: new OS boot, automatic service startup, saved IDs/settings, adopted image and live IPC');
}
