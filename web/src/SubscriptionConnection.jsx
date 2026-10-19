import { useEffect, useState } from 'react';
import { api } from './api.js';
import { ConnectionCard } from './ConnectionCard.jsx';
import { FallbackConnection } from './FallbackConnection.jsx';
import { notifyModelsChanged } from './modelLists.js';
import { serverText, t } from './i18n.js';

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
  const state = t(!status ? 'connections.stateChecking' : status.pending ? 'connections.stateWaitingLogin' : status.connected ? 'connections.stateConnected' : 'connections.stateNotConnected');
  return <ConnectionCard title={t('connections.subscriptionTitle')} tag={t('connections.subscriptionTag')} summary={t('connections.subscriptionSummary')} state={state} tone={status?.connected ? 'ok' : status?.pending ? 'warn' : 'muted'}>
    <p className="field-hint">{t('connections.subscriptionHint1')}<br />{t('connections.subscriptionHint2')}</p>
    <div className="inline-actions">{status?.url ? <a className="button primary" href={status.url} target="_blank" rel="noreferrer">{t('connections.openChatgptLogin')}</a> : null}<button type="button" className="button secondary" disabled={busy || !status?.available} onClick={() => act(status?.pending || status?.connected ? 'logout' : 'login')}>{t(status?.pending ? 'connections.cancelConnecting' : status?.connected ? 'connections.disconnect' : 'connections.connectChatgpt')}</button></div>
    <p className="field-hint">{t('connections.subscriptionBrowserNote')}</p>
    {error || status?.error ? <p className="field-error" role="alert">{serverText(error || status.error)}</p> : null}
    <FallbackConnection />
  </ConnectionCard>;
}
