import { useEffect, useState } from 'react';
import { api } from './api.js';
import './WorkNotes.css';

export function WorkNotes({ roomId, members }) {
  const [notes, setNotes] = useState([]);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const [expanded, setExpanded] = useState({});
  useEffect(() => {
    let active = true, timer;
    async function load() {
      try {
        const result = await api(`/rooms/${roomId}/work-notes`);
        if (active) { setNotes(result.notes); setError(''); }
      } catch (e) { if (active) setError(e.message); }
      finally { if (active) timer = setTimeout(load, 2000); }
    }
    void load();
    return () => { active = false; clearTimeout(timer); };
  }, [roomId]);
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
        {Object.values(members).filter(m => notes.some(n => n.agent_id === m.id)).map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
      </select>
    </div>
    <p className="work-notes-hint">作業中の気付き・進捗。返信は不要です。</p>
    {error ? <p role="status">更新できません：{error}</p> : null}
    {!notes.length && !error ? <p className="work-notes-hint">新しい気付きがあると、ここに届きます。</p> : null}
    <div className="work-notes-scroll">
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
