import { useState } from 'react';
import { api } from './api.js';

export function Login({ onLogin, loading }) {
  const [key, setKey] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  return <main className="login-page" data-theme="garden"><form className="form-stack" onSubmit={async e => {
    e.preventDefault(); setBusy(true); setError('');
    try { await api('/login', 'POST', { key }); setKey(''); onLogin(); } catch (error) { setError(error.message); } finally { setBusy(false); }
  }}><h1>おかえりなさい</h1>
    <label className="field"><span>管理キー</span><input type="password" autoComplete="current-password" value={key} onChange={e => setKey(e.target.value)} required disabled={loading || busy} /></label>
    <p className="field-hint login-key-hint">初回の管理キーは、製品フォルダーの secrets/admin-key に保存されています。</p>
    {error ? <p role="alert">{error}</p> : null}<button className="button primary" disabled={loading || busy || !key}>{loading ? '接続を確認中…' : busy ? 'ログイン中…' : '庭を開く'}</button>
  </form></main>;
}
