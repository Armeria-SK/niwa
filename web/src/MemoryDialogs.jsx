import { useEffect, useState } from 'react';
import { api } from './api.js';
import { Modal } from './components.jsx';
import { LockIcon } from './icons.jsx';

export function MemorySourceLine({ memory, onOpenThread }) {
  const source = memory.source;
  return <div className="memory-source">{source.excerpt ? <q>{source.excerpt}</q> : null}<span>{[source.author, source.room, source.said].filter(Boolean).join(' · ')}</span>
    {source.private ? <span className="memory-private"><LockIcon size={13} />個別の会話から生まれた記憶（その会話の中でだけ使います）</span> : null}
    {source.openable ? <button type="button" className="text-button" onClick={() => onOpenThread(memory.source_room_id)}>元の会話へ</button> : null}</div>;
}

/** 訂正・削除の前に、何が変わるかを読む。読めなくても操作は止めない。 */
function useMemoryImpact(memberId, memoryId) {
  const [impact, setImpact] = useState(null);
  useEffect(() => {
    let active = true; setImpact(null);
    api(`/agents/${memberId}/memories/${memoryId}/impact`).then(result => { if (active) setImpact(result); }).catch(() => { if (active) setImpact({ error: true }); });
    return () => { active = false; };
  }, [memberId, memoryId]);
  return impact;
}

function MemoryImpactNote({ impact, name, deleting }) {
  if (!impact) return <p className="muted" role="status">影響を確かめています…</p>;
  if (impact.error) return null;
  const titles = impact.procedures.map(item => `「${item.title || '題名のない手順'}」`).join('');
  const lines = deleting
    ? [impact.procedure_count ? `${name}の手順帳（${impact.procedure_count}件）もすべて消えます。` : null, '訂正の履歴に残していた前の文も消します。']
    : [impact.procedures.length ? `この記憶を出典にした手順${titles}は止まります。` : 'この記憶を出典にした手順はありません。手順帳はそのまま残ります。'];
  if (impact.open_tasks) lines.push(`進行中の仕事${impact.open_tasks}件は、${deleting ? '残りの記憶' : '直した記憶'}で考え直します。`);
  return <ul className="memory-impact" aria-label="この操作で変わること">{lines.filter(Boolean).map(line => <li key={line}>{line}</li>)}</ul>;
}

export function MemoryEditModal({ memory, member, onSave, onClose }) {
  const [text, setText] = useState(memory.text);
  const [keep, setKeep] = useState(true);
  const impact = useMemoryImpact(member.id, memory.id);
  return <Modal title="記憶を訂正" onClose={onClose}><form onSubmit={e => { e.preventDefault(); if (text.trim()) onSave(text.trim(), keep); }}><div className="modal-body form-stack"><p className="muted">{member.name}の記憶に、あなたによる訂正として記録します。</p><label className="field"><span>記憶の内容</span><textarea rows={6} value={text} onChange={e => setText(e.target.value)} autoFocus required /></label>
    <label className="keep-previous"><input type="checkbox" checked={keep} onChange={e => setKeep(e.target.checked)} /><span>直す前の文を、訂正の履歴に残す<small>私的な内容を消すための訂正なら、外してください。</small></span></label>
    <MemoryImpactNote impact={impact} name={member.name} /></div><div className="form-actions"><button type="button" className="button subtle" onClick={onClose}>やめる</button><button className="button primary" disabled={!text.trim()}>訂正を保存</button></div></form></Modal>;
}

export function MemoryDeleteModal({ memory, member, onDelete, onClose }) {
  const impact = useMemoryImpact(member.id, memory.id);
  return <Modal title="この記憶を削除しますか？" onClose={onClose}><div className="modal-body"><p className="muted">{member.name}の記憶から、この内容を取り除きます。</p><blockquote className="delete-preview">{memory.text}</blockquote><MemoryImpactNote impact={impact} name={member.name} deleting /></div><div className="form-actions"><button className="button subtle" onClick={onClose}>やめる</button><button className="button danger" onClick={onDelete}>記憶を削除</button></div></Modal>;
}
