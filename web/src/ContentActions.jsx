import { useState } from 'react';
import { Modal, Sentences } from './components.jsx';
import { t } from './i18n.js';
import './ContentActions.css';

export function DeleteContentDialog({ item, onClose, onDelete }) {
  const [busy, setBusy] = useState(false);
  const room = item.kind === 'room';
  return <Modal title={room ? t('shell.deleteRoomTitle') : t('shell.deleteArtifactTitle')} onClose={() => { if (!busy) onClose(); }}>
    <div className="modal-body form-stack"><strong>{item.title}</strong><p>{room ? t('shell.deleteRoomBody') : t('shell.deleteArtifactBody')}</p><p className="muted"><Sentences>{t('shell.deleteWarning')}</Sentences></p></div>
    <div className="form-actions"><button className="button secondary" disabled={busy} onClick={onClose}>{t('shell.cancelAction')}</button><button className="button danger" disabled={busy} onClick={async () => { setBusy(true); try { if (await onDelete(item)) onClose(); } finally { setBusy(false); } }}>{busy ? t('shell.deleting') : t('shell.deleteAction')}</button></div>
  </Modal>;
}
