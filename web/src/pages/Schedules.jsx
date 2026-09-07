import { useRef, useState } from 'react';
import { EmptyState, Modal } from '../components.jsx';
import { ActivityIcon, PlusIcon } from '../icons.jsx';
import './schedules.css';

const formatTime = value => new Date(value).toLocaleString('ja-JP');
const formatInterval = value => { const minutes = value / 60_000; const unit = [[10080, '週間'], [1440, '日'], [60, '時間'], [1, '分']].find(([size]) => minutes % size === 0); return `${minutes / unit[0]}${unit[1]}`; };
const localTime = value => new Date(value - new Date(value).getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
export function Schedules({ schedules, members, threads, onSave, onToggle, onThread }) {
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(null);
  const available = threads.filter(room => !room.archived);
  async function toggle(row) {
    if (busy) return;
    setBusy(row.id);
    try { await onToggle(row.id, !row.enabled); } finally { setBusy(null); }
  }
  return <section>
    <div className="section-toolbar"><div><h2>定期実行</h2><p className="muted">同じ依頼を、決めた間隔で繰り返します。</p></div><button className="button primary" onClick={() => setAdding(true)} disabled={!available.length}><PlusIcon size={17} />予定を追加</button></div>
    <p className="field-hint">前回の仕事が終わるまで次は始まりません。全体停止・休眠・会話のアーカイブ中も待機します。過ぎた予定は1回にまとめます。</p>
    {schedules.length ? <div className="activity-list">{schedules.map(row => {
      const exhausted = row.run_count >= row.max_runs || row.model_calls >= row.max_model_calls;
      const room = threads.find(item => item.id === row.room_id);
      return <article className="activity-row" key={row.id}><div className="activity-row-body">
        <div className="activity-row-meta"><span>{members[row.agent_id]?.name}</span><span>{exhausted ? '上限に到達' : row.enabled ? '有効' : '停止中'}</span></div>
        <h2>{row.prompt}</h2><p>{formatInterval(row.interval_ms)}ごと · 起動 {row.run_count} / {row.max_runs}回 · 1回の期限 {row.timeout_ms / 60_000}分</p>
        <p>モデル呼び出し {row.model_calls} / {row.max_model_calls}回</p>
        {!exhausted ? <p>{row.enabled ? '次回予定' : '再開後の予定'}：<time dateTime={new Date(row.next_at).toISOString()}>{formatTime(row.next_at)}</time></p> : null}
        {row.wait_reason ? <p className="task-reason">{row.wait_reason}</p> : null}
        <button className="text-button" onClick={() => onThread(row.room_id)}>{room?.title || '関連する会話'}を見る</button>
      </div><div className="activity-row-action"><button className="button secondary" disabled={!!busy || exhausted} onClick={() => toggle(row)}>{row.enabled ? '予定を停止' : '予定を再開'}</button></div></article>;
    })}</div> : <EmptyState icon={ActivityIcon} title="定期実行はまだありません">{available.length ? '調査の更新など、繰り返したい仕事の予定を追加できます。' : '先に会話を作成してください。'}</EmptyState>}
    <p className="field-hint">予定の停止は、すでに始まった仕事には影響しません。進行中の仕事は「仕事」から操作できます。予定の内容を変えるときは、停止して新しく作成してください。</p>
    {adding ? <ScheduleForm members={members} threads={available} onSave={onSave} onClose={() => setAdding(false)} /> : null}
  </section>;
}

function ScheduleForm({ members, threads, onSave, onClose }) {
  const [roomId, setRoomId] = useState(threads[0]?.id || '');
  const [agentId, setAgentId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [first, setFirst] = useState(() => localTime(Date.now() + 3600_000));
  const [interval, setInterval] = useState('1');
  const [unit, setUnit] = useState('1440');
  const [runs, setRuns] = useState('30');
  const [timeout, setTimeout] = useState('30');
  const [modelLimit, setModelLimit] = useState('720');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submission = useRef(null);
  const room = threads.find(item => item.id === roomId);
  const eligible = Object.values(members).filter(member => member.status !== 'sleeping' && (room?.scope === 'shared' || room?.members.includes(member.id)));
  const recipient = eligible.some(member => member.id === agentId) ? agentId : eligible[0]?.id || '';
  async function save(event) {
    event.preventDefault(); if (busy) return;
    const next_at = new Date(first).getTime();
    if (!Number.isSafeInteger(next_at) || next_at <= Date.now()) { setError('初回日時を現在より後にしてください。'); return; }
    const body = { agent_id: recipient, room_id: roomId, prompt: prompt.trim(), next_at,
      interval_ms: Number(interval) * Number(unit) * 60_000, max_runs: Number(runs), timeout_ms: Number(timeout) * 60_000,
      max_model_calls: Number(modelLimit) };
    const key = JSON.stringify(body);
    if (submission.current?.key !== key) submission.current = { key, id: crypto.randomUUID() };
    setBusy(true); setError('');
    try { if (await onSave({ ...body, id: submission.current.id })) onClose(); else setError('保存できませんでした。入力内容と接続を確認して再度お試しください。'); }
    finally { setBusy(false); }
  }
  return <Modal title="定期実行を追加" onClose={() => { if (!busy) onClose(); }}><form onSubmit={save}>
    <fieldset className="modal-body form-stack schedule-fields" disabled={busy}>
      <label className="field"><span>会話</span><select aria-label="会話" value={roomId} onChange={e => setRoomId(e.target.value)}>{threads.map(item => <option key={item.id} value={item.id}>{item.title}（{item.scope === 'shared' ? '共有' : '個別'}）</option>)}</select></label>
      <label className="field"><span>担当するBot</span><select aria-label="担当するBot" required value={recipient} onChange={e => setAgentId(e.target.value)}>{!eligible.length ? <option value="">参加できるBotがいません</option> : eligible.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label className="field"><span>繰り返す依頼</span><textarea rows={3} required maxLength={20_000} value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="前回の資料を確認し、新しい情報で更新してください" /></label>
      <label className="field"><span>初回日時</span><input type="datetime-local" required value={first} onChange={e => setFirst(e.target.value)} /></label>
      <p className="field-hint">この端末の時間帯：{Intl.DateTimeFormat().resolvedOptions().timeZone}。間隔は経過時間で計算します。</p>
      <div className="schedule-interval"><label className="field"><span>繰り返す間隔</span><input type="number" min="1" max={Math.floor(525600 / Number(unit))} step="1" required value={interval} onChange={e => setInterval(e.target.value)} /></label><label className="field"><span>単位</span><select aria-label="単位" value={unit} onChange={e => setUnit(e.target.value)}><option value="1">分ごと</option><option value="60">時間ごと</option><option value="1440">日ごと</option><option value="10080">週間ごと</option></select></label></div>
      <div className="schedule-numbers">
      <label className="field"><span>起動回数の上限</span><input type="number" min="1" max="10000" step="1" required value={runs} onChange={e => setRuns(e.target.value)} /></label>
      <label className="field"><span>1回の期限（分）</span><input type="number" min="1" max="1440" step="1" required value={timeout} onChange={e => setTimeout(e.target.value)} /></label></div>
      <label className="field"><span>モデル呼び出しの上限</span><input type="number" min="1" max="1000000" step="1" required value={modelLimit} onChange={e => setModelLimit(e.target.value)} /></label>
      <p className="field-hint">この予定全体の上限です。委任先の仕事や失敗した試行も含み、再開しても回数は戻りません。3回続けて仕事が完了しない場合も予定を停止します。</p>
      {error ? <p className="field-error" role="alert">{error}</p> : null}
    </fieldset><div className="form-actions"><button type="button" className="button subtle" disabled={busy} onClick={onClose}>キャンセル</button><button className="button primary" disabled={busy || !recipient || !prompt.trim()}>{busy ? '保存中…' : '予定を保存'}</button></div>
  </form></Modal>;
}
