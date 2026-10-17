import { useEffect, useState } from 'react';
import { api } from './api.js';
import { ConnectionCard } from './ConnectionCard.jsx';
import { FallbackConnection } from './FallbackConnection.jsx';
import { notifyModelsChanged } from './modelLists.js';

export function SubscriptionConnection() {
  const [status, setStatus] = useState(null); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true; let timer, connected;
    async function refresh() {
      try {
        const next = await api('/subscription');
        // ブラウザーでのログインが済んだら、モデルを選ぶ欄にCodexの一覧を読ませる。
        if (active) { setStatus(next); if (connected !== undefined && connected !== next.connected) notifyModelsChanged(); connected = next.connected; }
      } catch (error) { if (active) setError(error.message); }
      if (active) timer = setTimeout(refresh, 2000);
    }
    void refresh(); return () => { active = false; clearTimeout(timer); };
  }, []);
  async function act(action) {
    setBusy(true); setError('');
    try { await api(`/subscription/${action}`, 'POST', action === 'login' ? { experimental_opt_in: true } : {}); setStatus(await api('/subscription')); }
    catch (error) { setError(error.message); } finally { setBusy(false); notifyModelsChanged(); }
  }
  const state = !status ? '確認中' : status.pending ? 'ログインを待っています' : status.connected ? '接続済み' : '未接続';
  return <ConnectionCard title="ChatGPT（Codex）" tag="試験対応" summary="ChatGPTのサブスクで、Codexのモデルにつなぎます。" state={state} tone={status?.connected ? 'ok' : status?.pending ? 'warn' : 'muted'}>
    <p className="field-hint">ChatGPTでの接続は、外部アプリ向けに公式公開された経路ではありません。<br />予告なく使えなくなる場合に備えて、ほかの接続先もつないでおくと安心です。</p>
    <div className="inline-actions">{status?.url ? <a className="button primary" href={status.url} target="_blank" rel="noreferrer">ChatGPTのログインを開く</a> : null}<button type="button" className="button secondary" disabled={busy || !status?.available} onClick={() => act(status?.pending || status?.connected ? 'logout' : 'login')}>{status?.pending ? '接続を中止' : status?.connected ? '接続を解除' : 'ChatGPTで接続（試験対応）'}</button></div>
    <p className="field-hint">接続はNiwaを動かしているPCのブラウザーから行ってください。</p>
    {error || status?.error ? <p className="field-error" role="alert">{error || status.error}</p> : null}
    <FallbackConnection />
  </ConnectionCard>;
}
