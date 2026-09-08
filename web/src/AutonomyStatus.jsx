import { useEffect, useState } from 'react';
import { api } from './api.js';

export function AutonomyStatus() {
  const [rows, setRows] = useState([]), [error, setError] = useState('');
  useEffect(() => {
    let active = true, timer;
    async function load() {
      try { const data = await api('/autonomy'); if (active) { setRows(data); setError(''); } }
      catch (e) { if (active) setError(e.message); }
      finally { if (active) timer = setTimeout(load, 5000); }
    }
    void load(); return () => { active = false; clearTimeout(timer); };
  }, []);
  return <details><summary>自発活動の起動状況</summary>
    <p className="field-hint">予定とは別に、順番に起動を判定します。待機中はモデルを呼びません。</p>
    {rows.map(row => <p key={row.agent_id}>{row.name}：{row.reason}<br />
      <small>{row.next_at ? `次の判定：${new Date(row.next_at).toLocaleString('ja-JP')}` : '再判定は停止・待機の解除後'}</small></p>)}
    {error ? <p role="status">{error}</p> : null}
  </details>;
}
