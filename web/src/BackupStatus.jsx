import { useEffect, useState } from 'react';
import { api } from './api.js';
import { ClockIcon } from './icons.jsx';

export function BackupStatus({ enabled }) {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { let active = true; api('/backups').then(value => { if (active) setStatus(value); }).catch(error => { if (active) setError(error.message); }); return () => { active = false; }; }, []);
  async function create() {
    setBusy(true); setError('');
    try { await api('/backups', 'POST', {}); setStatus(await api('/backups')); }
    catch (error) { setError(error.message); } finally { setBusy(false); }
  }
  const latest = status?.items[0];
  return <>
    <div className="backup-status"><ClockIcon size={24} /><div><strong>{latest ? `最後の保存: ${new Date(latest.created_at).toLocaleString('ja-JP')}` : status ? 'まだバックアップはありません' : '保存状況を確認しています…'}</strong><p>{status?.available ? `${status.items.length}件の保存履歴があります。${enabled ? '毎日のバックアップはオンです。当日の保存があれば重ねて保存しません。' : '毎日のバックアップはオフです。'}` : 'バックアップの接続を確認しています。'}</p></div></div>
    <p className="field-hint">毎日のバックアップがオンで、予定時刻を過ぎて起動した場合は、その日にまだ保存されていなければ実行します。</p>
    {error || status?.error ? <p className="field-error" role="alert">{error || status.error}</p> : null}
    <button type="button" className="button secondary" disabled={busy || !status?.available} onClick={create}>{busy ? '保存しています…' : '今すぐバックアップ'}</button>
    <p className="field-hint">認証情報と共有作業フォルダーは含みません。復元の操作は準備中です。</p>
  </>;
}
