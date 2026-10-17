import { useEffect, useState } from 'react';
import { api } from './api.js';
import { Sentences } from './components.jsx';
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
    <h2 id="trust-heading"><ShieldIcon size={18} />任せる範囲</h2>
    <p className="field-hint"><Sentences>{`同じBotの同じ種類の操作を、見送らずに${state?.threshold ?? 5}回続けて承認すると、聞かずに進めてよいかを提案します。あなたが押すまで、任せる範囲は広がりません。支払い・購入・契約・外部への公開（フォームの送信やページからの送信を含む）は、何回承認しても提案せず、いつも聞いてから進めます。`}</Sentences></p>
    {error ? <p role="alert">{error}</p> : null}
    {state?.suggestions.length ? <ul className="trust-list">{state.suggestions.map(item => <li key={`${item.agent_id}:${item.kind}`}>
      <p><Sentences>{suggestionText(item)}</Sentences></p>
      <div className="inline-actions"><button type="button" className="button primary" disabled={busy} onClick={() => act('grant', item)}>聞かずに進めてよい</button><button type="button" className="button subtle" disabled={busy} onClick={() => act('dismiss', item)}>今は聞く</button></div>
    </li>)}</ul> : state ? <p className="today-empty">いま出ている提案はありません。</p> : null}
    {state?.grants.length ? <><h3 className="small-heading">いま任せている種類</h3><ul className="trust-list">{state.grants.map(item => <li key={`${item.agent_id}:${item.kind}`}>
      <p><strong>{item.name}</strong>：{kindLabel(item.kind)}<br /><span className="muted">{new Date(item.granted_at).toLocaleDateString('ja-JP')}から・聞かずに進めた回数 {item.automatic}回</span></p>
      <div className="inline-actions"><button type="button" className="button secondary" disabled={busy} onClick={() => act('revoke', item)}>取り消して、また聞くようにする</button></div>
    </li>)}</ul></> : null}
  </section>;
}
