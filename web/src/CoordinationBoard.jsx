import {useEffect,useState} from 'react';
import {api} from './api.js';
import {Modal} from './components.jsx';
import {t,serverText,locale} from './i18n.js';
import {rich} from './i18n-react.js';
import {nameList} from './conversationText.js';
import './CoordinationBoard.css';
const states={queued:'conversation.stateQueued',running:'conversation.stateRunning',waiting_child:'conversation.stateWaitingChild',waiting_user:'conversation.stateWaitingUser',waiting_provider:'conversation.stateWaitingProvider',completed:'conversation.stateCompleted',failed:'conversation.stateFailed',cancelled:'conversation.stateCancelled'};
const stateLabel=state=>states[state]?t(states[state]):'';
const operations={browser_form_submit:'conversation.opFormSubmit',browser_request_submit:'conversation.opRequestSubmit'};
const date=value=>value && value<8_640_000_000_000_000 ? new Date(value).toLocaleString(locale()) : t('conversation.notSet');
export function CoordinationBoard({roomId,members,onClose,onArtifact}) {
 const [data,setData]=useState(null),[error,setError]=useState(''),[showDone,setShowDone]=useState(false),[busy,setBusy]=useState(false),[answers,setAnswers]=useState({});
 async function resume(task) {
  if(busy)return;setBusy(true);setError('');
  try {await api(`/tasks/${task.id}/resume`,'POST',{answer:answers[task.id] || undefined});setData(await api(`/rooms/${roomId}/coordination`));}
  catch(e){setError(e.message);}finally{setBusy(false);}
 }
 useEffect(()=>{
  let active=true,timer;
  const load=async()=>{try{const next=await api(`/rooms/${roomId}/coordination`);if(active){setData(next);setError('');}}catch(e){if(active)setError(e.message);}finally{if(active)timer=setTimeout(load,2000);}};
  void load();return()=>{active=false;clearTimeout(timer);};
 },[roomId]);
 const tasks=data?.tasks || [],byId=new Map(tasks.map(task=>[task.id,task]));
 const name=id=>id==='administrator'?t('conversation.administrator'):members[id]?.name || t('conversation.unassigned');
 const visible=tasks.filter(task=>!task.acknowledgment_only && (showDone || !['completed','cancelled'].includes(task.state)));
 return <Modal drawer title={t('conversation.boardTitle')} onClose={onClose} className="coordination-modal"><div className="modal-body form-stack">
  <p>{rich('conversation.boardIntro',{br:<br />,count:100})}</p>
  {data?.digest ? <section className="coordination-task" aria-label={t('conversation.digestLabel')}><strong>{t('conversation.digestHeading')}</strong>
   <p>{t('conversation.digestCounts',{artifacts:data.digest.artifact_count,approvals:data.digest.approvals,blockers:data.digest.blockers,overdue:data.digest.overdue})}</p>
   {data.digest.artifacts.map(item=><div key={item.id}><button className="text-button" onClick={()=>onArtifact(item.id)}>{t('conversation.artifactVersion',{name:item.name,version:item.version})}</button> · {name(item.author_id)}</div>)}
   <p>{t('conversation.digestNote')}</p>
   {data.digest.operations.length ? data.digest.operations.map(item=><p key={item.tool_name}>{t('conversation.opCounts',{tool:operations[item.tool_name]?t(operations[item.tool_name]):'',recorded:item.recorded,unknown:item.unknown})}</p>) : <p>{t('conversation.noOperations')}</p>}
   <p className="muted">{serverText(data.digest.operation_note)}</p>
  </section> : null}
  <label><input type="checkbox" checked={showDone} onChange={e=>setShowDone(e.target.checked)}/> {t('conversation.showFinished')}</label>
  {error ? <p role="alert">{serverText(error)}</p> : null}{!data && !error ? <p role="status">{t('conversation.loadingShort')}</p> : null}
  {data && !visible.length ? <p>{t('conversation.noRequests')}</p> : null}
  {visible.map(task=>{
   const children=tasks.filter(child=>child.parent_id===task.id && !['completed','cancelled','failed'].includes(child.state));
   return <article className="coordination-task" key={task.id}>
    <div className="coordination-meta"><strong>{name(task.agent_id)}</strong><span>{task.paused?t('conversation.paused'):task.approval_pending?t('conversation.awaitingApproval'):serverText(task.progress?.label)||stateLabel(task.state)}</span></div>
    <p>{task.prompt}</p>
    <dl><dt>{t('conversation.requestedBy')}</dt><dd>{name(task.requester_id)}{task.parent_id ? t('conversation.parentRequest',{prompt:byId.get(task.parent_id)?.prompt || t('conversation.earlierRequest')}) : ''}</dd>
     <dt>{t('conversation.waitingOn')}</dt><dd>{task.waiting_for ? name(task.waiting_for) : children.length ? nameList([...new Set(children.map(child=>name(child.agent_id)))]) : serverText(task.wait_reason) || t('common.none')}</dd>
     <dt>{t('conversation.nextAssignee')}</dt><dd>{name(task.next_agent_id)}</dd><dt>{t('conversation.handoff')}</dt><dd>{task.handoff_child_id ? t('conversation.handoffDelivered') : task.ready_artifact_id ? t('conversation.handoffReady') : t('conversation.handoffNone')}</dd>{task.ready_artifact_id ? <><dt>{t('conversation.fixedVersion')}</dt><dd>{task.ready_artifact_id}<br/>{task.ready_sha256}</dd></> : null}{task.work_acknowledged ? <><dt>{t('conversation.receipt')}</dt><dd>{task.state==='running'?t('conversation.acknowledgedWorking'):t('conversation.acknowledged')}</dd></> : null}
     {task.blocker ? <><dt>{t('conversation.blocker')}</dt><dd>{task.blocker}</dd></> : null}
     <dt>{t('conversation.completionCondition')}</dt><dd>{task.completion_condition || t('conversation.notSet')}</dd><dt>{t('conversation.stopCondition')}</dt><dd>{task.stop_condition || t('conversation.notSet')}</dd>
     <dt>{t('conversation.startDeadline')}</dt><dd>{date(task.started_at)} / {date(task.deadline_at)}</dd>
     {!['completed','failed','cancelled'].includes(task.state) && task.deadline_at<8_640_000_000_000_000 ? <><dt>{t('conversation.timeLeft')}</dt><dd>{task.deadline_at>Date.now()?t('conversation.minutesLeft',{count:Math.ceil((task.deadline_at-Date.now())/60000)}):t('conversation.overdue')}</dd></> : null}<dt>{t('conversation.outputRecord')}</dt><dd>{task.artifact_id ? <button className="text-button" onClick={()=>onArtifact(task.artifact_id)}>{t('conversation.viewLatestOutput',{date:date(task.last_artifact_at)})}</button> : t('conversation.noOutputYet')}</dd>
     <dt>{t('conversation.externalOperations')}</dt><dd>{t('conversation.operationRecords',{count:task.external_operations})}</dd>
    </dl>
    {task.approval_pending ? <p>{t('conversation.approvalElsewhere')}</p> : (task.paused || ['waiting_user','waiting_provider'].includes(task.state)) ? <form className="form-stack" onSubmit={e=>{e.preventDefault();void resume(task);}}><label className="field"><span>{t('conversation.responseField')}</span><textarea rows={2} maxLength={2000} value={answers[task.id] || ''} onChange={e=>setAnswers(current=>({...current,[task.id]:e.target.value}))}/></label><button className="button secondary" disabled={busy}>{t('conversation.respondAndResume')}</button></form> : null}
   </article>;
  })}
 </div></Modal>;
}
