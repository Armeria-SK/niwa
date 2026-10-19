import { useEffect, useState } from 'react';
import { api } from './api.js';
import { EmptyState, Sentences } from './components.jsx';
import { LockIcon } from './icons.jsx';
import { procedureUse } from './procedure-display.js';
import { t } from './i18n.js';
import { rich } from './i18n-react.js';

/** Botが仕事のあとに保存した「次も使えるやり方」と、Botのファイルから読み込んだ手順。管理者は読むことと、使う・使わないの切り替えだけができる。 */
export function ProcedureBook({ member }) {
  const [state, setState] = useState({ items: null, error: '' });
  const [busy, setBusy] = useState(''); const [version, setVersion] = useState(0);
  useEffect(() => {
    let active = true;
    api(`/agents/${member.id}/procedures`).then(items => { if (active) setState({ items, error: '' }); })
      .catch(error => { if (active) setState({ items: [], error: error.message }); });
    return () => { active = false; };
  }, [member.id, member.memory_version, version]);
  async function toggle(item) {
    setBusy(item.id);
    try { await api(`/agents/${member.id}/procedures/${item.id}`, 'PATCH', { enabled: !item.enabled }); setVersion(value => value + 1); }
    catch (error) { setState(current => ({ ...current, error: error.message })); }
    finally { setBusy(''); }
  }
  if (!state.items) return <p className="muted" role="status">{t('bots.proceduresLoading')}</p>;
  const separator = t('bots.metaSeparator');
  return <div className="procedure-book">
    <p className="field-hint"><Sentences>{t(state.items.some(item => item.imported) ? 'bots.procedureIntroImported' : 'bots.procedureIntro', { name: member.name })}</Sentences></p>
    <p className="field-hint procedure-warning">{rich('bots.procedureWarning', { br: <br /> })}</p>
    {state.error ? <p className="field-error" role="alert">{state.error}</p> : null}
    {state.items.length ? <ul className="procedure-list">{state.items.map(item => <li key={item.id} className={`procedure-item ${item.enabled ? '' : 'disabled'}`}>
      <div className="procedure-top"><strong>{item.title || t('bots.untitledProcedure')}</strong><span>{procedureUse(item)}</span></div>
      {item.conditions ? <p className="procedure-conditions">{t('bots.procedureConditions', { text: item.conditions })}</p> : null}
      {item.steps.length ? <ol>{item.steps.map((step, index) => <li key={index}>{step}</li>)}</ol> : null}
      {item.disabled_reason === 'memory_corrected' ? <p className="procedure-stopped"><Sentences>{t('bots.procedureStoppedByCorrection', { name: member.name })}</Sentences></p> : null}
      <div className="procedure-bottom"><span>{item.room_title ?? t('bots.sourceDeleted')}{item.private ? <>{separator}<LockIcon size={12} />{t('bots.privateConversation')}</> : null}{item.imported ? `${separator}${t('bots.fromFile')}` : ''}{separator}{t('bots.revision', { revision: item.revision })}</span>
        {item.disabled_reason === 'memory_corrected' ? null : <button type="button" className="button subtle" disabled={busy === item.id} onClick={() => toggle(item)}>{item.enabled ? t('bots.disableProcedure') : t('bots.enableProcedure')}</button>}</div>
    </li>)}</ul> : <EmptyState title={t('bots.noProceduresYet')}>{t('bots.noProceduresBody', { name: member.name })}</EmptyState>}
  </div>;
}
