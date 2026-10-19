import { useEffect, useState } from 'react';
import { api } from './api.js';
import { notifyAnthropicChanged } from './anthropicModels.js';
import { ConnectionCard } from './ConnectionCard.jsx';
import { notifyModelsChanged } from './modelLists.js';
import { serverText, t } from './i18n.js';

/** APIキーはサーバーへ送るだけで、画面には保存済みかどうかだけを表示する。キーは公式のAPI（api.anthropic.com）にだけ送る。 */
export function AnthropicConnection() {
  const [status, setStatus] = useState(null);
  const [apiKey, setApiKey] = useState(''); const [parallel, setParallel] = useState(2);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [message, setMessage] = useState('');
  function apply(next) { setStatus(next); setParallel(next.parallel); }
  useEffect(() => {
    let active = true;
    api('/anthropic').then(next => { if (active) apply(next); }).catch(failure => { if (active) setError(failure.message); });
    return () => { active = false; };
  }, []);
  async function run(work, done) {
    setBusy(true); setError(''); setMessage('');
    try { const next = await work(); if (next) apply(next); setMessage(done); }
    catch (failure) { setError(failure.message); api('/anthropic').then(apply).catch(() => undefined); }
    finally { setBusy(false); notifyAnthropicChanged(); notifyModelsChanged(); }
  }
  const trimmed = apiKey.trim();
  const changed = Number(parallel) !== status?.parallel || trimmed !== '';
  const unusualKey = trimmed !== '' && !trimmed.startsWith('sk-ant-');
  function save() {
    const body = { ...(Number(parallel) !== status?.parallel ? { parallel: Number(parallel) } : {}), ...(trimmed ? { apiKey: trimmed } : {}) };
    return run(async () => { const next = await api('/anthropic', 'PUT', body); setApiKey(''); return next; }, t(trimmed ? 'connections.anthropicKeySaved' : 'connections.connectionSaved'));
  }
  async function check() {
    setBusy(true); setError(''); setMessage('');
    try { const result = await api('/anthropic/check', 'POST', {}); if (result.ok) setMessage(t('connections.checkOk', { count: result.models })); else setError(result.message); }
    catch (failure) { setError(failure.message); }
    finally { setBusy(false); notifyAnthropicChanged(); }
  }
  return <ConnectionCard title={t('connections.anthropicTitle')} summary={t('connections.anthropicSummary')} state={t(!status ? 'connections.stateChecking' : status.keyConfigured ? 'connections.stateConfigured' : 'connections.stateNotConfigured')} tone={status?.keyConfigured ? 'ok' : 'muted'}>
    <p className="field-hint">{t('connections.anthropicHint1')}<br />{t('connections.anthropicHint2')}<br />{t('connections.anthropicHint3')}<br />{t('connections.anthropicHint4')}<br />{t('connections.anthropicHint5')}</p>
    <label className="field"><span>{t('connections.apiKey')}</span><input type="password" value={apiKey} disabled={busy || status?.available === false} onChange={event => { setApiKey(event.target.value); setMessage(''); }} placeholder={status?.keyConfigured ? t('connections.keyPlaceholderSaved') : 'sk-ant-…'} autoComplete="new-password" spellCheck={false} /><small>{t('connections.keyNotShown')}<br />{t('connections.anthropicKeyOnlyAnthropic')}</small></label>
    {unusualKey ? <p className="field-hint" role="status">{t('connections.anthropicKeyUnusual1')}<br />{t('connections.anthropicKeyUnusual2')}</p> : null}
    <label className="field narrow-field"><span>{t('connections.parallelRequests')}</span><div className="input-with-unit"><input type="number" min="1" max="8" value={parallel} disabled={busy} onChange={event => setParallel(event.target.value)} /><span>{t('connections.parallelUnit')}</span></div><small>{t('connections.anthropicParallelHint')}</small></label>
    <div className="inline-actions">
      <button type="button" className="button primary" disabled={busy || !changed || !(Number(parallel) >= 1 && Number(parallel) <= 8)} onClick={save}>{t('connections.saveConnection')}</button>
      <button type="button" className="button secondary" disabled={busy || !status?.keyConfigured} onClick={check}>{t('connections.checkConnection')}</button>
      <button type="button" className="button subtle" disabled={busy || !status?.keyConfigured} onClick={() => run(() => api('/anthropic/key', 'DELETE', {}), t('connections.apiKeyDeleted'))}>{t('connections.deleteKey')}</button>
    </div>
    <p className="field-hint">{t('connections.checkOnlyLists')}<br />{t('connections.anthropicRetryNote')}</p>
    {error ? <p className="field-error" role="alert">{serverText(error)}</p> : null}
    <p className="saved-inline" role="status">{busy ? t('connections.checking') : message}</p>
  </ConnectionCard>;
}
