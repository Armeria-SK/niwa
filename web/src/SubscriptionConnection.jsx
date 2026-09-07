import { useEffect, useState } from 'react';
import { api } from './api.js';

export function SubscriptionConnection() {
  const [status, setStatus] = useState(null); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true; let timer;
    async function refresh() {
      try { const next = await api('/subscription'); if (active) setStatus(next); } catch (error) { if (active) setError(error.message); }
      if (active) timer = setTimeout(refresh, 2000);
    }
    void refresh(); return () => { active = false; clearTimeout(timer); };
  }, []);
  async function act(action) {
    setBusy(true); setError('');
    try { await api(`/subscription/${action}`, 'POST', action === 'login' ? { experimental_opt_in: true } : {}); setStatus(await api('/subscription')); }
    catch (error) { setError(error.message); } finally { setBusy(false); }
  }
  return <>
    <div className="connection-row"><strong>Codex</strong><span className="connection-state"><span className="status-dot" />{status?.pending ? 'ログインを待っています' : status?.connected ? '認証情報を保存済み' : '未接続'}</span></div>
    <div className="inline-actions">{status?.url ? <a className="button primary" href={status.url} target="_blank" rel="noreferrer">ChatGPTのログインを開く</a> : null}<button type="button" className="button secondary" disabled={busy || !status?.available} onClick={() => act(status?.pending || status?.connected ? 'logout' : 'login')}>{status?.pending ? '接続を中止' : status?.connected ? '接続を解除' : 'ChatGPTで接続（試験対応）'}</button></div>
    <p className="field-hint">接続はNiwaを動かしているPCのブラウザーから行ってください。</p>
    {error || status?.error ? <p className="field-error" role="alert">{error || status.error}</p> : null}
  </>;
}
