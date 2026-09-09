import {useEffect,useRef,useState} from 'react';
import {shortWork,workLabel,workCounts} from '../work-display.js';
import {WorkFacts} from '../WorkFacts.jsx';
import {Modal} from '../components.jsx';
import {ChevronRightIcon} from '../icons.jsx';
import './ThreadWorkList.css';
const recent=task=>({Cancelled:'中止しました。','Task deadline exceeded':'期限に達したため終了しました。'}[task.result]||task.result||task.progress?.label||task.detail||'').slice(0,180);
export function ThreadWorkList({groups,members,paused,onOpen,onThread,suspended=false}) {
 const [selected,setSelected]=useState(null);const trigger=useRef(null),position=useRef(0),lastTask=useRef(null),content=useRef(null);
 const group=groups.find(g=>g.id===selected);
 useEffect(()=>{const frame=requestAnimationFrame(()=>{if(selected&&!suspended&&content.current){const dialog=content.current.closest('dialog');const button=[...content.current.querySelectorAll('[data-task]')].find(el=>el.dataset.task===lastTask.current);let node=button;while(node?.closest('details')){const detail=node.closest('details');detail.open=true;node=detail.parentElement;}dialog.scrollTop=position.current;button?.focus({preventScroll:true});}});return()=>cancelAnimationFrame(frame);},[selected,suspended]);
 function close(){setSelected(null);requestAnimationFrame(()=>trigger.current?.focus());}
 function openTask(task){position.current=content.current.closest('dialog').scrollTop;lastTask.current=task.id;onOpen(task.id);}
 const assignment=task=><div className="work-assignment" key={task.id}><div><span className="muted">{members[task.member]?.name||'削除したBot'} · {workLabel(task,paused)}</span><p>{shortWork(task.title)}</p><WorkFacts task={task} compact/><details><summary>進捗・依頼内容</summary><p>{recent(task)}</p><p>{task.prompt||task.title}</p>{task.reason&&<p>{task.reason}</p>}</details></div><button className="button secondary" data-task={task.id} onClick={()=>openTask(task)}>詳細・操作</button></div>;
 const purpose=p=><section className="work-purpose" key={p.id}><h3>{shortWork(p.title)}</h3><p className="muted">{workCounts(p.tasks,paused)}</p>{p.active.map(assignment)}{p.history.length>0&&<details className="work-history"><summary>終了した担当作業（{p.history.length}件）</summary>{p.history.map(assignment)}</details>}</section>;
 return <><div className="activity-list work-threads">{groups.map(g=><button type="button" className="work-thread" key={g.id} onClick={e=>{trigger.current=e.currentTarget;position.current=0;lastTask.current=null;setSelected(g.id);}}>
  <span className="work-card-heading"><strong>{g.title}</strong><ChevronRightIcon size={20}/></span>
  <span className="work-card-purpose">{g.purposes.slice(0,2).map(p=>shortWork(p.title)).join(' ／ ')}{g.purposes.length>2?` ほか${g.purposes.length-2}目的`:''}</span>
  <span className="work-card-state">{workCounts(g.purposes.flatMap(p=>p.tasks),paused)}</span>
  <span className="work-card-meta">{g.purposes.length}目的 · {g.members.map(id=>members[id]?.name||'削除したBot').join('・')}</span>
 </button>)}</div>
 {selected&&!suspended?<Modal title={group?.title||'仕事が見つかりません'} onClose={close} className="thread-work-modal"><div ref={content}>
  {group?<><p className="muted">{group.purposes.length}目的 · {workCounts(group.purposes.flatMap(p=>p.tasks),paused)}</p><button className="text-button" onClick={()=>{close();onThread(group.id);}}>会話を見る</button>{group.active.map(purpose)}{group.history.length>0&&<details className="work-history"><summary>終了した仕事（{group.history.length}目的）</summary>{group.history.map(purpose)}</details>}</>:<p>対象の仕事は削除されたか、表示対象ではなくなりました。</p>}
 </div></Modal>:null}</>;
}
