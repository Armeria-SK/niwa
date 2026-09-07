import { useState } from 'react';
import { Modal } from './components.jsx';

export function DeleteMember({ member, onClose, onDelete }) {
  const [name, setName] = useState(''); const [busy, setBusy] = useState(false);
  return <Modal title={`${member.name}を削除しますか？`} onClose={onClose}><form onSubmit={async event => {
    event.preventDefault(); if (busy || name !== member.name) return;
    setBusy(true);
    try { if (await onDelete(member.id, member.profile_version)) onClose(); }
    finally { setBusy(false); }
  }}><div className="modal-body form-stack"><p>このBotの人格と記憶を削除し、進行中の仕事と定期的な活動を停止します。元に戻すことはできません。</p><p>会話と成果物は「削除したBot」のものとして残ります。過去のバックアップは保存期間中は残りますが、Niwaの復元操作ではこのBotを復活させません。</p><label className="field"><span>確認のため「{member.name}」と入力してください</span><input value={name} onChange={event => setName(event.target.value)} autoComplete="off" /></label></div><div className="form-actions"><button type="button" className="button subtle" onClick={onClose} disabled={busy}>キャンセル</button><button className="button danger" disabled={busy || name !== member.name}>{busy ? '削除中…' : '完全に削除する'}</button></div></form></Modal>;
}
