import { useEffect, useState } from 'react';
import { api } from './api.js';
import { EmptyState } from './components.jsx';
import { LockIcon } from './icons.jsx';
import { procedureUse } from './procedure-display.js';

/** Botが仕事のあとに保存した「次も使えるやり方」。管理者は読むことと、使う・使わないの切り替えだけができる。 */
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
  if (!state.items) return <p className="muted" role="status">手順帳を読み込んでいます…</p>;
  return <div className="procedure-book">
    <p className="field-hint">{member.name}が仕事を終えたあと、次も使えるやり方として保存した手順です。使う前に、元になった資料が変わっていないかを{member.name}自身が確かめます。</p>
    <p className="field-hint procedure-warning">いまの作りでは、{member.name}の記憶を1件でも直したり消したりすると、この手順帳はすべて消えます。</p>
    {state.error ? <p className="field-error" role="alert">{state.error}</p> : null}
    {state.items.length ? <ul className="procedure-list">{state.items.map(item => <li key={item.id} className={`procedure-item ${item.enabled ? '' : 'disabled'}`}>
      <div className="procedure-top"><strong>{item.title || '題名のない手順'}</strong><span>{procedureUse(item)}</span></div>
      {item.conditions ? <p className="procedure-conditions">使う条件：{item.conditions}</p> : null}
      {item.steps.length ? <ol>{item.steps.map((step, index) => <li key={index}>{step}</li>)}</ol> : null}
      <div className="procedure-bottom"><span>{item.room_title ?? '元の会話は削除されています'}{item.private ? <> ・ <LockIcon size={12} />個別の会話</> : null} ・ 第{item.revision}版</span>
        <button type="button" className="button subtle" disabled={busy === item.id} onClick={() => toggle(item)}>{item.enabled ? '使わないようにする' : 'また使えるようにする'}</button></div>
    </li>)}</ul> : <EmptyState title="まだ手順はありません">仕事を終えた{member.name}が、次も使えるやり方を手順として保存すると、ここに並びます。</EmptyState>}
  </div>;
}
