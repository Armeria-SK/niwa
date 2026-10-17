import { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { useAnthropicModels } from './anthropicModels.js';
import { ModelPicker } from './ModelPicker.jsx';

const PROVIDERS = ['local_llm', 'openai_compatible', 'anthropic'];
const SUGGESTED_CLAUDE = 'claude-opus-5-5';
const choiceOf = settings => settings?.fallbackModel ? { provider: settings.fallbackProvider, model: settings.fallbackModel } : null;

/** ChatGPTのサブスクの利用上限に達したときだけ使う切替先。推論の強さはモデルの既定で動く。 */
export function FallbackConnection() {
  const [settings, setSettings] = useState(null);
  const [selected, setSelected] = useState(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [message, setMessage] = useState('');
  // Claudeのモデルはキーを保存すると自動で取得する（新しい順・表示名つき）。候補選びと選択の部品で同じ一覧を使う。
  const claude = useAnthropicModels();
  function apply(next) { setSettings(next); setSelected(choiceOf(next)); }
  useEffect(() => {
    let active = true;
    api('/model-settings').then(next => { if (active) apply(next); }).catch(failure => { if (active) setError(failure.message); });
    return () => { active = false; };
  }, []);
  // 保存済みの切替先がなければ、一覧にある場合だけClaude Opus 5.5を候補として選んでおく（保存は押したときだけ）。
  const suggested = useRef(false);
  useEffect(() => {
    if (suggested.current || !settings || settings.fallbackModel || selected || !claude.models.some(item => item.model === SUGGESTED_CLAUDE)) return;
    suggested.current = true; setSelected({ provider: 'anthropic', model: SUGGESTED_CLAUDE });
  }, [settings, selected, claude.models]);
  async function save(choice) {
    setBusy(true); setError(''); setMessage('');
    try {
      apply(await api('/model-settings/fallback', 'PUT', choice ? { model: choice.model, provider: choice.provider } : { model: null, provider: settings.fallbackProvider }));
      setMessage(choice ? '切替先を保存しました。' : '自動切替を解除しました。');
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  const saved = choiceOf(settings);
  const same = selected?.provider === saved?.provider && selected?.model === saved?.model;
  return <div role="group" aria-label="利用上限時の自動切替">
    <div className="form-section-label">利用上限時の自動切替</div>
    <p className="field-hint">ChatGPTのサブスクの利用上限に達したときだけ、ここで選んだモデルに切り替えます。<br />回復を確かめたら、応答の区切りで元のモデルに戻ります。</p>
    <ModelPicker label="上限時に使うモデル" value={selected} keep={saved ? [saved] : []} providers={PROVIDERS} reasoning={false} emptyLabel="未設定（上限時は待つ）" claude={claude} disabled={busy || !settings} onChange={next => { setSelected(next); setMessage(''); }} />
    <div className="inline-actions">
      <button type="button" className="button primary" disabled={busy || !settings || !selected || same} onClick={() => save(selected)}>切替先を保存</button>
      <button type="button" className="button subtle" disabled={busy || !settings?.fallbackModel} onClick={() => save(null)}>自動切替を解除</button>
      <span className="saved-inline" role="status">{busy ? '接続先を確認しています…' : message}</span>
    </div>
    <p className="field-hint">上でつないだ接続先のモデルだけが使えます。<br />ツール呼び出しに対応したモデルを選んでください（Local LLMは保存するときに確かめます）。<br />利用上限や接続の確認で待っている仕事は、1分ごとに確かめ直します。<br />「記録」の画面から手で再開することもできます。</p>
    {error ? <p className="field-error" role="alert">{error}</p> : null}
  </div>;
}
