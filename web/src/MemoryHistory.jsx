import { useEffect, useState } from 'react';
import { api } from './api.js';
import { Modal } from './components.jsx';
import { CheckIcon } from './icons.jsx';

export function MemoryHistory({ member, memory, onClose }) {
  const [result, setResult] = useState(null);
  useEffect(() => {
    let active = true; setResult(null);
    api(`/agents/${member.id}/memories/${memory.id}/corrections`).then(items => { if (active) setResult({ items }); })
      .catch(error => { if (active) setResult({ error: error.message }); });
    return () => { active = false; };
  }, [member.id, memory.id, memory.revision]);
  return <Modal title="訂正の履歴" onClose={onClose}><div className="modal-body">
    <p className="muted">現在の記憶は、訂正後の内容です。直近100件の訂正日時と訂正者を表示します。</p>
    {!result ? <p role="status">履歴を読み込んでいます…</p> : result.error ? <p role="alert">{result.error}</p> : <div className="revision-list">{result.items.map(item => <div key={item.sequence}><CheckIcon size={18} /><span>{item.actor_id === 'administrator' ? 'あなた' : '管理者'}が記憶を訂正しました（第{item.revision}版）</span><time dateTime={item.created_at}>{new Date(item.created_at).toLocaleString('ja-JP')}</time></div>)}</div>}
  </div></Modal>;
}
