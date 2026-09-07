import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Avatar, EmptyState, Modal, Segmented } from '../components.jsx';
import { ActivityIcon, ArrowUpRightIcon, CheckCircleIcon, FileIcon, PauseIcon, PlayIcon, ShieldIcon } from '../icons.jsx';
import { Recap, ArtifactLibrary } from './Productivity.jsx';
import { taskStatus } from '../productivity.js';
import { Schedules } from './Schedules.jsx';

const openStatuses = ['running', 'waiting', 'paused', 'failed'];
const eventLabels = { queued: '実行待ち', running: '実行を開始', completed: '完了', failed: '失敗', cancelled: '中止', waiting_child: '仲間の結果を待機', waiting_user: '確認・回答を待機', waiting_provider: '接続・モデルの回復を待機', paused: '一時停止', resumed: '再開', instructed: '追加指示を保存', retried: '再試行' };
export function Activity({ activities, members, paused, onPause, onDecide, onThread, onArtifact, onControl, updates, seen, onRead, artifacts, filter, onFilter, schedules, threads, onScheduleSave, onScheduleToggle, onScheduleDelete }) {
  const [detail, setDetail] = useState(null);
  const [approval, setApproval] = useState(null);
  const running = activities.filter(item => openStatuses.includes(item.status));
  const pending = activities.filter(item => item.status === 'approval');
  const history = activities.filter(item => ![...openStatuses, 'approval'].includes(item.status));
  const visible = filter === 'running' ? running : filter === 'approval' ? pending : history;
  const selected = activities.find(item => item.id === detail);
  const approvalTask = activities.find(item => item.id === approval);
  function openActivity(id) { const task = activities.find(item => item.id === id); if (!task) return; if (task.status === 'approval') setApproval(id); else setDetail(id); }
  return <main className="work-area activity-page" id="main-content" tabIndex={-1}>
    <div className="page-heading"><div><span className="eyebrow">いま、どんなことをしている？</span><h1>活動</h1><p>できたこと、進んでいること、みんなの成果物。</p></div><button className="button secondary" onClick={onPause}>{paused ? <PlayIcon size={17} /> : <PauseIcon size={17} />}{paused ? '活動を再開' : '全体を一時停止'}</button></div>
    {paused ? <div className="inline-notice"><PauseIcon size={18} /><p>Botの活動を一時停止しています。個別に再開した仕事も、全体を再開するまで待機します。</p></div> : null}
    <Segmented label="活動の表示" className="activity-tabs" options={[{ value: 'recap', label: 'できごと', count: updates.filter(item => !seen[item.id]).length }, { value: 'running', label: '仕事', count: running.length }, { value: 'approval', label: '承認待ち', count: pending.length }, { value: 'history', label: '履歴' }, { value: 'artifacts', label: '成果物', count: artifacts.length }, { value: 'schedules', label: '定期実行' }]} value={filter} onChange={onFilter} />
    <div className="activity-scroll" key={filter}>
    {filter === 'recap' ? <Recap updates={updates} seen={seen} onRead={onRead} members={members} onThread={onThread} onArtifact={onArtifact} onActivity={openActivity} /> : filter === 'artifacts' ? <ArtifactLibrary artifacts={artifacts} members={members} onOpen={onArtifact} onThread={onThread} /> : filter === 'schedules' ? <Schedules schedules={schedules} members={members} threads={threads} onSave={onScheduleSave} onToggle={onScheduleToggle} onDelete={onScheduleDelete} onThread={onThread} /> : <>
      {filter === 'approval' ? <p className="approval-explanation"><ShieldIcon size={18} />外部への公開など、あなたの許可が必要な操作です。</p> : null}
      <div className="activity-list">{visible.length ? visible.map(item => <article className={`activity-row status-${item.status}`} key={item.id}>
        <Avatar member={members[item.member]} size={44} /><div className="activity-row-body"><div className="activity-row-meta"><span>{members[item.member]?.name}</span><time>{item.time}</time></div><h2>{item.title}</h2><p>{item.detail}</p>{item.reason ? <p className="task-reason">{item.reason}</p> : null}<div className="activity-row-bottom"><span className={`activity-status ${item.status}`}><span className="status-dot" />{paused && item.status === 'running' ? '全体の再開待ち' : taskStatus[item.status]}</span>{item.thread ? <button className="text-button" onClick={() => onThread(item.thread)}>会話を見る<ArrowUpRightIcon size={15} /></button> : null}</div></div>
        <div className="activity-row-action"><button className={`button ${item.status === 'approval' ? 'primary' : 'secondary'}`} onClick={() => openActivity(item.id)}>{item.status === 'approval' ? '内容を確認' : '詳細・操作'}</button></div>
      </article>) : <EmptyState icon={filter === 'approval' ? CheckCircleIcon : ActivityIcon} title={filter === 'approval' ? '確認が必要なことはありません' : 'まだ活動がありません'}>新しい活動が始まると、ここに表示されます。</EmptyState>}</div>
    </>}
    </div>
    {selected ? <TaskDetail key={selected.id} task={selected} member={members[selected.member]} paused={paused} onClose={() => setDetail(null)} onControl={onControl} onThread={onThread} /> : null}
    {approvalTask ? <Modal title="公開する内容を確認" onClose={() => setApproval(null)}><div className="modal-body form-stack"><div className="activity-detail-owner"><Avatar member={members[approvalTask.member]} size={44} /><span>{members[approvalTask.member]?.name}からの相談</span></div><p>{approvalTask.detail}</p><dl className="approval-facts"><div><dt>公開するファイル</dt><dd><button className="file-link" onClick={() => { setApproval(null); onArtifact('research'); }}><FileIcon size={18} />{approvalTask.filename}</button></dd></div><div><dt>公開先</dt><dd>{approvalTask.target}</dd></div><div><dt>公開範囲</dt><dd>リンクを知っている人</dd></div></dl><p className="field-hint">操作確認用のデモです。実際には公開されません。</p></div><div className="form-actions"><button className="button subtle" onClick={() => { onDecide(approvalTask.id, false); setApproval(null); }}>今回は見送る</button><button className="button primary" onClick={() => { onDecide(approvalTask.id, true); setApproval(null); }}>公開を許可</button></div></Modal> : null}
  </main>;
}

function TaskDetail({ task, member, paused, onClose, onControl, onThread }) {
  const [instruction, setInstruction] = useState('');
  const [history, setHistory] = useState([]); const [historyError, setHistoryError] = useState('');
  useEffect(() => {
    let active = true;
    api(`/tasks/${task.id}/history`).then(items => { if (active) { setHistory(items); setHistoryError(''); } })
      .catch(error => { if (active) setHistoryError(error.message); });
    return () => { active = false; };
  }, [task.id, task.updated_at, task.instructions?.length]);
  const canAct = openStatuses.includes(task.status);
  return <Modal title={task.title} onClose={onClose} className="task-modal"><div className="modal-body form-stack"><div className="activity-detail-owner"><Avatar member={member} size={40} /><span>{member?.name}</span><span role="status">{paused && task.status === 'running' ? '全体の再開待ち' : taskStatus[task.status]}</span></div><p>{task.detail}</p>{task.reason ? <p className="task-reason">{task.reason}</p> : null}<div><h3 className="small-heading">これまでの進み具合</h3><ol className="task-steps">{task.steps.map((step, i) => <li key={`${i}-${step}`}>{step}</li>)}</ol></div>
    {task.instructions?.length ? <div><h3 className="small-heading">追加した指示</h3><ul className="task-instructions">{task.instructions.map(item => <li key={item.id}><time>{item.time}</time><p>{item.text}</p></li>)}</ul></div> : null}
    {canAct ? <form className="form-stack" onSubmit={async e => { e.preventDefault(); if (instruction.trim() && await onControl(task.id, 'instruct', instruction.trim())) setInstruction(''); }}><label className="field"><span>この仕事への追加指示</span><textarea rows={3} maxLength={2000} value={instruction} onChange={e => setInstruction(e.target.value)} placeholder="進め方や、優先してほしいことなど" /></label><button className="button secondary" disabled={!instruction.trim()}>指示を追加</button></form> : null}
    {historyError ? <p role="alert">履歴を取得できませんでした。{historyError}</p> : null}
    {history.length ? <div><h3 className="small-heading">操作の履歴（直近100件）</h3><ul className="task-log">{history.map(item => <li key={item.sequence}><time dateTime={new Date(item.created_at).toISOString()}>{new Date(item.created_at).toLocaleString('ja-JP')}</time> {eventLabels[item.kind] || '状態を更新'}</li>)}</ul></div> : null}
    </div><div className="form-actions task-controls">{task.thread ? <button className="button subtle" onClick={() => { onClose(); onThread(task.thread); }}>関連する会話</button> : null}
    {task.status === 'running' ? <><button className="button secondary" onClick={() => onControl(task.id, 'pause')}>この仕事を一時停止</button><button className="button primary" onClick={() => onControl(task.id, 'complete')}>完了にする</button></> : null}
    {['paused', 'waiting'].includes(task.status) && (task.paused || task.state !== 'waiting_child') ? <button className="button primary" onClick={() => onControl(task.id, 'resume')}>この仕事を再開</button> : null}
    {['failed', 'canceled'].includes(task.status) ? <button className="button primary" onClick={() => onControl(task.id, 'retry')}>再試行</button> : null}
    {canAct ? <button className="button subtle" onClick={() => onControl(task.id, 'cancel')}>この仕事を中止</button> : null}
    </div></Modal>;
}
