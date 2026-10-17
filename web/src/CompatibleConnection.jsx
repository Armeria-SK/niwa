import { useEffect, useState } from 'react';
import { api } from './api.js';

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
    finally { setBusy(false); }
  }
  const changed = url.trim() !== (status?.url || '') || Number(parallel) !== status?.parallel || apiKey !== '';
  function save() {
    const body = { ...(url.trim() !== (status?.url || '') ? { url: url.trim() || null } : {}), ...(Number(parallel) !== status?.parallel ? { parallel: Number(parallel) } : {}), ...(apiKey ? { apiKey } : {}) };
    return run(async () => { const next = await api('/openai-compatible', 'PUT', body); setApiKey(''); return next; }, '接続設定を保存しました。');
  }
  async function check() {
    setBusy(true); setError(''); setMessage('');
    try { const result = await api('/openai-compatible/check', 'POST', {}); if (result.ok) setMessage(`接続できました（モデル${result.models}件）。`); else setError(result.message); }
    catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  return <div role="group" aria-label="OpenAI互換API">
    <div className="form-section-label">OpenAI互換API（公式API・推奨）</div>
    <div className="connection-row"><strong>接続の状態</strong><span className="connection-state"><span className="status-dot" />{!status ? '確認中' : status.url ? `APIキー: ${status.keyConfigured ? '設定済み' : '未設定'}` : '未設定'}</span></div>
    <p className="field-hint">APIキーで公式に提供されているChat Completions APIへ接続します。OpenAI（https://api.openai.com/v1）、OpenRouter（https://openrouter.ai/api/v1）、同じPCのLM Studio（http://127.0.0.1:1234/v1）などを使えます。API利用料はChatGPTのサブスクとは別に、接続先から請求されます。</p>
    <label className="field"><span>接続先URL</span><input type="url" value={url} disabled={busy} onChange={event => { setUrl(event.target.value); setMessage(''); }} placeholder="https://api.openai.com/v1" autoComplete="off" /><small>httpsが必要です。httpは同じPC（localhost・127.0.0.1）の場合だけ使えます。</small></label>
    <label className="field"><span>APIキー</span><input type="password" value={apiKey} disabled={busy || status?.available === false} onChange={event => { setApiKey(event.target.value); setMessage(''); }} placeholder={status?.keyConfigured ? '設定済み（変更する場合だけ入力）' : '未設定'} autoComplete="new-password" spellCheck={false} /><small>保存したキーは画面に表示しません。保存時のURLと同じ接続先にだけ送ります。</small></label>
    <label className="field narrow-field"><span>同時に送る依頼の数</span><div className="input-with-unit"><input type="number" min="1" max="8" value={parallel} disabled={busy} onChange={event => setParallel(event.target.value)} /><span>件</span></div><small>接続先の利用制限に合わせてください。</small></label>
    <div className="inline-actions">
      <button type="button" className="button primary" disabled={busy || !changed || !(Number(parallel) >= 1 && Number(parallel) <= 8)} onClick={save}>接続設定を保存</button>
      <button type="button" className="button secondary" disabled={busy || !status?.url} onClick={check}>接続を確認</button>
      <button type="button" className="button subtle" disabled={busy || !status?.keyConfigured} onClick={() => run(() => api('/openai-compatible/key', 'DELETE', {}), 'APIキーを削除しました。')}>APIキーを削除</button>
    </div>
    <p className="field-hint">接続の確認ではモデル一覧だけを取得し、応答の生成（課金対象）は行いません。</p>
    {error ? <p className="field-error" role="alert">{error}</p> : null}
    <p className="saved-inline" role="status">{busy ? '接続先を確認しています…' : message}</p>
  </div>;
}
