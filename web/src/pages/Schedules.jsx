import { useRef, useState } from 'react';
import { EmptyState, Modal } from '../components.jsx';
import { ActivityIcon, PlusIcon } from '../icons.jsx';
import './schedules.css';

const formatTime = value => new Date(value).toLocaleString('ja-JP');
const formatInterval = value => { const minutes = value / 60_000; const unit = [[10080, '週間'], [1440, '日'], [60, '時間'], [1, '分']].find(([size]) => minutes % size === 0); return `${minutes / unit[0]}${unit[1]}`; };
const localTime = value => new Date(value - new Date(value).getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
const external = trigger => trigger === 'page_changes' || trigger === 'webhook';
export function Schedules({ schedules, members, threads, onSave, onToggle, onDelete, onThread, onToken }) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [busy, setBusy] = useState(null);
  const [issued, setIssued] = useState(null);
  async function issue(row) {
    if (busy) return;
    setBusy(row.id);
    try { const result = await onToken(row.id); if (result) setIssued({ ...result, url: `${window.location.origin}${result.path}` }); } finally { setBusy(null); }
  }
  const available = threads.filter(room => !room.archived);
  async function toggle(row) {
    if (busy) return;
    setBusy(row.id);
    try { await onToggle(row.id, !row.enabled); } finally { setBusy(null); }
  }
  return <section>
    <div className="section-toolbar"><div><h2>定期実行</h2><p className="muted">同じ依頼を、決めた間隔で繰り返します。</p></div><button className="button primary" onClick={() => setAdding(true)} disabled={!available.length}><PlusIcon size={17} />予定を追加</button></div>
    <p className="field-hint">前回の仕事が終わるまで次は始まりません。<br />全体停止・休眠・会話のアーカイブ中も待機します。<br />過ぎた予定は1回にまとめます。</p>
    {schedules.length ? <div className="activity-list">{schedules.map(row => {
      const exhausted = row.run_count >= row.max_runs || row.model_calls >= row.max_model_calls;
      const room = threads.find(item => item.id === row.room_id);
      return <article className="activity-row" key={row.id}><div className="activity-row-body">
        <div className="activity-row-meta"><span>{members[row.agent_id]?.name}</span><span>{exhausted ? '上限に到達' : row.enabled ? '有効' : '停止中'}</span></div>
        <h2>{row.prompt}</h2><p>{row.trigger_kind === 'webhook' ? `最短${formatInterval(row.interval_ms)}おき` : `${formatInterval(row.interval_ms)}ごと`} · 起動 {row.run_count} / {row.max_runs}回 · 1回の期限 {row.timeout_ms / 60_000}分</p>
        {row.trigger_kind === 'shared_changes' ? <p>共有会話に変更があったときだけ起動します。</p> : null}
        {row.trigger_kind === 'page_changes' ? <p>ページの更新を確認：<span className="schedule-url">{row.source_url}</span></p> : null}
        {row.trigger_kind === 'webhook' ? <p>外部から通知が届いたときだけ起動します。{row.hook_ready ? '' : '受付用の鍵がまだありません。'}</p> : null}
        {external(row.trigger_kind) && row.checked_at ? <p className={row.check_failures ? 'task-reason' : ''}>{row.trigger_kind === 'webhook' ? '最後の受信' : '最後の確認'}：<time dateTime={new Date(row.checked_at).toISOString()}>{formatTime(row.checked_at)}</time> · {row.check_status}</p> : null}
        {row.has_pending ? <p>次の仕事に渡す更新があります。</p> : null}
        {row.autonomous ? <p>関心に応じて活動を選び、必要がなければ休息します。</p> : null}
        <p>モデル呼び出し {row.model_calls} / {row.max_model_calls}回</p>
        {!exhausted ? <p>{row.trigger_kind === 'page_changes' ? (row.enabled ? '次の確認' : '再開後の確認') : row.trigger_kind === 'webhook' ? (row.enabled ? '次に起動できる時刻' : '再開後に起動できる時刻') : row.enabled ? '次回予定' : '再開後の予定'}：<time dateTime={new Date(row.next_at).toISOString()}>{formatTime(row.next_at)}</time></p> : null}
        {row.wait_reason ? <p className="task-reason">{row.wait_reason}</p> : null}
        <button className="text-button" onClick={() => onThread(row.room_id)}>{room?.title || '関連する会話'}を見る</button>
      </div><div className="activity-row-action schedule-actions">{row.trigger_kind === 'webhook' ? <button className="button secondary" disabled={!!busy} onClick={() => issue(row)}>{row.hook_ready ? '鍵を発行し直す' : '受付用の鍵を発行'}</button> : null}<button className="button secondary" disabled={!!busy} onClick={() => setEditing(row)}>予定を編集</button><button className="button secondary" disabled={!!busy || exhausted} onClick={() => toggle(row)}>{row.enabled ? '予定を停止' : '予定を再開'}</button><button className="button subtle" disabled={!!busy} onClick={() => setDeleting(row)}>予定を削除</button></div></article>;
    })}</div> : <EmptyState icon={ActivityIcon} title="定期実行はまだありません">{available.length ? '調査の更新など、繰り返したい仕事の予定を追加できます。' : '先に会話を作成してください。'}</EmptyState>}
    <p className="field-hint">予定の停止は、すでに始まった仕事には影響しません。<br />進行中の仕事は「仕事」から操作できます。<br />編集内容は次の仕事から反映されます。<br />実行済み回数は引き継ぎます。</p>
    {deleting ? <Modal title="この予定を削除しますか？" onClose={() => { if (!busy) setDeleting(null); }}><div className="modal-body form-stack"><p>{deleting.prompt}</p><p className="muted">今後の定期実行をやめ、予定一覧から削除します。<br />すでに始まった仕事・会話・過去の履歴は残ります。</p></div><div className="form-actions"><button className="button subtle" disabled={!!busy} onClick={() => setDeleting(null)}>キャンセル</button><button className="button danger" disabled={!!busy} onClick={async () => { if (busy) return; setBusy(deleting.id); try { if (await onDelete(deleting.id)) setDeleting(null); } finally { setBusy(null); } }}>予定を削除</button></div></Modal> : null}
    {issued ? <Modal title="外部からの通知の受付先" onClose={() => setIssued(null)}><div className="modal-body form-stack">
      <p>通知を送る側に、次の宛先と鍵を設定してください。<strong>鍵はこの画面を閉じると再表示できません。</strong>発行し直すと前の鍵は使えなくなります。</p>
      <label className="field"><span>送信先（POST）</span><input readOnly value={issued.url} onFocus={e => e.target.select()} /></label>
      <label className="field"><span>ヘッダー</span><textarea readOnly rows={2} value={`Authorization: Bearer ${issued.token}`} onFocus={e => e.target.select()} /></label>
      <p className="field-hint">鍵は「X-Niwa-Token: 鍵」のヘッダーでも送れます。<br />本文はJSONか文字列で64KiBまでです。<br />1時間に受け付ける件数と起動回数には上限があります。</p>
      <p className="field-hint">Niwaはこの端末の中（127.0.0.1）だけで待ち受けます。<br />外部のサービスから届けるには、Tailscale Funnelやリバースプロキシで、HTTPSのこのパスだけを転送してください。<br />届いた内容は外部の資料として渡し、中の指示には従いません。</p>
    </div><div className="form-actions"><button className="button primary" onClick={() => setIssued(null)}>閉じる</button></div></Modal> : null}
    {editing ? <ScheduleForm key={editing.id} initial={editing} members={members} threads={threads.filter(room => !room.archived || room.id === editing.room_id)} onSave={onSave} onClose={() => setEditing(null)} /> : null}
    {adding ? <ScheduleForm members={members} threads={available} onSave={onSave} onClose={() => setAdding(false)} /> : null}
  </section>;
}

function ScheduleForm({ members, threads, onSave, onClose, initial }) {
  const [roomId, setRoomId] = useState(initial?.room_id || threads[0]?.id || '');
  const [trigger, setTrigger] = useState(initial?.trigger_kind || 'interval');
  const [sourceUrl, setSourceUrl] = useState(initial?.source_url || '');
  const [autonomous, setAutonomous] = useState(!!initial?.autonomous);
  const [agentId, setAgentId] = useState(initial?.agent_id || '');
  const [prompt, setPrompt] = useState(initial?.prompt || '');
  const [first, setFirst] = useState(() => localTime(initial?.next_at ?? Date.now() + 3600_000));
  const [interval, setInterval] = useState(initial ? String(initial.interval_ms / 60_000) : '1');
  const [unit, setUnit] = useState(initial ? '1' : '1440');
  const [runs, setRuns] = useState(String(initial?.max_runs ?? 30));
  const [timeout, setTimeout] = useState(String((initial?.timeout_ms ?? 1800_000) / 60_000));
  const [modelLimit, setModelLimit] = useState(String(initial?.max_model_calls ?? 720));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submission = useRef(null);
  const room = threads.find(item => item.id === roomId);
  const selectableRooms = threads.filter(item => (!autonomous && trigger !== 'shared_changes') || item.scope === 'shared');
  const eligible = Object.values(members).filter(member => (member.status !== 'sleeping' || (initial?.agent_id === member.id && initial.room_id === roomId)) && (room?.scope === 'shared' || room?.members.includes(member.id)));
  const recipient = eligible.some(member => member.id === agentId) ? agentId : eligible[0]?.id || '';
  async function save(event) {
    event.preventDefault(); if (busy) return;
    const unchangedTime = initial && first === localTime(initial.next_at);
    const next_at = unchangedTime ? initial.next_at : new Date(first).getTime();
    if (!Number.isSafeInteger(next_at) || (!unchangedTime && next_at <= Date.now())) { setError('次回日時を現在より後にしてください。'); return; }
    const body = { agent_id: recipient, room_id: roomId, prompt: prompt.trim(), next_at,
      interval_ms: Number(interval) * Number(unit) * 60_000, max_runs: Number(runs), timeout_ms: Number(timeout) * 60_000,
      max_model_calls: Number(modelLimit), trigger_kind: trigger, autonomous, ...(trigger === 'page_changes' ? { source_url: sourceUrl.trim() } : {}) };
    const key = JSON.stringify(body);
    if (submission.current?.key !== key) submission.current = { key, id: crypto.randomUUID() };
    setBusy(true); setError('');
    try { if (await onSave({ ...body, id: initial?.id || submission.current.id, ...(initial ? { version: initial.version } : {}) })) onClose(); else setError('保存できませんでした。入力内容と接続を確認して再度お試しください。'); }
    finally { setBusy(false); }
  }
  return <Modal title={initial ? "定期実行を編集" : "定期実行を追加"} onClose={() => { if (!busy) onClose(); }}><form onSubmit={save}>
    <fieldset className="modal-body form-stack schedule-fields" disabled={busy}>
      <label className="schedule-autonomy"><input type="checkbox" checked={autonomous} onChange={e => { setAutonomous(e.target.checked); if (e.target.checked && room?.scope !== 'shared') setRoomId(threads.find(item => item.scope === 'shared')?.id || ''); }} />関心から活動を選ぶ</label>
      <label className="field"><span>起動する条件</span><select aria-label="起動する条件" value={trigger} onChange={e => { const value = e.target.value; setTrigger(value); if (!initial && value === 'webhook') { setFirst(localTime(Date.now() + 300_000)); setInterval('10'); setUnit('1'); } if (!initial && value === 'page_changes') { setInterval('1'); setUnit('60'); } if (value === 'shared_changes' && room?.scope !== 'shared') setRoomId(threads.find(item => item.scope === 'shared')?.id || ''); }}><option value="interval">決めた間隔で実行</option><option value="shared_changes">共有会話に変更があったら実行</option><option value="page_changes">Webページ・RSSが更新されたら実行</option><option value="webhook">外部から通知が届いたら実行</option></select></label>
      {trigger === 'page_changes' ? <label className="field"><span>確認するページ・RSSのURL</span><input type="url" required maxLength={4096} value={sourceUrl} onChange={e => setSourceUrl(e.target.value)} placeholder="https://example.com/news/feed.xml" /></label> : null}
      <label className="field"><span>会話</span><select aria-label="会話" required value={roomId} onChange={e => setRoomId(e.target.value)}>{!selectableRooms.length ? <option value="">共有会話を作成してください</option> : selectableRooms.map(item => <option key={item.id} value={item.id}>{item.title}（{item.scope === 'shared' ? '共有' : '個別'}）</option>)}</select></label>
      <label className="field"><span>担当するBot</span><select aria-label="担当するBot" required value={recipient} onChange={e => setAgentId(e.target.value)}>{!eligible.length ? <option value="">参加できるBotがいません</option> : eligible.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label className="field"><span>{autonomous ? '活動の方針' : '繰り返す依頼'}</span><textarea rows={3} required maxLength={20_000} value={prompt} onChange={e => setPrompt(e.target.value)} placeholder={autonomous ? '自分の関心を掘り下げ、共有して役立つことがあれば会話や資料に残してください' : '前回の資料を確認し、新しい情報で更新してください'} /></label>
      {autonomous ? <p className="field-hint">共有会話で、担当Botが関心と最近のできごとをもとに活動を選びます。<br />休息を選んだ回も上限に数え、会話や完了通知は増やしません。</p> : null}
      <label className="field"><span>{trigger === 'page_changes' ? (initial ? '次の確認日時' : '最初の確認日時') : trigger === 'webhook' ? '最初に起動できる日時' : initial ? '次回日時' : '初回日時'}</span><input type="datetime-local" required value={first} onChange={e => setFirst(e.target.value)} /></label>
      <p className="field-hint">この端末の時間帯：{Intl.DateTimeFormat().resolvedOptions().timeZone}。間隔は経過時間で計算します。</p>
      {trigger === 'shared_changes' ? <p className="field-hint">この間隔で変更を確認します。<br />登録後に追加・訂正・削除された共有発言が対象です。<br />自分自身の発言や、変化のない会話では起動しません。</p> : null}
      {trigger === 'page_changes' ? <p className="field-hint">この間隔で公開ページを読み、前回から内容が変わったときだけ起動します。<br />最初の確認は内容を記録するだけです。<br />RSS・Atomは新しい記事の題名とリンクを、通常のページは変わった部分の抜粋を渡します。<br />取得に失敗しても起動せず、間隔を空けて確認し直します。</p> : null}
      {trigger === 'webhook' ? <p className="field-hint">保存後、一覧の「受付用の鍵を発行」で送信先と鍵を表示します。<br />仕事中に届いた通知は、まとめて次の仕事に渡します。<br />下の間隔は、次に起動するまで空ける最短の間隔です。</p> : null}
      {external(trigger) ? <p className="field-hint">届いた内容は外部の資料として依頼の後ろに付け、中の指示には従わないようBotに伝えます。</p> : null}
      <div className="schedule-interval"><label className="field"><span>{trigger === 'webhook' ? '起動の最短間隔' : trigger === 'page_changes' ? '確認する間隔' : '繰り返す間隔'}</span><input type="number" min="1" max={Math.floor(525600 / Number(unit))} step="1" required value={interval} onChange={e => setInterval(e.target.value)} /></label><label className="field"><span>単位</span><select aria-label="単位" value={unit} onChange={e => setUnit(e.target.value)}><option value="1">分ごと</option><option value="60">時間ごと</option><option value="1440">日ごと</option><option value="10080">週間ごと</option></select></label></div>
      <div className="schedule-numbers">
      <label className="field"><span>起動回数の上限</span><input type="number" min={Math.max(1, initial?.run_count || 0)} max="10000" step="1" required value={runs} onChange={e => setRuns(e.target.value)} /></label>
      <label className="field"><span>1回の期限（分）</span><input type="number" min="1" max="1440" step="1" required value={timeout} onChange={e => setTimeout(e.target.value)} /></label></div>
      <label className="field"><span>モデル呼び出しの上限</span><input type="number" min={Math.max(1, initial?.model_calls || 0)} max="1000000" step="1" required value={modelLimit} onChange={e => setModelLimit(e.target.value)} /></label>
      <p className="field-hint">この予定全体の上限です。<br />委任先の仕事や失敗した試行も含み、再開しても回数は戻りません。<br />3回続けて仕事が完了しない場合も予定を停止します。</p>
      {error ? <p className="field-error" role="alert">{error}</p> : null}
    </fieldset><div className="form-actions"><button type="button" className="button subtle" disabled={busy} onClick={onClose}>キャンセル</button><button className="button primary" disabled={busy || !recipient || !prompt.trim() || (trigger === 'page_changes' && !sourceUrl.trim())}>{busy ? '保存中…' : '予定を保存'}</button></div>
  </form></Modal>;
}
