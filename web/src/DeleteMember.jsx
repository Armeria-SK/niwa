import { useState } from 'react';
import { Modal } from './components.jsx';
import { t } from './i18n.js';
import { rich } from './i18n-react.js';

export function DeleteMember({ member, onClose, onDelete }) {
  const [name, setName] = useState(''); const [busy, setBusy] = useState(false);
  return <Modal title={t('bots.deleteTitle', { name: member.name })} onClose={onClose}><form onSubmit={async event => {
    event.preventDefault(); if (busy || name !== member.name) return;
    setBusy(true);
    try { if (await onDelete(member.id, member.profile_version)) onClose(); }
    finally { setBusy(false); }
  }}><div className="modal-body form-stack"><p>{rich('bots.deleteBody', { br: <br /> })}</p><p>{rich('bots.deleteKeeps', { br: <br /> })}</p><label className="field"><span>{t('bots.deleteConfirmName', { name: member.name })}</span><input value={name} onChange={event => setName(event.target.value)} autoComplete="off" /></label></div><div className="form-actions"><button type="button" className="button subtle" onClick={onClose} disabled={busy}>{t('bots.cancel')}</button><button className="button danger" disabled={busy || name !== member.name}>{busy ? t('bots.deleting') : t('bots.deletePermanently')}</button></div></form></Modal>;
}
