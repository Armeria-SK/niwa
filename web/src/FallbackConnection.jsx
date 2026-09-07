import { useEffect, useState } from 'react';
import { api } from './api.js';

export function FallbackConnection({ savedUrl }) {
  const [settings, setSettings] = useState(null);
  const [models, setModels] = useState([]);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  useEffect(() => {
    let active = true;
    setSettings(null); setModels([]); setError(''); setMessage('');
    api('/model-settings').then(next => {
      if (active) { setSettings(next); setSelected(next.fallbackModel || ''); }
    }).catch(error => { if (active) setError(error.message); });
    return () => { active = false; };
  }, [savedUrl]);
  async function refresh() {
    setBusy(true); setError(''); setMessage('');
    try {
      const next = await api('/model-settings');
      setSettings(next); setSelected(next.fallbackModel || '');
      setModels(await api('/models'));
      setMessage('導入済みモデルを取得しました。');
    } catch (error) { setModels([]); setError(error.message); }
    finally { setBusy(false); }
  }
  async function save(model) {
    setBusy(true); setError(''); setMessage('');
    try {
      const next = await api('/model-settings/fallback', 'PUT', { model });
      setSettings(next); setSelected(next.fallbackModel || '');
      setMessage(model ? '切替先を保存しました。' : '自動切替を解除しました。');
    } catch (error) { setError(error.message); }
    finally { setBusy(false); }
  }
  const options = [...new Set([settings?.fallbackModel, ...models.map(item => item.model)].filter(Boolean))];
  return <>
    <p className="field-hint">保存済みの接続先: {settings?.ollamaUrl || '未設定'}。URLを変更した場合は、先に下の「設定を保存」を押してください。</p>
    <label className="field"><span>上限時に使うローカルモデル</span><select value={selected} disabled={busy || !settings?.ollamaUrl} onChange={event => { setSelected(event.target.value); setMessage(''); }}><option value="">未設定（上限時は待機）</option>{options.map(model => <option key={model} value={model}>{model}</option>)}</select></label>
    <div className="inline-actions">
      <button type="button" className="button secondary" disabled={busy || !settings?.ollamaUrl} onClick={refresh}>導入済みモデルを取得</button>
      <button type="button" className="button primary" disabled={busy || !settings?.ollamaUrl || selected === (settings?.fallbackModel || '')} onClick={() => save(selected || null)}>切替先を保存</button>
      <button type="button" className="button subtle" disabled={busy || !settings?.fallbackModel} onClick={() => save(null)}>自動切替を解除</button>
    </div>
    <p className="field-hint">保存時にツール対応を確認します。サブスクの利用上限に達した場合だけ切り替え、回復確認の成功後、応答の区切りで元のモデルに戻ります。</p>
    <p className="field-hint">利用上限・接続設定の確認で待機した仕事は、1分ごとに再確認します。活動画面から手動でも再開できます。</p>
    {error ? <p className="field-error" role="alert">{error}</p> : null}
    <p className="saved-inline" role="status">{busy ? '接続先を確認しています…' : message}</p>
  </>;
}
