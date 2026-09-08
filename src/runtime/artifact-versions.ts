import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {Runtime,Actor} from './runtime.ts';
import {check,text} from '../domain/types.ts';
import {transaction} from '../storage/database.ts';

interface Artifact {id:string;room_id:string;author_id:string;name:string;kind:string;description:string;content:string;created_at:number}
interface Version {series_id:string;version:number;parent_id:string|null;frozen:number}

/** Every revision is a separate immutable artifact; an existing reference never silently changes. */
export class ArtifactVersions {
 constructor(private db:DatabaseSync,private runtime:Runtime,private principal:(actor:Actor)=>{kind:string;id:string}) {}
 inspect(actor:Actor,id:string) {
  const item=this.runtime.artifact(actor,id) as unknown as Artifact,sha256=createHash('sha256').update(String(item.content)).digest('hex');
  const saved=this.db.prepare('SELECT series_id,version,parent_id,frozen FROM artifact_versions WHERE artifact_id=?').get(id) as unknown as Version | undefined;
  const meta=saved ?? {series_id:id,version:1,parent_id:null,frozen:0};
  const versions=this.db.prepare(`SELECT a.id,a.name,a.author_id,a.created_at,v.version,v.frozen FROM artifact_versions v JOIN artifacts a ON a.id=v.artifact_id WHERE v.series_id=? AND a.room_id=? ORDER BY v.version DESC`).all(meta.series_id!,item.room_id!);
  const reviews=this.db.prepare('SELECT reviewer_id,sha256,verdict,note,created_at FROM artifact_reviews WHERE artifact_id=? ORDER BY created_at').all(id);
  const referenced_by=this.db.prepare('SELECT r.task_id,t.agent_id,r.sha256 FROM artifact_references r JOIN tasks t ON t.id=r.task_id WHERE r.artifact_id=? AND t.room_id=?').all(id,item.room_id);
  return {...item,...meta,sha256,versions:versions.length?versions:[{id,name:item.name,author_id:item.author_id,created_at:item.created_at,version:1,frozen:0}],reviews,referenced_by};
 }
 reference(actor:Actor,id:string,taskId:string) {
  const item=this.inspect(actor,id),task=this.runtime.tasks.get(actor,taskId);
  check(task.agent_id===this.principal(actor).id && task.room_id===item.room_id,'forbidden','Reference must belong to the current conversation');
  this.db.prepare('INSERT INTO artifact_references VALUES (?,?,?,?) ON CONFLICT DO NOTHING').run(taskId,id,item.sha256,Date.now());
  return item;
 }
 revise(actor:Actor,id:string,expected:string,content:string,taskId:string) {
  const current=this.inspect(actor,id);text(content,100_000);
  const task=this.runtime.tasks.get(actor,taskId),principal=this.principal(actor);
  check(principal.kind==='agent' && principal.id===task.agent_id,'forbidden','Own task required');
  check(task.agent_id===current.author_id && task.room_id===current.room_id,'forbidden','Only the author can revise this artifact in its conversation');
  check(current.sha256===expected,'conflict','Artifact reference changed');
  check(!current.frozen,'conflict','Frozen artifact cannot be revised');
  return transaction(this.db,()=>{
   this.db.prepare('INSERT INTO artifact_versions VALUES (?,?,?,?,0) ON CONFLICT(artifact_id) DO NOTHING').run(id,current.series_id!,current.version!,current.parent_id!);
   const latest=this.db.prepare('SELECT artifact_id,version FROM artifact_versions WHERE series_id=? ORDER BY version DESC LIMIT 1').get(current.series_id!)!;
   check(latest.artifact_id===id,'conflict','A newer version exists; inspect it first');
   const next=this.runtime.createArtifact(actor,task.room_id,String(current.name),String(current.kind),String(current.description),content,taskId);
   this.db.prepare('INSERT INTO artifact_versions VALUES (?,?,?,?,0)').run(next,current.series_id!,Number(current.version)+1,id);
   return {id:next,version:Number(current.version)+1,sha256:createHash('sha256').update(content).digest('hex')};
  });
 }
 review(actor:Actor,id:string,expected:string,verdict:'approved'|'changes_requested',note:string) {
  const reviewer=this.principal(actor).id;
  const current=this.inspect(actor,id);text(note,1000);
  check(expected===current.sha256,'conflict','Review must name the exact artifact hash');
  check(['approved','changes_requested'].includes(verdict),'invalid','Invalid review verdict');
  check(reviewer!==current.author_id,'forbidden','An author cannot independently approve their own artifact');
  this.db.prepare('INSERT INTO artifact_reviews VALUES (?,?,?,?,?,?) ON CONFLICT(artifact_id,reviewer_id) DO UPDATE SET sha256=excluded.sha256,verdict=excluded.verdict,note=excluded.note,created_at=excluded.created_at')
   .run(id,reviewer,expected,verdict,note,Date.now());
  return {recorded:true};
 }
 freeze(actor:Actor,id:string,expected:string) {
  const current=this.inspect(actor,id),principal=this.principal(actor);
  check(principal.kind==='admin' || principal.id===current.author_id,'forbidden','Only the author or administrator can freeze an artifact');
  check(current.sha256===expected,'conflict','Artifact reference changed');
  check(current.reviews.some(row=>row.verdict==='approved') && !current.reviews.some(row=>row.verdict==='changes_requested'),'conflict','An independent review is required before freezing');
  this.db.prepare('INSERT INTO artifact_versions VALUES (?,?,?,?,1) ON CONFLICT(artifact_id) DO UPDATE SET frozen=1').run(id,current.series_id!,current.version!,current.parent_id!);
  return {frozen:true,sha256:expected};
 }
}
