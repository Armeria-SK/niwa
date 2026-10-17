import { useEffect, useState } from 'react';
import { api } from './api.js';
import { notifyAnthropicChanged } from './anthropicModels.js';

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
    finally { setBusy(false); notifyAnthropicChanged(); }
  }
  const trimmed = apiKey.trim();
  const changed = Number(parallel) !== status?.parallel || trimmed !== '';
  const unusualKey = trimmed !== '' && !trimmed.startsWith('sk-ant-');
  function save() {
    const body = { ...(Number(parallel) !== status?.parallel ? { parallel: Number(parallel) } : {}), ...(trimmed ? { apiKey: trimmed } : {}) };
    return run(async () => { const next = await api('/anthropic', 'PUT', body); setApiKey(''); return next; }, trimmed ? 'APIキーを保存しました。モデル一覧を更新しています。' : '接続設定を保存しました。');
  }
  async function check() {
    setBusy(true); setError(''); setMessage('');
    try { const result = await api('/anthropic/check', 'POST', {}); if (result.ok) setMessage(`接続できました（モデル${result.models}件）。`); else setError(result.message); }
    catch (failure) { setError(failure.message); }
    finally { setBusy(false); notifyAnthropicChanged(); }
  }
  return <div role="group" aria-label="Claude（Anthropic API）">
    <div className="form-section-label">Claude（Anthropic API）</div>
    <div className="connection-row"><strong>接続の状態</strong><span className="connection-state"><span className="status-dot" />{!status ? '確認中' : `APIキー: ${status.keyConfigured ? '設定済み' : '未設定'}`}</span></div>
    <p className="field-hint">Claude ConsoleのAPIキーで、AnthropicのAPI（api.anthropic.com）へ接続します。ClaudeのMax・Teamプランでは、claude.aiの「設定」→「請求」からConsoleの組織を連携すると、毎月のAPIクレジットが付きます。その組織で作ったAPIキーを入力してください。クレジットを超えた利用は、Consoleの組織に請求されます。Claude Codeを手元で対話的に使う分は、このクレジットの対象外です。</p>
    <label className="field"><span>APIキー</span><input type="password" value={apiKey} disabled={busy || status?.available === false} onChange={event => { setApiKey(event.target.value); setMessage(''); }} placeholder={status?.keyConfigured ? '設定済み（変更する場合だけ入力）' : 'sk-ant-…'} autoComplete="new-password" spellCheck={false} /><small>保存したキーは画面に表示しません。AnthropicのAPI以外には送りません。</small></label>
    {unusualKey ? <p className="field-hint" role="status">ClaudeのAPIキーは通常「sk-ant-」で始まります。入力内容を確認してください（このまま保存もできます）。</p> : null}
    <label className="field narrow-field"><span>同時に送る依頼の数</span><div className="input-with-unit"><input type="number" min="1" max="8" value={parallel} disabled={busy} onChange={event => setParallel(event.target.value)} /><span>件</span></div><small>組織の利用制限に合わせてください。</small></label>
    <div className="inline-actions">
      <button type="button" className="button primary" disabled={busy || !changed || !(Number(parallel) >= 1 && Number(parallel) <= 8)} onClick={save}>接続設定を保存</button>
      <button type="button" className="button secondary" disabled={busy || !status?.keyConfigured} onClick={check}>接続を確認</button>
      <button type="button" className="button subtle" disabled={busy || !status?.keyConfigured} onClick={() => run(() => api('/anthropic/key', 'DELETE', {}), 'APIキーを削除しました。')}>キーを削除</button>
    </div>
    <p className="field-hint">接続の確認ではモデル一覧だけを取得し、応答の生成（課金対象）は行いません。安全上の理由で応答を断られた場合は、対応するモデルではAnthropicが勧める別のモデルで自動的にやり直します（そのモデルの料金がかかります）。</p>
    {error ? <p className="field-error" role="alert">{error}</p> : null}
    <p className="saved-inline" role="status">{busy ? '接続先を確認しています…' : message}</p>
  </div>;
}
