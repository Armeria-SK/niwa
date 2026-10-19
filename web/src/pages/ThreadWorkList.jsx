import {useEffect,useRef,useState} from 'react';
import {shortWork,workLabel,workCounts} from '../work-display.js';
import {WorkFacts} from '../WorkFacts.jsx';
import {Modal} from '../components.jsx';
import {ChevronRightIcon} from '../icons.jsx';
import './ThreadWorkList.css';
import {t,serverText} from '../i18n.js';
import {nameList} from '../conversationText.js';
const RESULTS={Cancelled:'conversation.resultCancelled','Task deadline exceeded':'conversation.resultDeadline'};
const recent=task=>(RESULTS[task.result]?t(RESULTS[task.result]):task.result||serverText(task.progress?.label)||serverText(task.detail)||'').slice(0,180);
const memberNames=(ids,members)=>nameList(ids.map(id=>members[id]?.name||t('conversation.deletedBot')));
export function ThreadWorkList({groups,members,paused,onOpen,onThread,suspended=false}) {
 const [selected,setSelected]=useState(null);const trigger=useRef(null),position=useRef(0),lastTask=useRef(null),content=useRef(null);
 const group=groups.find(g=>g.id===selected);
 useEffect(()=>{const frame=requestAnimationFrame(()=>{if(selected&&!suspended&&content.current){const dialog=content.current.closest('dialog');const button=[...content.current.querySelectorAll('[data-task]')].find(el=>el.dataset.task===lastTask.current);let node=button;while(node?.closest('details')){const detail=node.closest('details');detail.open=true;node=detail.parentElement;}dialog.scrollTop=position.current;button?.focus({preventScroll:true});}});return()=>cancelAnimationFrame(frame);},[selected,suspended]);
 function close(){setSelected(null);requestAnimationFrame(()=>trigger.current?.focus());}
 function openTask(task){position.current=content.current.closest('dialog').scrollTop;lastTask.current=task.id;onOpen(task.id);}
 const assignment=task=><div className="work-assignment" key={task.id}><div><span className="muted">{members[task.member]?.name||t('conversation.deletedBot')} · {serverText(workLabel(task,paused))}</span><p>{shortWork(task.title)}</p><WorkFacts task={task} compact/><details><summary>{t('conversation.progressAndRequest')}</summary><p>{recent(task)}</p><p>{task.prompt||task.title}</p>{task.reason&&<p>{task.reason}</p>}</details></div><button className="button secondary" data-task={task.id} onClick={()=>openTask(task)}>{t('conversation.detailsAndActions')}</button></div>;
 const purpose=p=><section className="work-purpose" key={p.id}><h3>{shortWork(p.title)}</h3><p className="muted">{workCounts(p.tasks,paused)}</p>{p.active.map(assignment)}{p.history.length>0&&<details className="work-history"><summary>{t('conversation.finishedAssignments',{count:p.history.length})}</summary>{p.history.map(assignment)}</details>}</section>;
 return <><div className="activity-list work-threads">{groups.map(g=><button type="button" className="work-thread" key={g.id} onClick={e=>{trigger.current=e.currentTarget;position.current=0;lastTask.current=null;setSelected(g.id);}}>
  <span className="work-card-heading"><strong>{g.title}</strong><ChevronRightIcon size={20}/></span>
  <span className="work-card-purpose">{g.purposes.slice(0,2).map(p=>shortWork(p.title)).join(t('conversation.purposeSeparator'))}{g.purposes.length>2?t('conversation.morePurposes',{count:g.purposes.length-2}):''}</span>
  <span className="work-card-state">{workCounts(g.purposes.flatMap(p=>p.tasks),paused)}</span>
  <span className="work-card-meta">{t('conversation.purposeCount',{count:g.purposes.length})} · {memberNames(g.members,members)}</span>
 </button>)}</div>
 {selected&&!suspended?<Modal drawer title={group?.title||t('conversation.taskNotFound')} onClose={close} className="thread-work-modal"><div ref={content}>
  {group?<><p className="muted">{t('conversation.purposeCount',{count:group.purposes.length})} · {workCounts(group.purposes.flatMap(p=>p.tasks),paused)}</p><button className="text-button" onClick={()=>{close();onThread(group.id);}}>{t('conversation.viewConversation')}</button>{group.active.map(purpose)}{group.history.length>0&&<details className="work-history"><summary>{t('conversation.finishedTasks',{count:group.history.length})}</summary>{group.history.map(purpose)}</details>}</>:<p>{t('conversation.taskGone')}</p>}
 </div></Modal>:null}</>;
}
