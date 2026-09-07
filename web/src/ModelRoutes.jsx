import { useEffect, useState } from 'react';
import { api } from './api.js';

const providerName = provider => provider === 'ollama' ? 'Ollama' : 'Codex';
export function ModelRoutes() {
  const [routes, setRoutes] = useState([]);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true; let timer;
    async function refresh() {
      try { const next = await api('/model-routes'); if (active) { setRoutes(next); setError(''); } }
      catch (error) { if (active) setError(error.message); }
      if (active) timer = setTimeout(refresh, 2000);
    }
    void refresh(); return () => { active = false; clearTimeout(timer); };
  }, []);
  return <>
    <div className="form-section-label">直近のモデル接続</div>
    <p className="field-hint">応答を試みた接続先です。完了や接続成功を示すものではありません。</p>
    {routes.map(route => <div key={route.id}>
      <strong>{route.name}</strong>
      <p className="field-hint">設定: {providerName(route.configured_provider)} / {route.configured_model}</p>
      <p className="field-hint">直近: {route.attempted_at ? <>{providerName(route.provider)} / {route.model} · {route.reason === 'quota' ? '利用上限による切替' : '設定モデルを使用'}<br /><time dateTime={new Date(route.attempted_at).toISOString()}>{new Date(route.attempted_at).toLocaleString('ja-JP')}</time></> : 'まだ接続していません'}</p>
    </div>)}
    {error ? <p className="field-error" role="alert">{error}</p> : null}
  </>;
}
