import { useEffect, useState } from 'react';
import { api } from './api.js';

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
    try { setMessage(await work()); } catch (failure) { setError(failure.message); } finally { setBusy(false); }
  }
  const save = () => run(async () => { apply(await api('/model-settings', 'PATCH', { ...(urlChanged ? { localLlmUrl: url.trim() || null } : {}), ...(parallelChanged ? { maxParallel: Number(parallel) } : {}) })); return '接続設定を保存しました。'; });
  const check = () => run(async () => `接続できました（導入済みのモデル${(await api('/models')).length}件）。`);
  return <div role="group" aria-label="Local LLM">
    <div className="form-section-label">Local LLM（Ollama）</div>
    <div className="connection-row"><strong>接続の状態</strong><span className="connection-state"><span className="status-dot" />{!saved ? '確認中' : saved.localLlmUrl ? '接続先を保存済み' : '未設定'}</span></div>
    <p className="field-hint">このPCや同じ家のPCで動かすOllamaに接続します。<br />お金はかかりませんが、PCの性能で速さが決まります。</p>
    <label className="field"><span>接続先URL</span><input type="url" value={url} disabled={busy} onChange={event => { setUrl(event.target.value); setMessage(''); }} placeholder="http://127.0.0.1:11434" autoComplete="off" /></label>
    <label className="field narrow-field"><span>同時に処理する依頼の数</span><div className="input-with-unit"><input type="number" min="1" max="8" value={parallel} disabled={busy} onChange={event => { setParallel(event.target.value); setMessage(''); }} /><span>件</span></div><small>Ollamaの設定（OLLAMA_NUM_PARALLEL）に合わせてください。</small></label>
    <div className="inline-actions">
      <button type="button" className="button primary" disabled={busy || !(urlChanged || parallelChanged) || !(Number(parallel) >= 1 && Number(parallel) <= 8)} onClick={save}>接続設定を保存</button>
      <button type="button" className="button secondary" disabled={busy || !saved?.localLlmUrl || urlChanged} onClick={check}>接続を確認</button>
    </div>
    {error ? <p className="field-error" role="alert">{error}</p> : null}
    <p className="saved-inline" role="status">{busy ? '接続先を確認しています…' : message}</p>
  </div>;
}
