import { useEffect, useState } from 'react';
import { api } from './api.js';
import { ModelPicker } from './ModelPicker.jsx';

const selection = value => ({ provider: value.provider, model: value.model, reasoning: value.reasoning });
function ModelChoice({ initial, endpoint, title, hint }) {
  const [saved, setSaved] = useState(() => selection(initial));
  const [draft, setDraft] = useState(() => selection(initial));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const same = draft.provider === saved.provider && draft.model === saved.model && draft.reasoning === saved.reasoning;
  async function save() {
    setBusy(true); setError(''); setMessage('');
    try { const next = selection(await api(endpoint, 'PUT', draft)); setSaved(next); setDraft(next); setMessage('保存しました。'); }
    catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  return <div className="model-choice">
    <ModelPicker label={title} value={draft} keep={[saved]} disabled={busy} onChange={next => { setDraft(next); setMessage(''); }} />
    <p className="field-hint">{hint}</p>
    <div className="inline-actions"><button type="button" className="button primary" disabled={busy || same} onClick={save}>{busy ? '接続先を確認しています…' : `${title}を保存`}</button><span className="saved-inline" role="status">{message}</span></div>
    {error ? <p className="field-error" role="alert">{error}</p> : null}
  </div>;
}

export function ModelDefaults() {
  const [data, setData] = useState(null); const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    Promise.all([api('/state'), api('/model-settings/generated')]).then(([state, generated]) => {
      if (active) setData({ leader: state.agents.find(agent => agent.role === 'leader'), generated });
    }).catch(error => { if (active) setError(error.message); });
    return () => { active = false; };
  }, []);
  if (!data) return <p className="field-hint" role={error ? 'alert' : 'status'}>{error || 'モデル設定を読み込んでいます…'}</p>;
  return <>
    {data.leader ? <ModelChoice initial={data.leader} endpoint={`/agents/${data.leader.id}/model`} title="リーダーのモデル" hint="保存するとリーダーのモデルを変更します。人格と記憶は引き継ぎます。" /> : null}
    <ModelChoice initial={data.generated} endpoint="/model-settings/generated" title="新しいBotの標準モデル" hint="保存後に生成するBotへ適用します。既存Botは、Botのプロフィールから変更できます。" />
  </>;
}
