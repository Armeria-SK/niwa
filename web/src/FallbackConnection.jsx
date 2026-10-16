import { useEffect, useState } from 'react';
import { api } from './api.js';

const PROVIDERS = { ollama: 'Ollama', openai_compatible: 'OpenAI互換API' };
export function FallbackConnection({ savedUrl }) {
  const [settings, setSettings] = useState(null);
  const [provider, setProvider] = useState('ollama');
  const [models, setModels] = useState([]);
  const [selected, setSelected] = useState('');
  const [manual, setManual] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  function apply(next) { setSettings(next); setProvider(next.fallbackProvider || 'ollama'); setSelected(next.fallbackModel || ''); }
  useEffect(() => {
    let active = true;
    setSettings(null); setModels([]); setError(''); setMessage('');
    api('/model-settings').then(next => { if (active) apply(next); }).catch(error => { if (active) setError(error.message); });
    return () => { active = false; };
  }, [savedUrl]);
  const endpoint = provider === 'ollama' ? settings?.ollamaUrl : settings?.compatibleUrl;
  const savedHere = settings?.fallbackProvider === provider ? settings?.fallbackModel || '' : '';
  async function refresh() {
    setBusy(true); setError(''); setMessage('');
    try {
      const next = await api('/model-settings'); setSettings(next);
      setModels(await api(provider === 'ollama' ? '/models' : '/openai-compatible/models'));
      setMessage(provider === 'ollama' ? '導入済みモデルを取得しました。' : '利用できるモデルを取得しました。');
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
  const options = [...new Set([savedHere, selected, ...models.map(item => item.model)].filter(Boolean))];
  return <>
    <label className="field"><span>切替先の接続</span><select value={provider} disabled={busy} onChange={event => { setProvider(event.target.value); setModels([]); setSelected(settings?.fallbackProvider === event.target.value ? settings.fallbackModel || '' : ''); setMessage(''); api('/model-settings').then(setSettings).catch(failure => setError(failure.message)); }}>{Object.entries(PROVIDERS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    <p className="field-hint">保存済みの接続先: {endpoint || '未設定'}。{provider === 'ollama' ? 'URLを変更した場合は、先に下の「設定を保存」を押してください。' : 'OpenAI互換APIの接続設定は上で保存してください。'}</p>
    <label className="field"><span>上限時に使うモデル</span><select value={selected} disabled={busy || !endpoint} onChange={event => { setSelected(event.target.value); setMessage(''); }}><option value="">未設定（上限時は待機）</option>{options.map(model => <option key={model} value={model}>{model}</option>)}</select></label>
    {provider === 'openai_compatible' ? <div className="inline-actions"><label className="field"><span>モデルIDを直接入力</span><input value={manual} disabled={busy || !endpoint} maxLength={256} onChange={event => setManual(event.target.value)} placeholder="例: gpt-4.1-mini" /></label><button type="button" className="button subtle" disabled={busy || !manual.trim()} onClick={() => { setSelected(manual.trim()); setManual(''); }}>候補に追加</button></div> : null}
    <div className="inline-actions">
      <button type="button" className="button secondary" disabled={busy || !endpoint} onClick={refresh}>{provider === 'ollama' ? '導入済みモデルを取得' : 'モデル一覧を取得'}</button>
      <button type="button" className="button primary" disabled={busy || !endpoint || (selected === savedHere && settings?.fallbackProvider === provider) || (!selected && !settings?.fallbackModel)} onClick={() => save(selected || null)}>切替先を保存</button>
      <button type="button" className="button subtle" disabled={busy || !settings?.fallbackModel} onClick={() => save(null)}>自動切替を解除</button>
    </div>
    <p className="field-hint">{provider === 'ollama' ? '保存時にツール対応を確認します。' : 'ツール呼び出しに対応したモデルを選んでください。'}サブスクの利用上限に達した場合だけ切り替え、回復確認の成功後、応答の区切りで元のモデルに戻ります。</p>
    <p className="field-hint">利用上限・接続設定の確認で待機した仕事は、1分ごとに再確認します。活動画面から手動でも再開できます。</p>
    {error ? <p className="field-error" role="alert">{error}</p> : null}
    <p className="saved-inline" role="status">{busy ? '接続先を確認しています…' : message}</p>
  </>;
}
