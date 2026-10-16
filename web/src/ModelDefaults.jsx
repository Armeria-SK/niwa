import { useEffect, useState } from 'react';
import { api } from './api.js';
import { CLAUDE_EFFORTS, modelLabel, modelListPath, nativeReasoning, providerLabel } from './providers.js';
import { useAnthropicModels } from './anthropicModels.js';

const selection = value => ({ provider: value.provider, model: value.model, reasoning: value.reasoning });
const key = value => `${value.provider}:${value.model}`;
function ModelChoice({ initial, endpoint, title, hint }) {
  const [saved, setSaved] = useState(() => selection(initial));
  const [draft, setDraft] = useState(() => selection(initial));
  const [models, setModels] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [manual, setManual] = useState('');
  const [claudeManual, setClaudeManual] = useState('');
  // Claudeのモデルはキーを保存すると自動で取得する（新しい順・表示名つき）。
  const claude = useAnthropicModels();
  const claudeModels = claude.models.map(item => ({ ...item, reasoning: item.default_effort }));
  const listed = [...claudeModels, ...models.filter(item => !claudeModels.some(other => key(other) === key(item)))];
  const known = item => listed.find(other => key(other) === key(item));
  const choices = [draft, ...(key(saved) === key(draft) ? [] : [saved]), ...listed.filter(item => key(item) !== key(draft) && key(item) !== key(saved))].map(item => ({ ...item, display_name: known(item)?.display_name }));
  const efforts = nativeReasoning(draft.provider) ? ['native'] : known(draft)?.supported_efforts || (draft.provider === 'anthropic' ? ['native', ...CLAUDE_EFFORTS] : [draft.reasoning]);
  async function load(provider) {
    setBusy(true); setError(''); setMessage('');
    try {
      const values = await api(modelListPath(provider));
      setModels(values.map(item => nativeReasoning(provider) ? { ...item, reasoning: 'native' } : { ...item, provider, model: item.model_id, reasoning: item.default_effort || item.supported_efforts[0] }));
      setMessage('利用できるモデルを取得しました。');
    } catch (error) { setError(error.message); }
    finally { setBusy(false); }
  }
  async function save() {
    setBusy(true); setError(''); setMessage('');
    try { const next = selection(await api(endpoint, 'PUT', draft)); setSaved(next); setDraft(next); setMessage('モデルを保存しました。'); }
    catch (error) { setError(error.message); }
    finally { setBusy(false); }
  }
  return <div role="group" aria-label={title}>
    <div className="field-pair"><label className="field"><span>{title}</span><select disabled={busy} value={key(draft)} onChange={event => { setDraft(selection(choices.find(item => key(item) === event.target.value))); setMessage(''); }}>{choices.map(item => <option key={key(item)} value={key(item)}>{modelLabel(item)} · {providerLabel(item.provider)}</option>)}</select></label>
      <label className="field"><span>{title}の推論の強さ</span><select value={draft.reasoning} disabled={busy || nativeReasoning(draft.provider)} onChange={event => { setDraft(current => ({ ...current, reasoning: event.target.value })); setMessage(''); }}>{efforts.map(value => <option key={value}>{value}</option>)}</select></label></div>
    <div className="inline-actions"><button type="button" className="button secondary" disabled={busy} onClick={() => load('openai_subscription')}>Codexのモデルを取得</button><button type="button" className="button secondary" disabled={busy} onClick={() => load('ollama')}>Ollamaのモデルを取得</button><button type="button" className="button secondary" disabled={busy} onClick={() => load('openai_compatible')}>OpenAI互換APIのモデルを取得</button><button type="button" className="button secondary" disabled={busy || claude.loading} onClick={claude.reload}>Claudeのモデルを取得</button><button type="button" className="button primary" disabled={busy || (key(draft) === key(saved) && draft.reasoning === saved.reasoning)} onClick={save}>モデルを保存</button></div>
    <div className="inline-actions"><label className="field"><span>OpenAI互換APIのモデルIDを直接入力</span><input value={manual} disabled={busy} maxLength={256} onChange={event => setManual(event.target.value)} placeholder="例: gpt-4.1-mini" /></label><button type="button" className="button subtle" disabled={busy || !manual.trim()} onClick={() => { setDraft({ provider: 'openai_compatible', model: manual.trim(), reasoning: 'native' }); setManual(''); setMessage(''); }}>このモデルを選ぶ</button></div>
    {claude.manual ? <div className="inline-actions"><label className="field"><span>ClaudeのモデルIDを直接入力</span><input value={claudeManual} disabled={busy} maxLength={256} onChange={event => setClaudeManual(event.target.value)} placeholder="例: claude-opus-5-5" /></label><button type="button" className="button subtle" disabled={busy || !claudeManual.trim()} onClick={() => { setDraft({ provider: 'anthropic', model: claudeManual.trim(), reasoning: 'medium' }); setClaudeManual(''); setMessage(''); }}>このモデルを選ぶ</button></div> : null}
    {claude.error ? <p className="field-hint" role="status">{claude.error}</p> : null}
    <p className="field-hint">{hint}</p>
    {error ? <p className="field-error" role="alert">{error}</p> : null}
    <p className="saved-inline" role="status">{busy ? '接続先を確認しています…' : message}</p>
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
    <ModelChoice initial={data.generated} endpoint="/model-settings/generated" title="新しいBotの標準モデル" hint="保存後に生成するBotへ適用します。既存Botは、メンバーのプロフィールから変更できます。" />
  </>;
}
