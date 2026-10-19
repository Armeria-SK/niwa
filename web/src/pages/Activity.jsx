import {WorkFacts} from '../WorkFacts.jsx';
import {shortWork,usageLine,usageSummary,workLabel} from '../work-display.js';
import {artifactGroups} from '../artifact-display.js';
import {groupThreadWork} from '../work-groups.js';
import {ThreadWorkList} from './ThreadWorkList.jsx';
import { Fragment, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { locale, serverText, t, hourStyle } from '../i18n.js';
import { Avatar, EmptyState, Modal, Segmented } from '../components.jsx';
import { ActivityIcon, ArrowUpRightIcon, CheckCircleIcon, PauseIcon, PlayIcon, ShieldIcon } from '../icons.jsx';
import { Recap, ArtifactLibrary } from './Productivity.jsx';
import { taskStatus } from '../productivity.js';
import { Schedules } from './Schedules.jsx';
import { Watch } from '../Watch.jsx';
import { TrustPanel } from '../TrustPanel.jsx';
import { TaskReplay } from '../TaskReplay.jsx';

const openStatuses = ['running', 'waiting', 'paused', 'failed'];
// 操作の履歴に出す状態の変化（辞書の文言の名前）。
const eventLabels = { queued: 'eventQueued', running: 'eventRunning', completed: 'eventCompleted', failed: 'eventFailed', cancelled: 'eventCancelled', waiting_child: 'eventWaitingChild', waiting_user: 'eventWaitingUser', waiting_provider: 'eventWaitingProvider', paused: 'eventPaused', resumed: 'eventResumed', instructed: 'eventInstructed', retried: 'eventRetried' };
/** 辞書の文の改行（\n）を <br /> にして並べる。 */
const lines = text => text.split('\n').map((line, index) => <Fragment key={index}>{index ? <br /> : null}{line}</Fragment>);
// 時刻は描くときに今の言語で書く（言語を切り替えたらすぐ変わるように）。
const clock = value => new Date(value).toLocaleTimeString(locale(), { hour: hourStyle(), minute: '2-digit' });
// 待っている理由と仕事の結果はサーバーが書いた文のことがあるので、今の言語に言い換えて出す（辞書に無い文はそのまま）。承認や業務の説明はそのまま。
const shownDetail = task => task.detail && (task.detail === task.wait_reason || task.detail === task.result) ? serverText(task.detail) : task.detail;
export function Activity({ taskId, replay = false, onReplay, onBranched, onOpenTask, onCloseTask, onDeleteArtifact, activities, members, paused, onPause, onDecide, onThread, onArtifact, onControl, updates, seen, onRead, artifacts, filter, onFilter, schedules, threads, onScheduleSave, onScheduleToggle, onScheduleDelete, onScheduleToken }) {
  const [fromThread,setFromThread]=useState(false);
  const running = activities.filter(item => item.business && item.status !== 'approval');
  const workGroups=groupThreadWork(activities,threads);
  const pending = activities.filter(item => item.status === 'approval');
  const visible = filter === 'approval' ? pending : running;
  // 開いている仕事はURL（#records/task/ID）で決まる。承認待ちなら確認の窓、それ以外は脇の欄で詳しく見せる。
  const opened = activities.find(item => item.id === taskId);
  const selected = opened?.status === 'approval' ? null : opened;
  const approvalTask = opened?.status === 'approval' ? opened : null;
  useEffect(()=>{if(taskId&&!opened)onCloseTask();},[taskId,opened,onCloseTask]);
  function openActivity(id) { if (activities.some(item => item.id === id)) onOpenTask(id); }
  return <main className="work-area activity-page" id="main-content" tabIndex={-1}>
    <div className="page-heading"><div><span className="eyebrow">{t('records.eyebrow')}</span><h1>{t('records.title')}</h1><p>{t('records.lead')}</p></div></div>
    {paused ? <div className="inline-notice"><PauseIcon size={18} /><p>{lines(t('records.pausedNotice'))}</p><button className="button secondary" onClick={onPause}><PlayIcon size={17} />{t('records.resumeAll')}</button></div> : null}
    <Segmented underline label={t('records.tabsLabel')} className="activity-tabs" options={[{ value: 'recap', label: t('records.tabRecap'), count: updates.filter(item => !seen[item.id]).length }, { value: 'running', label: t('records.tabWork'), count: workGroups.length }, { value: 'approval', label: t('records.tabApproval'), count: pending.length }, { value: 'artifacts', label: t('records.tabArtifacts'), count: artifactGroups(artifacts).length }, { value: 'schedules', label: t('records.tabSchedules') }, { value: 'watch', label: t('records.tabWatch') }]} value={filter} onChange={onFilter} />
    <div className="activity-scroll" key={filter}>
    {filter === 'recap' ? <Recap updates={updates} seen={seen} onRead={onRead} members={members} onThread={onThread} onArtifact={onArtifact} onActivity={id=>{setFromThread(false);openActivity(id);}} /> : filter === 'artifacts' ? <ArtifactLibrary onDelete={onDeleteArtifact} artifacts={artifacts} members={members} onOpen={onArtifact} onThread={onThread} /> : filter === 'watch' ? <Watch paused={paused} /> : filter === 'schedules' ? <Schedules schedules={schedules} members={members} threads={threads} onSave={onScheduleSave} onToggle={onScheduleToggle} onDelete={onScheduleDelete} onToken={onScheduleToken} onThread={onThread} /> : <>
      {filter === 'approval' ? <><p className="approval-explanation"><ShieldIcon size={18} />{t('records.approvalExplanation')}</p><TrustPanel /></> : null}
      {filter!=='approval'&&workGroups.length?<><p className="muted work-count">{t('records.workCount', { count: workGroups.length })}</p><ThreadWorkList groups={workGroups} members={members} paused={paused} suspended={!!selected||!!approvalTask} onOpen={id=>{setFromThread(true);openActivity(id);}} onThread={onThread}/></>:<div className="activity-list">{visible.length ? visible.map(item => <article className={`activity-row status-${item.status}`} key={item.id}>
        <Avatar member={members[item.member]} size={44} /><div className="activity-row-body"><div className="activity-row-meta"><span>{members[item.member]?.name}</span><time>{item.updated_at ? clock(item.updated_at) : item.time}</time></div><h2>{item.title}</h2><p>{shownDetail(item)}</p>{item.reason ? <p className="task-reason">{serverText(item.reason)}</p> : null}<div className="activity-row-bottom"><span className={`activity-status ${item.status}`}><span className="status-dot" />{paused && item.status === 'running' ? t('records.waitingForResumeAll') : taskStatus[item.status]}</span>{item.thread ? <button className="text-button" onClick={() => onThread(item.thread)}>{t('records.viewThread')}<ArrowUpRightIcon size={15} /></button> : null}</div></div>
        <div className="activity-row-action"><button className={`button ${item.status === 'approval' ? 'primary' : 'secondary'}`} onClick={() => openActivity(item.id)}>{item.status === 'approval' ? t('records.reviewApproval') : t('records.detailsAndControls')}</button></div>
      </article>) : <EmptyState icon={filter === 'approval' ? CheckCircleIcon : ActivityIcon} title={filter === 'approval' ? t('records.emptyApprovalTitle') : t('records.emptyWorkTitle')}>{t('records.emptyWorkBody')}</EmptyState>}</div>}
    </>}
    </div>
    {selected ? <TaskDetail key={selected.id} replay={replay} onReplay={onReplay} onBranched={onBranched} onBack={fromThread?onCloseTask:undefined} task={selected} member={members[selected.member]} paused={paused} onClose={onCloseTask} onControl={onControl} onThread={onThread} /> : null}
    {approvalTask ? <ApprovalDialog task={approvalTask} member={members[approvalTask.member]} onClose={onCloseTask} onDecide={onDecide} /> : null}
  </main>;
}

function TaskDetail({ task, member, paused, onClose, onControl, onThread, onBack, replay = false, onReplay, onBranched }) {
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false); const pending = useRef(false);
  async function control(action, body) {
    if (pending.current) return false;
    pending.current = true; setBusy(true);
    try { return await onControl(task.id, action, body); }
    finally { pending.current = false; setBusy(false); }
  }
  const [history, setHistory] = useState([]); const [historyError, setHistoryError] = useState(''); const [usage, setUsage] = useState(null);
  useEffect(() => {
    let active = true;
    api(`/tasks/${task.id}/history`).then(items => { if (active) { setHistory(items); setHistoryError(''); } })
      .catch(error => { if (active) setHistoryError(error.message); });
    return () => { active = false; };
  }, [task.id, task.updated_at, task.instructions?.length]);
  useEffect(() => {
    let active = true; setUsage(null);
    api(`/tasks/${task.id}/prompt-runs`).then(runs => { if (active) setUsage(usageSummary(runs)); }).catch(() => {});
    return () => { active = false; };
  }, [task.id, task.state]);
  const canAct = !member?.deleted && openStatuses.includes(task.status);
  // 経過の再生は同じ脇の欄の中で切り替える（重ね窓を増やさない）。URLは #records/task/ID/replay。
  if (replay) return <Modal drawer title={t('records.replayTitle', { title: shortWork(task.title) })} onClose={onClose} className="task-modal"><TaskReplay taskId={task.id} onBack={() => onReplay(task.id, false)} onBranched={onBranched} /></Modal>;
  return <Modal drawer title={shortWork(task.title)} onClose={onClose} className="task-modal"><div className="modal-body form-stack">{onBack?<button className="text-button" onClick={onBack}>{t('records.backToThreadWork')}</button>:null}<div className="activity-detail-owner"><Avatar member={member} size={40} /><span>{member?.name}</span><span role="status">{workLabel(task,paused)}</span></div><WorkFacts task={task}/><details><summary>{t('records.fullRequest')}</summary><p>{task.prompt||task.title}</p><p>{shownDetail(task)}</p></details><div><h3 className="small-heading">{t('records.progressSoFar')}</h3><ol className="task-steps">{task.steps.map((step, i) => <li key={`${i}-${step}`}>{serverText(step)}</li>)}</ol></div>
    {task.instructions?.length ? <div><h3 className="small-heading">{t('records.addedInstructions')}</h3><ul className="task-instructions">{task.instructions.map(item => <li key={item.id}><time>{task.replies?.[item.id]?.created_at ? clock(task.replies[item.id].created_at) : item.time}</time><p>{item.text}</p></li>)}</ul></div> : null}
    {canAct ? <form className="form-stack" onSubmit={async e => { e.preventDefault(); if (instruction.trim() && await control('instruct', instruction.trim())) setInstruction(''); }}><label className="field"><span>{t('records.instructionLabel')}</span><textarea disabled={busy} rows={3} maxLength={2000} value={instruction} onChange={e => setInstruction(e.target.value)} placeholder={t('records.instructionPlaceholder')} /></label><button className="button secondary" disabled={busy || !instruction.trim()}>{t('records.addInstruction')}</button></form> : null}
    {usage?.calls ? <div><h3 className="small-heading">{t('records.modelUsage')}</h3><p className="task-usage">{usageLine(usage)}</p>{usage.estimated ? <p className="field-hint">{t('records.usageEstimated', { count: usage.estimated })}</p> : null}</div> : null}
    <button type="button" className="button secondary" onClick={() => onReplay(task.id, true)}>{t('records.replay')}</button>
    {historyError ? <p role="alert">{t('records.historyFailed', { error: historyError })}</p> : null}
    {history.length ? <div><h3 className="small-heading">{t('records.historyHeading')}</h3><ul className="task-log">{history.map(item => <li key={item.sequence}><time dateTime={new Date(item.created_at).toISOString()}>{new Date(item.created_at).toLocaleString(locale())}</time> {t(`records.${Object.hasOwn(eventLabels, item.kind) ? eventLabels[item.kind] : 'historyUpdated'}`)}</li>)}</ul></div> : null}
    </div><div className="form-actions task-controls">{task.thread ? <button className="button subtle" onClick={() => { onClose(); onThread(task.thread); }}>{t('records.relatedThread')}</button> : null}
    {['running', 'waiting'].includes(task.status) ? <button className="button secondary" disabled={busy} onClick={() => control('pause')}>{t('records.pauseTask')}</button> : null}
    {task.status === 'running' ? <button className="button primary" disabled={busy} onClick={() => control('complete')}>{t('records.completeTask')}</button> : null}
    {['paused', 'waiting'].includes(task.status) && (task.paused || task.state !== 'waiting_child') ? <button className="button primary" disabled={busy} onClick={() => control('resume')}>{t('records.resumeTask')}</button> : null}
    {!member?.deleted && ['failed', 'canceled'].includes(task.status) ? <button className="button primary" disabled={busy} onClick={() => control('retry')}>{t('common.retry')}</button> : null}
    {canAct ? <button className="button subtle" disabled={busy} onClick={() => control('cancel')}>{t('records.cancelTask')}</button> : null}
    </div></Modal>;
}

function ApprovalDialog({ task, member, onClose, onDecide }) {
  const [busy, setBusy] = useState(false); const pending = useRef(false);
  async function decide(approved) { if (pending.current) return; pending.current = true; setBusy(true); try { if (await onDecide(task.id, approved, task.approvalVersion)) onClose(); } finally { pending.current = false; setBusy(false); } }
  return <Modal title={t('records.approvalTitle')} onClose={() => { if (!pending.current) onClose(); }}><div className="modal-body form-stack"><div className="activity-detail-owner"><Avatar member={member} size={44} /><span>{t('records.approvalFrom', { name: member?.name })}</span></div><h3>{task.title}</h3><p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{task.detail}</p><p className="muted">{lines(t('records.approvalNote'))}</p></div><div className="form-actions"><button className="button secondary" disabled={busy} onClick={() => decide(false)}>{t('records.decline')}</button><button className="button primary" disabled={busy} onClick={() => decide(true)}>{t('records.approve')}</button></div></Modal>;
}
