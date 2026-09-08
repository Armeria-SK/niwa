import { useEffect, useState } from 'react';
import { Avatar } from './components.jsx';
import { ChevronDownIcon } from './icons.jsx';
import './AutonomyStatus.css';
import { api } from './api.js';

export function AutonomyStatus({ members = [] }) {
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
  const labels = { '予定なしの起動機会を待機中': '順番待ち', '予定なしの定期判定から起動': '活動を開始', '前回の活動を継続・待機中': '取り組みを継続中', '活動完了後の間隔': 'ひと休み', '失敗後の待機': '再試行待ち', '既存の仕事を優先': '依頼を優先', '利用できる共有会話がありません': '共有会話の準備待ち' };
  const nextTime = value => {
    if (!value) return '';
    const date = new Date(value), today = new Date().toDateString() === date.toDateString();
    return `${today ? '' : date.toLocaleDateString('ja-JP', { month:'numeric', day:'numeric' }) + ' '}${date.toLocaleTimeString('ja-JP', { hour:'2-digit', minute:'2-digit' })}頃に判定`;
  };
  return <section className="autonomy-status" aria-label="自発活動の起動状況">
    <div className="autonomy-status-heading"><h3>自発活動の起動状況</h3><span>保存済みの設定</span></div>
    <p className="autonomy-status-hint">それぞれのペースで活動し、必要がなければ休みます。</p>
    <div className="autonomy-status-list">{rows.map(row => <details className="autonomy-member" key={row.agent_id}>
      <summary><Avatar member={members.find(member => member.id === row.agent_id)} size={30} motion="none" />
        <span className="autonomy-member-name">{row.name}</span>
        <span className="autonomy-member-state"><span>{labels[row.reason] || row.reason}</span>{row.next_at ? <time dateTime={new Date(row.next_at).toISOString()}>{nextTime(row.next_at)}</time> : null}</span>
        <ChevronDownIcon className="autonomy-member-chevron" size={14} />
      </summary>
      <div className="autonomy-member-detail"><p>{row.reason}</p><p>{row.next_at ? `次の判定：${new Date(row.next_at).toLocaleString('ja-JP')}` : '停止や待ち条件が解消した後に、改めて判定します。'}</p></div>
    </details>)}</div>
    {!rows.length && !error ? <p className="autonomy-status-hint">起動状況を確認しています…</p> : null}
    {error ? <p className="autonomy-status-error" role="status">更新できませんでした。{error}</p> : null}
  </section>;
}
