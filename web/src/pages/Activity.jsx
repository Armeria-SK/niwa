import {WorkFacts} from '../WorkFacts.jsx';
import {shortWork,usageLine,usageSummary,workLabel} from '../work-display.js';
import {artifactGroups} from '../artifact-display.js';
import {groupThreadWork} from '../work-groups.js';
import {ThreadWorkList} from './ThreadWorkList.jsx';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { Avatar, EmptyState, Modal, Segmented } from '../components.jsx';
import { ActivityIcon, ArrowUpRightIcon, CheckCircleIcon, PauseIcon, PlayIcon, ShieldIcon } from '../icons.jsx';
import { Recap, ArtifactLibrary } from './Productivity.jsx';
import { taskStatus } from '../productivity.js';
import { Schedules } from './Schedules.jsx';
import { Watch } from '../Watch.jsx';
import { TrustPanel } from '../TrustPanel.jsx';
import { TaskReplay } from '../TaskReplay.jsx';

const openStatuses = ['running', 'waiting', 'paused', 'failed'];
const eventLabels = { queued: '実行待ち', running: '実行を開始', completed: '完了', failed: '失敗', cancelled: '中止', waiting_child: 'ほかのBotの結果を待機', waiting_user: '確認・回答を待機', waiting_provider: '接続・モデルの回復を待機', paused: '一時停止', resumed: '再開', instructed: '追加指示を保存', retried: '再試行' };
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
    <div className="page-heading"><div><span className="eyebrow">これまでのことと、いま進んでいること。</span><h1>記録</h1><p>決まったこと、進めている仕事、承認が必要なこと、作ったもの。</p></div><button className="button secondary" onClick={onPause}>{paused ? <PlayIcon size={17} /> : <PauseIcon size={17} />}{paused ? '活動を再開' : '全体を一時停止'}</button></div>
    {paused ? <div className="inline-notice"><PauseIcon size={18} /><p>Botの活動を一時停止しています。<br />個別に再開した仕事も、全体を再開するまで待機します。</p></div> : null}
    <Segmented label="記録の表示" className="activity-tabs" options={[{ value: 'recap', label: 'できごと', count: updates.filter(item => !seen[item.id]).length }, { value: 'running', label: '仕事', count: workGroups.length }, { value: 'approval', label: '承認待ち', count: pending.length }, { value: 'artifacts', label: '成果物', count: artifactGroups(artifacts).length }, { value: 'schedules', label: '定期実行' }, { value: 'watch', label: '見張り' }]} value={filter} onChange={onFilter} />
    <div className="activity-scroll" key={filter}>
    {filter === 'recap' ? <Recap updates={updates} seen={seen} onRead={onRead} members={members} onThread={onThread} onArtifact={onArtifact} onActivity={id=>{setFromThread(false);openActivity(id);}} /> : filter === 'artifacts' ? <ArtifactLibrary onDelete={onDeleteArtifact} artifacts={artifacts} members={members} onOpen={onArtifact} onThread={onThread} /> : filter === 'watch' ? <Watch paused={paused} onPause={onPause} /> : filter === 'schedules' ? <Schedules schedules={schedules} members={members} threads={threads} onSave={onScheduleSave} onToggle={onScheduleToggle} onDelete={onScheduleDelete} onToken={onScheduleToken} onThread={onThread} /> : <>
      {filter === 'approval' ? <><p className="approval-explanation"><ShieldIcon size={18} />外部への公開など、あなたの許可が必要な操作です。</p><TrustPanel /></> : null}
      {filter!=='approval'&&workGroups.length?<><p className="muted work-count">{workGroups.length}件の会話 · カードから目的別の仕事と担当作業を確認できます</p><ThreadWorkList groups={workGroups} members={members} paused={paused} suspended={!!selected||!!approvalTask} onOpen={id=>{setFromThread(true);openActivity(id);}} onThread={onThread}/></>:<div className="activity-list">{visible.length ? visible.map(item => <article className={`activity-row status-${item.status}`} key={item.id}>
        <Avatar member={members[item.member]} size={44} /><div className="activity-row-body"><div className="activity-row-meta"><span>{members[item.member]?.name}</span><time>{item.time}</time></div><h2>{item.title}</h2><p>{item.detail}</p>{item.reason ? <p className="task-reason">{item.reason}</p> : null}<div className="activity-row-bottom"><span className={`activity-status ${item.status}`}><span className="status-dot" />{paused && item.status === 'running' ? '全体の再開待ち' : taskStatus[item.status]}</span>{item.thread ? <button className="text-button" onClick={() => onThread(item.thread)}>会話を見る<ArrowUpRightIcon size={15} /></button> : null}</div></div>
        <div className="activity-row-action"><button className={`button ${item.status === 'approval' ? 'primary' : 'secondary'}`} onClick={() => openActivity(item.id)}>{item.status === 'approval' ? '内容を確認' : '詳細・操作'}</button></div>
      </article>) : <EmptyState icon={filter === 'approval' ? CheckCircleIcon : ActivityIcon} title={filter === 'approval' ? '確認が必要なことはありません' : '主な仕事はまだありません'}>Botが進める具体的な仕事が登録されると、ここに表示されます。</EmptyState>}</div>}
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
  if (replay) return <Modal drawer title={`経過を再生 · ${shortWork(task.title)}`} onClose={onClose} className="task-modal"><TaskReplay taskId={task.id} onBack={() => onReplay(task.id, false)} onBranched={onBranched} /></Modal>;
  return <Modal drawer title={shortWork(task.title)} onClose={onClose} className="task-modal"><div className="modal-body form-stack">{onBack?<button className="text-button" onClick={onBack}>会話の仕事へ戻る</button>:null}<div className="activity-detail-owner"><Avatar member={member} size={40} /><span>{member?.name}</span><span role="status">{workLabel(task,paused)}</span></div><WorkFacts task={task}/><details><summary>依頼全文・説明</summary><p>{task.prompt||task.title}</p><p>{task.detail}</p></details><div><h3 className="small-heading">これまでの進み具合</h3><ol className="task-steps">{task.steps.map((step, i) => <li key={`${i}-${step}`}>{step}</li>)}</ol></div>
    {task.instructions?.length ? <div><h3 className="small-heading">追加した指示</h3><ul className="task-instructions">{task.instructions.map(item => <li key={item.id}><time>{item.time}</time><p>{item.text}</p></li>)}</ul></div> : null}
    {canAct ? <form className="form-stack" onSubmit={async e => { e.preventDefault(); if (instruction.trim() && await control('instruct', instruction.trim())) setInstruction(''); }}><label className="field"><span>この仕事への追加指示</span><textarea disabled={busy} rows={3} maxLength={2000} value={instruction} onChange={e => setInstruction(e.target.value)} placeholder="進め方や、優先してほしいことなど" /></label><button className="button secondary" disabled={busy || !instruction.trim()}>指示を追加</button></form> : null}
    {usage?.calls ? <div><h3 className="small-heading">モデルの使用量</h3><p className="task-usage">{usageLine(usage)}</p>{usage.estimated ? <p className="field-hint">うち{usage.estimated}回は接続先から量の報告がなく、入力は送る前の見積もりで数えています。</p> : null}</div> : null}
    <button type="button" className="button secondary" onClick={() => onReplay(task.id, true)}>経過を再生</button>
    {historyError ? <p role="alert">履歴を取得できませんでした。{historyError}</p> : null}
    {history.length ? <div><h3 className="small-heading">操作の履歴（直近100件）</h3><ul className="task-log">{history.map(item => <li key={item.sequence}><time dateTime={new Date(item.created_at).toISOString()}>{new Date(item.created_at).toLocaleString('ja-JP')}</time> {eventLabels[item.kind] || '状態を更新'}</li>)}</ul></div> : null}
    </div><div className="form-actions task-controls">{task.thread ? <button className="button subtle" onClick={() => { onClose(); onThread(task.thread); }}>関連する会話</button> : null}
    {['running', 'waiting'].includes(task.status) ? <button className="button secondary" disabled={busy} onClick={() => control('pause')}>この仕事を一時停止</button> : null}
    {task.status === 'running' ? <button className="button primary" disabled={busy} onClick={() => control('complete')}>完了にする</button> : null}
    {['paused', 'waiting'].includes(task.status) && (task.paused || task.state !== 'waiting_child') ? <button className="button primary" disabled={busy} onClick={() => control('resume')}>この仕事を再開</button> : null}
    {!member?.deleted && ['failed', 'canceled'].includes(task.status) ? <button className="button primary" disabled={busy} onClick={() => control('retry')}>再試行</button> : null}
    {canAct ? <button className="button subtle" disabled={busy} onClick={() => control('cancel')}>この仕事を中止</button> : null}
    </div></Modal>;
}

function ApprovalDialog({ task, member, onClose, onDecide }) {
  const [busy, setBusy] = useState(false); const pending = useRef(false);
  async function decide(approved) { if (pending.current) return; pending.current = true; setBusy(true); try { if (await onDecide(task.id, approved, task.approvalVersion)) onClose(); } finally { pending.current = false; setBusy(false); } }
  return <Modal title="承認する内容を確認" onClose={() => { if (!pending.current) onClose(); }}><div className="modal-body form-stack"><div className="activity-detail-owner"><Avatar member={member} size={44} /><span>{member?.name}からの確認</span></div><h3>{task.title}</h3><p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{task.detail}</p><p className="muted">承認すると、この内容で仕事を再開します。<br />見送ると仕事を中止します。</p></div><div className="form-actions"><button className="button secondary" disabled={busy} onClick={() => decide(false)}>今回は見送る</button><button className="button primary" disabled={busy} onClick={() => decide(true)}>承認して再開</button></div></Modal>;
}
