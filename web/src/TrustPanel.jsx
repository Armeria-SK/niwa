import { useEffect, useState } from 'react';
import { api } from './api.js';
import { Sentences } from './components.jsx';
import { locale, t } from './i18n.js';
import { rich } from './i18n-react.js';
import { ShieldIcon } from './icons.jsx';
import { kindLabel, suggestionText } from './trust.js';

/** 承認の実績から出す「任せる範囲」の提案と、いま任せている種類。上げるのも下げるのも、ここで押したときだけ。 */
export function TrustPanel() {
  const [state, setState] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  useEffect(() => { let active = true; api('/trust').then(value => { if (active) setState(value); }).catch(failure => { if (active) setError(failure.message); }); return () => { active = false; }; }, []);
  async function act(action, item) {
    setBusy(true); setError('');
    try { setState(await api(`/trust/${action}`, 'POST', { agent_id: item.agent_id, kind: item.kind })); }
    catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  if (!state && !error) return null;
  return <section className="trust-panel" aria-labelledby="trust-heading">
    <h2 id="trust-heading"><ShieldIcon size={18} />{t('records.trustHeading')}</h2>
    <p className="field-hint"><Sentences>{t('records.trustHint', { count: state?.threshold ?? 5 })}</Sentences></p>
    {error ? <p role="alert">{error}</p> : null}
    {state?.suggestions.length ? <ul className="trust-list">{state.suggestions.map(item => <li key={`${item.agent_id}:${item.kind}`}>
      <p><Sentences>{suggestionText(item)}</Sentences></p>
      <div className="inline-actions"><button type="button" className="button primary" disabled={busy} onClick={() => act('grant', item)}>{t('records.trustGrant')}</button><button type="button" className="button subtle" disabled={busy} onClick={() => act('dismiss', item)}>{t('records.trustDismiss')}</button></div>
    </li>)}</ul> : state ? <p className="today-empty">{t('records.trustNoSuggestions')}</p> : null}
    {state?.grants.length ? <><h3 className="small-heading">{t('records.trustGrantsHeading')}</h3><ul className="trust-list">{state.grants.map(item => <li key={`${item.agent_id}:${item.kind}`}>
      <p>{rich('records.trustGrantKind', { name: <strong>{item.name}</strong>, kind: kindLabel(item.kind) })}<br /><span className="muted">{t('records.trustGrantSince', { date: new Date(item.granted_at).toLocaleDateString(locale()), count: item.automatic })}</span></p>
      <div className="inline-actions"><button type="button" className="button secondary" disabled={busy} onClick={() => act('revoke', item)}>{t('records.trustRevoke')}</button></div>
    </li>)}</ul></> : null}
  </section>;
}
