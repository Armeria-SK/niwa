import { useEffect, useRef, useState } from 'react';
import { api } from './api.js';

export function XConnection() {
  const [status, setStatus] = useState(null), [url, setUrl] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const working = useRef(false);
  useEffect(() => {
    let active = true, timer;
    async function refresh() {
      try {
        const next = await api('/x'); if (!active) return; setStatus(next); setError('');
        if (next.pending) timer = setTimeout(refresh, 2000);
      } catch (failure) { if (active) setError(failure.message); }
    }
    void refresh(); return () => { active = false; clearTimeout(timer); };
  }, [status?.pending, reload]);
  async function act(action) {
    if (working.current) return; working.current = true; setBusy(true); setError('');
    try {
      const result = await api(`/x/${action}`, 'POST', {}); setUrl(result.url ?? ''); setStatus(await api('/x'));
    } catch (failure) { setError(failure.message); }
    finally { working.current = false; setBusy(false); }
  }
  return <>
    <div className="form-section-label">共有Xアカウント</div>
    <div className="connection-row"><strong>X</strong><span className="connection-state">{status?.pending ? 'ログインを待っています' : status?.needs_authorization ? '再接続が必要です' : status?.connected ? '認証情報を保存済み' : '未接続'}</span></div>
    <p className="field-hint">接続すると、Botが共有アカウントで投稿・返信できます。</p>
    {!status?.available && status ? <p className="field-hint">共有アカウントの接続設定が必要です。</p> : null}
    <div className="inline-actions">
      {status?.pending && url ? <a className="button primary" href={url} target="_blank" rel="noreferrer">Xで許可する</a> : null}
      {status?.needs_authorization && !status.pending ? <button type="button" className="button secondary" disabled={busy} onClick={() => act('login')}>Xに再接続</button> : null}
      <button type="button" className="button secondary" disabled={busy || !status?.available} onClick={() => act(status?.pending || status?.connected ? 'logout' : 'login')}>{status?.pending ? 'X接続を中止' : status?.connected ? 'X接続を解除' : 'Xで接続'}</button>
    </div>
    {error ? <><p className="field-error" role="alert">{error}</p><button type="button" className="button subtle" disabled={busy} onClick={() => setReload(value => value + 1)}>Xの状態を再確認</button></> : null}
  </>;
}
