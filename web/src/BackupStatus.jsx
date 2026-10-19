import { useEffect, useState } from 'react';
import { api } from './api.js';
import { ClockIcon } from './icons.jsx';
import { locale, serverText, t } from './i18n.js';
import { rich } from './i18n-react.js';

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
  const time = value => new Date(value).toLocaleString(locale());
  return <>
    <div className="backup-status"><ClockIcon size={24} /><div><strong>{latest ? t('settings.backupLastSaved', { time: time(latest.created_at) }) : status ? t('settings.backupNone') : t('settings.backupChecking')}</strong><p>{status?.available ? t(enabled ? 'settings.backupSummaryOn' : 'settings.backupSummaryOff', { count: status.items.length }) : t('settings.backupConnecting')}</p></div></div>
    <p className="field-hint">{t('settings.backupLateHint')}</p>
    {status?.failed_at ? <p className="field-hint">{status.next_attempt_at ? t('settings.backupFailedRetryAt', { failed: time(status.failed_at), next: time(status.next_attempt_at) }) : t('settings.backupFailedRetryNow', { failed: time(status.failed_at) })}</p> : null}
    {error || status?.error ? <p className="field-error" role="alert">{serverText(error || status.error)}</p> : null}
    <button type="button" className="button secondary" disabled={busy || !status?.available} onClick={create}>{busy ? t('common.saving') : t('settings.backupNow')}</button>
    <p className="field-hint">{t('settings.backupRestoreHint1')}<br />{t('settings.backupRestoreHint2')}<br />{rich('settings.backupRestoreHint3', { command: <code>{t('settings.backupRestoreCommand')}</code>, origin: <code>--origin</code>, port: <code>--port</code> })}<br />{t('settings.backupRestoreHint4')}</p>
  </>;
}
