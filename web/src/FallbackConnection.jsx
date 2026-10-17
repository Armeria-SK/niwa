import { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { useAnthropicModels } from './anthropicModels.js';
import { modelLabel } from './providers.js';
import { Sentences } from './components.jsx';

const PROVIDERS = { local_llm: 'Local LLM', openai_compatible: 'OpenAI互換API', anthropic: 'Claude（Anthropic API）' };
const SUGGESTED_CLAUDE = 'claude-opus-5-5';
export function FallbackConnection({ savedUrl }) {
  const [settings, setSettings] = useState(null);
  const [provider, setProvider] = useState('local_llm');
  const [models, setModels] = useState([]);
  const [selected, setSelected] = useState('');
  const [manual, setManual] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  // Claudeのモデルはキーを保存すると自動で取得する（新しい順・表示名つき）。
  const claude = useAnthropicModels();
  function apply(next) { setSettings(next); setProvider(next.fallbackProvider || 'local_llm'); setSelected(next.fallbackModel || ''); }
  useEffect(() => {
    let active = true;
    setSettings(null); setModels([]); setError(''); setMessage('');
    api('/model-settings').then(next => { if (active) apply(next); }).catch(error => { if (active) setError(error.message); });
    return () => { active = false; };
  }, [savedUrl]);
  const endpoint = provider === 'local_llm' ? settings?.localLlmUrl : provider === 'anthropic' ? (claude.keyConfigured ? 'https://api.anthropic.com' : '') : settings?.compatibleUrl;
  const savedHere = settings?.fallbackProvider === provider ? settings?.fallbackModel || '' : '';
  const listed = provider === 'anthropic' ? claude.models : models;
  // 保存済みの切替先がなければ、一覧にある場合だけClaude Opus 5.5を候補として選んでおく。
  const suggested = useRef(false);
  useEffect(() => {
    if (provider !== 'anthropic') { suggested.current = false; return; }
    if (suggested.current || !settings || savedHere || selected || !claude.models.some(item => item.model === SUGGESTED_CLAUDE)) return;
    suggested.current = true; setSelected(SUGGESTED_CLAUDE);
  }, [provider, settings, savedHere, selected, claude.models]);
  async function refresh() {
    if (provider === 'anthropic') { await claude.reload(); return; }
    setBusy(true); setError(''); setMessage('');
    try {
      const next = await api('/model-settings'); setSettings(next);
      setModels(await api(provider === 'local_llm' ? '/models' : '/openai-compatible/models'));
      setMessage(provider === 'local_llm' ? '導入済みモデルを取得しました。' : '利用できるモデルを取得しました。');
    } catch (error) { setModels([]); setError(error.message); }
    finally { setBusy(false); }
  }
  async function save(model) {
    setBusy(true); setError(''); setMessage('');
    try {
      apply(await api('/model-settings/fallback', 'PUT', { model, provider }));
      setManual(''); setMessage(model ? '切替先を保存しました。' : '自動切替を解除しました。');
    } catch (error) { setError(error.message); }
    finally { setBusy(false); }
  }
  const options = [...new Set([savedHere, selected, ...listed.map(item => item.model)].filter(Boolean))];
  const label = model => { const item = listed.find(other => other.model === model); return item ? modelLabel(item) : model; };
  return <>
    <label className="field"><span>切替先の接続</span><select value={provider} disabled={busy} onChange={event => { setProvider(event.target.value); setModels([]); setSelected(settings?.fallbackProvider === event.target.value ? settings.fallbackModel || '' : ''); setMessage(''); api('/model-settings').then(setSettings).catch(failure => setError(failure.message)); }}>{Object.entries(PROVIDERS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    <p className="field-hint"><Sentences>{`保存済みの接続先: ${endpoint || '未設定'}。${provider === 'local_llm' ? 'Local LLMの接続先URLを変えた場合は、先にページ下の「設定を保存」を押してから、導入済みモデルを取得してください。切替先のモデルは、すぐ下の「切替先を保存」で保存します。' : provider === 'anthropic' ? 'ClaudeのAPIキーは上で保存してください。' : 'OpenAI互換APIの接続設定は上で保存してください。'}`}</Sentences></p>
    <label className="field"><span>上限時に使うモデル</span><select value={selected} disabled={busy || !endpoint} onChange={event => { setSelected(event.target.value); setMessage(''); }}><option value="">未設定（上限時は待機）</option>{options.map(model => <option key={model} value={model}>{label(model)}</option>)}</select></label>
    {provider === 'anthropic' && claude.error ? <p className="field-hint" role="status">{claude.error}</p> : null}
    {provider === 'openai_compatible' || (provider === 'anthropic' && claude.manual) ? <div className="inline-actions"><label className="field"><span>モデルIDを直接入力</span><input value={manual} disabled={busy || !endpoint} maxLength={256} onChange={event => setManual(event.target.value)} placeholder={provider === 'anthropic' ? '例: claude-opus-5-5' : '例: gpt-4.1-mini'} /></label><button type="button" className="button subtle" disabled={busy || !manual.trim()} onClick={() => { setSelected(manual.trim()); setManual(''); }}>候補に追加</button></div> : null}
    <div className="inline-actions">
      <button type="button" className="button secondary" disabled={busy || !endpoint} onClick={refresh}>{provider === 'local_llm' ? '導入済みモデルを取得' : 'モデル一覧を取得'}</button>
      <button type="button" className="button primary" disabled={busy || !endpoint || (selected === savedHere && settings?.fallbackProvider === provider) || (!selected && !settings?.fallbackModel)} onClick={() => save(selected || null)}>切替先を保存</button>
      <button type="button" className="button subtle" disabled={busy || !settings?.fallbackModel} onClick={() => save(null)}>自動切替を解除</button>
    </div>
    <p className="field-hint">{provider === 'local_llm' ? '保存時にツール対応を確認します。' : 'ツール呼び出しに対応したモデルを選んでください。'}サブスクの利用上限に達した場合だけ切り替え、回復確認の成功後、応答の区切りで元のモデルに戻ります。</p>
    <p className="field-hint">利用上限・接続設定の確認で待機した仕事は、1分ごとに再確認します。<br />活動画面から手動でも再開できます。</p>
    {error ? <p className="field-error" role="alert">{error}</p> : null}
    <p className="saved-inline" role="status">{busy ? '接続先を確認しています…' : message}</p>
  </>;
}
