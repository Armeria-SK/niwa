import { useEffect, useState } from 'react';
import { api } from './api.js';
import './WorkNotes.css';

export function WorkNotes({ roomId, members }) {
  const [notes, setNotes] = useState([]);
  const [progress,setProgress]=useState([]);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const [expanded, setExpanded] = useState({});
  useEffect(() => {
    let active = true, timer;
    setNotes([]);setProgress([]);setError('');setExpanded({});
    async function load() {
      try {
        const result = await api(`/rooms/${roomId}/work-notes`);
        if (active) { setNotes(result.notes);setProgress(result.progress??[]); setError(''); }
      } catch (e) { if (active) setError(e.message); }
      finally { if (active) timer = setTimeout(load, 2000); }
    }
    void load();
    return () => { active = false; clearTimeout(timer); };
  }, [roomId]);
  const latestProgress = new Map();
  const priority = p => p.state==='running'?2:['queued','waiting_child','waiting_provider','waiting_user'].includes(p.state)?1:0;
  for(const item of progress) {const old=latestProgress.get(item.agent_id);if(!old||priority(item)>=priority(old))latestProgress.set(item.agent_id,item);}
  const visibleProgress=[...latestProgress.values()].filter(p=>(!filter||p.agent_id===filter)&&!['completed','failed','cancelled'].includes(p.state));
  const groups = new Map();
  for (const note of notes) {
    if (filter && note.agent_id !== filter) continue;
    if (!groups.has(note.task_id)) groups.set(note.task_id, []);
    groups.get(note.task_id).push(note);
  }
  return <section className="work-notes" aria-label="作業メモ">
    <div className="work-notes-heading"><h2>作業メモ</h2>
      <select aria-label="作業メモのメンバー" value={filter} onChange={e => setFilter(e.target.value)}>
        <option value="">全員</option>
        {Object.values(members).filter(m => notes.some(n => n.agent_id === m.id)||progress.some(p=>p.agent_id===m.id)).map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
      </select>
    </div>
    <p className="work-notes-hint">いまの進捗と、作業中の記録</p>
    {error ? <p role="status">更新できません：{error}</p> : null}
    {!groups.size && !visibleProgress.length && !error ? <p className="work-notes-hint">新しい進捗や作業メモはここに表示されます。</p> : null}
    <div className="work-notes-scroll">
      {visibleProgress.map(p=><article className="work-note-group progress-group" key={'progress:'+p.task_id}>
        <details className="progress-details"><summary aria-label="進捗の詳細">
          <span className="progress-person">{members[p.agent_id]?.name||'Bot'}</span>
          <span className="progress-state">{p.label}</span><span className="progress-chevron" aria-hidden="true" />
        </summary>
        <div className="progress-content">
        {p.status==='failed'?<p>直前の操作は失敗しました。</p>:null}
        {p.retry_at?<p>再確認予定：{new Date(p.retry_at).toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit'})}</p>:null}
        {!!p.waiting_for?.length?<p>待っている相手：{p.waiting_for.join('・')}</p>:null}
          <p>{p.last_activity_at?`最終活動 ${new Date(p.last_activity_at).toLocaleTimeString('ja-JP')}`:'活動時刻は未記録'}</p>
          {p.started_at?<p>この段階の経過：{Math.max(0,Math.floor(((p.state==='running'&&p.status==='running'?Date.now():p.last_activity_at??p.started_at)-p.started_at)/1000))}秒</p>:null}
          {p.recent?.map((event,index)=><p key={index}>{new Date(event.created_at).toLocaleTimeString('ja-JP')} · {event.failure?({network:'通信できませんでした',policy_blocked:'通信の許可範囲外です',refused:'取得先に拒否されました',not_found:'資料が見つかりません',invalid_request:'指定内容を確認してください',invalid_response:'取得内容に対応できません',aborted:'中断しました'})[event.failure]||'取得を完了できませんでした':'操作の結果を受け取りました'}</p>)}
          {p.summary?<><p>思考の要約（提供元の公開用要約・未確定）</p><p>{p.summary}</p></>:<p>思考の要約は提供されていません。</p>}
        </div></details>
      </article>)}
      {[...groups].reverse().map(([id, items]) => {
        const last = items.at(-1), replied = !!last.reply_id;
        const open = expanded[id] ?? !replied;
        return <article className="work-note-group" key={id}>
          <button className="work-note-toggle" aria-expanded={open} aria-controls={`notes-${id}`} onClick={() => setExpanded(old => ({ ...old, [id]: !open }))}>
            <span>{members[last.agent_id]?.name || 'Bot'} · {replied ? '返信済み' : ['completed','failed','cancelled'].includes(last.state) ? '作業終了' : '作業メモ'}</span>
            <span>{open ? '閉じる' : `見る（${items.length}）`}</span>
          </button>
          {open ? <ol id={`notes-${id}`} tabIndex={0} aria-label={`${members[last.agent_id]?.name || 'Bot'}の作業メモ`}
            onPointerDown={() => setExpanded(old => ({ ...old, [id]: true }))} onFocus={() => setExpanded(old => ({ ...old, [id]: true }))}>
            {items.map(note => <li key={note.id}><time dateTime={new Date(note.created_at).toISOString()}>{new Date(note.created_at).toLocaleTimeString('ja-JP', { hour:'2-digit', minute:'2-digit' })}</time><p>{note.body}</p></li>)}
          </ol> : null}
        </article>;
      })}
    </div>
    {notes.length === 200 ? <p className="work-notes-hint">直近200件を表示しています。</p> : null}
  </section>;
}
