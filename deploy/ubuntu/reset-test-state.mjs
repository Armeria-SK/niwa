// Offline helper: build fresh application state while retaining installation preferences.
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {Runtime} from '../../dist/runtime/runtime.js';
import {join} from 'node:path';
const [source,destination]=process.argv.slice(2);
assert.ok(source && destination && source!==destination);
const old=new DatabaseSync(join(source,'control.db'),{readOnly:true});
const tables=['settings','model_settings','generated_model','common_rules','provider_limits'];
const rows=tables.map(table=>[table,old.prepare(`SELECT * FROM ${table}`).all()]);
const model=old.prepare("SELECT provider,model,reasoning FROM agents WHERE role='leader'").get();
old.close();
const runtime=new Runtime(destination),admin=runtime.administrator(),leader=runtime.bootstrap(admin);
if(model)runtime.setAgentModel(admin,leader.id,model.provider,model.model,model.reasoning);
runtime.close();
const fresh=new DatabaseSync(join(destination,'control.db'));
try{
 fresh.exec('BEGIN');
 for(const [table,values] of rows){
  fresh.exec(`DELETE FROM ${table}`);
  for(const row of values){const columns=Object.keys(row);fresh.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')})`).run(...Object.values(row));}
 }
 fresh.exec('COMMIT');
 for(const [table,values] of rows)assert.deepEqual(fresh.prepare(`SELECT * FROM ${table}`).all(),values);
 for(const table of ['rooms','messages','tasks','artifacts','schedules'])assert.equal(fresh.prepare(`SELECT count(*) AS n FROM ${table}`).get().n,0);
 assert.equal(fresh.prepare('SELECT count(*) AS n FROM agents').get().n,1);
 assert.equal(fresh.prepare('PRAGMA quick_check').get().quick_check,'ok');
 assert.equal(fresh.prepare('PRAGMA foreign_key_check').all().length,0);
}finally{fresh.close();}
console.log('PASS: fresh leader and empty application state; settings retained');
