import { useEffect, useState } from 'react';
import { api } from './api.js';
import { ConnectionCard } from './ConnectionCard.jsx';
import { notifyModelsChanged } from './modelLists.js';
import { serverText, t } from './i18n.js';

/** このPCなどで動かすLocal LLM（Ollama）の接続先。ほかの接続と同じく、この枠の中で保存する。 */
export function LocalLlmConnection() {
  const [saved, setSaved] = useState(null);
  const [url, setUrl] = useState(''); const [parallel, setParallel] = useState(1);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [message, setMessage] = useState('');
  function apply(next) { setSaved(next); setUrl(next.localLlmUrl || ''); setParallel(next.maxParallel ?? 1); }
  useEffect(() => {
    let active = true;
    api('/model-settings').then(next => { if (active) apply(next); }).catch(failure => { if (active) setError(failure.message); });
    return () => { active = false; };
  }, []);
  const urlChanged = !!saved && url.trim() !== (saved.localLlmUrl || ''), parallelChanged = !!saved && Number(parallel) !== (saved.maxParallel ?? 1);
  async function run(work) {
    setBusy(true); setError(''); setMessage('');
    try { setMessage(await work()); } catch (failure) { setError(failure.message); } finally { setBusy(false); notifyModelsChanged(); }
  }
  const save = () => run(async () => { apply(await api('/model-settings', 'PATCH', { ...(urlChanged ? { localLlmUrl: url.trim() || null } : {}), ...(parallelChanged ? { maxParallel: Number(parallel) } : {}) })); return t('connections.connectionSaved'); });
  const check = () => run(async () => t('connections.localCheckOk', { count: (await api('/models')).length }));
  return <ConnectionCard title={t('connections.localTitle')} summary={t('connections.localSummary')} state={t(!saved ? 'connections.stateChecking' : saved.localLlmUrl ? 'connections.stateConfigured' : 'connections.stateNotConfigured')} tone={saved?.localLlmUrl ? 'ok' : 'muted'}>
    <p className="field-hint">{t('connections.localHint1')}<br />{t('connections.localHint2')}</p>
    <label className="field"><span>{t('connections.connectionUrl')}</span><input type="url" value={url} disabled={busy} onChange={event => { setUrl(event.target.value); setMessage(''); }} placeholder="http://127.0.0.1:11434" autoComplete="off" /></label>
    <label className="field narrow-field"><span>{t('connections.localParallel')}</span><div className="input-with-unit"><input type="number" min="1" max="8" value={parallel} disabled={busy} onChange={event => { setParallel(event.target.value); setMessage(''); }} /><span>{t('connections.parallelUnit')}</span></div><small>{t('connections.localParallelHint')}</small></label>
    <div className="inline-actions">
      <button type="button" className="button primary" disabled={busy || !(urlChanged || parallelChanged) || !(Number(parallel) >= 1 && Number(parallel) <= 8)} onClick={save}>{t('connections.saveConnection')}</button>
      <button type="button" className="button secondary" disabled={busy || !saved?.localLlmUrl || urlChanged} onClick={check}>{t('connections.checkConnection')}</button>
    </div>
    {error ? <p className="field-error" role="alert">{serverText(error)}</p> : null}
    <p className="saved-inline" role="status">{busy ? t('connections.checking') : message}</p>
  </ConnectionCard>;
}
