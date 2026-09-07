import { useState } from 'react';
import { Modal } from './components.jsx';
import './ContentActions.css';

export function DeleteContentDialog({ item, onClose, onDelete }) {
  const [busy, setBusy] = useState(false);
  return <Modal title={`${item.kind === 'room' ? 'スレッド' : '成果物'}を削除`} onClose={() => { if (!busy) onClose(); }}>
    <div className="modal-body form-stack"><strong>{item.title}</strong><p>{item.kind === 'room' ? 'このスレッドの会話・成果物と、この会話を出所とするBotの記憶を削除します。進行中の仕事と定期実行も停止します。' : 'この成果物を一覧と保存先から削除します。会話の発言は残ります。'}</p><p className="muted">元に戻せません。過去のバックアップは通常の保存期間で整理されます。</p></div>
    <div className="form-actions"><button className="button secondary" disabled={busy} onClick={onClose}>キャンセル</button><button className="button danger" disabled={busy} onClick={async () => { setBusy(true); try { if (await onDelete(item)) onClose(); } finally { setBusy(false); } }}>{busy ? '削除中…' : '削除する'}</button></div>
  </Modal>;
}
