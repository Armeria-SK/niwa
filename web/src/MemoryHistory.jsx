import { useEffect, useState } from 'react';
import { api } from './api.js';
import { Modal } from './components.jsx';
import { CheckIcon } from './icons.jsx';
import { locale, t } from './i18n.js';
import { rich } from './i18n-react.js';

export function MemoryHistory({ member, memory, onClose }) {
  const [result, setResult] = useState(null);
  useEffect(() => {
    let active = true; setResult(null);
    api(`/agents/${member.id}/memories/${memory.id}/corrections`).then(items => { if (active) setResult({ items }); })
      .catch(error => { if (active) setResult({ error: error.message }); });
    return () => { active = false; };
  }, [member.id, memory.id, memory.revision]);
  return <Modal title={t('bots.historyTitle')} onClose={onClose}><div className="modal-body">
    <p className="muted">{rich('bots.historyIntro', { br: <br /> })}</p>
    {!result ? <p role="status">{t('bots.historyLoading')}</p> : result.error ? <p role="alert">{result.error}</p> : <div className="revision-list">{result.items.map(item => <div key={item.sequence}><CheckIcon size={18} /><span>{t(item.actor_id === 'administrator' ? 'bots.historyByYou' : 'bots.historyByAdmin', { revision: item.revision })}</span><time dateTime={item.created_at}>{new Date(item.created_at).toLocaleString(locale())}</time>{item.previous_body ? <blockquote className="revision-previous">{t('bots.previousText', { text: item.previous_body })}</blockquote> : <small className="revision-previous">{t('bots.previousNotKept')}</small>}</div>)}</div>}
  </div></Modal>;
}
