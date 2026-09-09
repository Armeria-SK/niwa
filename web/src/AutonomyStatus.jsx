import { useEffect, useState } from 'react';
import { Avatar } from './components.jsx';
import { ChevronDownIcon } from './icons.jsx';
import './AutonomyStatus.css';
import { api } from './api.js';

export function AutonomyStatus({ members = [] }) {
  const [rows, setRows] = useState([]), [error, setError] = useState('');
  const [initiatives,setInitiatives]=useState(null),[saving,setSaving]=useState(false);
  useEffect(() => {
    let active = true, timer;
    async function load() {
      try { const [data,work] = await Promise.all([api('/autonomy'),api('/initiatives')]); if (active) { setRows(data);setInitiatives(work); setError(''); } }
      catch (e) { if (active) setError(e.message); }
      finally { if (active) timer = setTimeout(load, 5000); }
    }
    void load(); return () => { active = false; clearTimeout(timer); };
  }, []);
  async function change(path,body){setSaving(true);try{await api(path,'PATCH',body);setInitiatives(await api('/initiatives'));setError('');}catch(e){setError(e.message);}finally{setSaving(false);}}
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
      <div className="autonomy-member-detail"><p>{row.reason}</p><p>この時間枠のモデル呼出し：{row.model_calls} / 24（文脈整理・委任を含む）</p><p>{row.next_at ? `次の判定：${new Date(row.next_at).toLocaleString('ja-JP')}` : '停止や待ち条件が解消した後に、改めて判定します。'}</p></div>
    </details>)}</div>
    {initiatives ? <details className="initiative-section"><summary>継続する取り組み <span>{initiatives.items.length}件</span></summary>
      <label className="autonomy-status-hint"><input type="checkbox" checked={initiatives.enabled} disabled={saving} onChange={e=>change('/initiatives',{enabled:e.target.checked})} /> 継続記録を自発活動に利用する</label>
      <p className="autonomy-status-hint">目的と次の行動を引き継ぎます。既存の保留操作や承認は変更しません。停止した仕事の再開は、仕事ごとに確認します。</p>
      {initiatives.items.map(item=><details className="initiative-item" key={item.id}><summary>{item.body.purpose}<span>{({active:'見直し待ち',resting:'休息中',paused:'停止中',completed:'終了'})[item.state]}</span></summary>
        <div className="initiative-detail"><p>担当：{members.find(m=>m.id===item.owner_id)?.name || '削除済みメンバー'}</p><p>取り組む理由：{item.body.reason}</p><p>完成条件：{item.body.completion}</p><p>次の行動：{item.body.next_action}</p><p>試した方法：{item.body.method}</p><p>結果：{item.body.last_result || '未記録'}</p>
          {item.waits?.map(wait=><p key={wait.id}>現在の待機：{wait.reason} — {wait.wait_reason}</p>)}<p>保存した見直し条件：{item.body.wait.detail || 'なし'}</p>
          <p>判定の理由：{item.review_reason}</p><p>見直し：{new Date(item.review_at).toLocaleString('ja-JP')}</p><p>関連する仕事：{item.tasks.length}件／根拠付きの結論：{item.evidence.length}件（品質の自動評価ではありません）</p>
          {item.state!=='completed'?<button type="button" disabled={saving} onClick={()=>change('/initiatives/'+item.id,{paused:item.state!=='paused',revision:item.revision})}>{item.state==='paused'?'見直しを再開':'取り組みを停止'}</button>:null}
        </div></details>)}
      {!initiatives.items.length?<p className="autonomy-status-hint">継続する取り組みはまだありません。</p>:null}
    </details>:null}
    {!rows.length && !error ? <p className="autonomy-status-hint">起動状況を確認しています…</p> : null}
    {error ? <p className="autonomy-status-error" role="status">更新できませんでした。{error}</p> : null}
  </section>;
}
