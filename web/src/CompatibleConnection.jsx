import { useEffect, useState } from 'react';
import { api } from './api.js';
import { ConnectionCard } from './ConnectionCard.jsx';
import { notifyModelsChanged } from './modelLists.js';
import { serverText, t } from './i18n.js';

/** APIキーはサーバーへ送るだけで、画面には保存済みかどうかだけを表示する。 */
export function CompatibleConnection() {
  const [status, setStatus] = useState(null);
  const [url, setUrl] = useState(''); const [apiKey, setApiKey] = useState(''); const [parallel, setParallel] = useState(2);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [message, setMessage] = useState('');
  function apply(next) { setStatus(next); setUrl(next.url || ''); setParallel(next.parallel); }
  useEffect(() => {
    let active = true;
    api('/openai-compatible').then(next => { if (active) apply(next); }).catch(failure => { if (active) setError(failure.message); });
    return () => { active = false; };
  }, []);
  async function run(work, done) {
    setBusy(true); setError(''); setMessage('');
    try { const next = await work(); if (next) apply(next); setMessage(done); }
    catch (failure) { setError(failure.message); api('/openai-compatible').then(apply).catch(() => undefined); }
    finally { setBusy(false); notifyModelsChanged(); }
  }
  const changed = url.trim() !== (status?.url || '') || Number(parallel) !== status?.parallel || apiKey !== '';
  function save() {
    const body = { ...(url.trim() !== (status?.url || '') ? { url: url.trim() || null } : {}), ...(Number(parallel) !== status?.parallel ? { parallel: Number(parallel) } : {}), ...(apiKey ? { apiKey } : {}) };
    return run(async () => { const next = await api('/openai-compatible', 'PUT', body); setApiKey(''); return next; }, t('connections.connectionSaved'));
  }
  async function check() {
    setBusy(true); setError(''); setMessage('');
    try { const result = await api('/openai-compatible/check', 'POST', {}); if (result.ok) setMessage(t('connections.checkOk', { count: result.models })); else setError(result.message); }
    catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  const state = t(!status ? 'connections.stateChecking' : !status.url ? 'connections.stateNotConfigured' : status.keyConfigured ? 'connections.stateConfigured' : 'connections.stateApiKeyMissing');
  return <ConnectionCard title={t('connections.compatibleTitle')} summary={t('connections.compatibleSummary')} state={state} tone={status?.url ? (status.keyConfigured ? 'ok' : 'warn') : 'muted'}>
    <p className="field-hint">{t('connections.compatibleHint1')}<br />{t('connections.compatibleHint2')}<br />{t('connections.compatibleHint3')}</p>
    <label className="field"><span>{t('connections.connectionUrl')}</span><input type="url" value={url} disabled={busy} onChange={event => { setUrl(event.target.value); setMessage(''); }} placeholder="https://api.openai.com/v1" autoComplete="off" /><small>{t('connections.compatibleUrlHint1')}<br />{t('connections.compatibleUrlHint2')}</small></label>
    <label className="field"><span>{t('connections.apiKey')}</span><input type="password" value={apiKey} disabled={busy || status?.available === false} onChange={event => { setApiKey(event.target.value); setMessage(''); }} placeholder={t(status?.keyConfigured ? 'connections.keyPlaceholderSaved' : 'connections.placeholderNotSet')} autoComplete="new-password" spellCheck={false} /><small>{t('connections.keyNotShown')}<br />{t('connections.compatibleKeyOnlyUrl')}</small></label>
    <label className="field narrow-field"><span>{t('connections.parallelRequests')}</span><div className="input-with-unit"><input type="number" min="1" max="8" value={parallel} disabled={busy} onChange={event => setParallel(event.target.value)} /><span>{t('connections.parallelUnit')}</span></div><small>{t('connections.compatibleParallelHint')}</small></label>
    <div className="inline-actions">
      <button type="button" className="button primary" disabled={busy || !changed || !(Number(parallel) >= 1 && Number(parallel) <= 8)} onClick={save}>{t('connections.saveConnection')}</button>
      <button type="button" className="button secondary" disabled={busy || !status?.url} onClick={check}>{t('connections.checkConnection')}</button>
      <button type="button" className="button subtle" disabled={busy || !status?.keyConfigured} onClick={() => run(() => api('/openai-compatible/key', 'DELETE', {}), t('connections.apiKeyDeleted'))}>{t('connections.deleteApiKey')}</button>
    </div>
    <p className="field-hint">{t('connections.checkOnlyLists')}</p>
    {error ? <p className="field-error" role="alert">{serverText(error)}</p> : null}
    <p className="saved-inline" role="status">{busy ? t('connections.checking') : message}</p>
  </ConnectionCard>;
}
