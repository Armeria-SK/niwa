import {useEffect,useState} from 'react';
import {api} from './api.js';
import {Modal} from './components.jsx';
import './CoordinationBoard.css';
const states={queued:'順番待ち',running:'作業中',waiting_child:'仲間の結果待ち',waiting_user:'対応待ち',waiting_provider:'接続待ち',completed:'完了',failed:'失敗',cancelled:'中止'};
const date=value=>value && value<8_640_000_000_000_000 ? new Date(value).toLocaleString('ja-JP') : '未設定';
export function CoordinationBoard({roomId,members,onClose,onArtifact}) {
 const [data,setData]=useState(null),[error,setError]=useState(''),[showDone,setShowDone]=useState(false),[busy,setBusy]=useState(false),[answers,setAnswers]=useState({});
 async function resume(task) {
  if(busy)return;setBusy(true);setError('');
  try {await api(`/tasks/${task.id}/resume`,'POST',{answer:answers[task.id] || undefined});setData(await api(`/rooms/${roomId}/coordination`));}
  catch(e){setError(e.message);}finally{setBusy(false);}
 }
 useEffect(()=>{
  let active=true,timer;
  const load=async()=>{try{const next=await api(`/rooms/${roomId}/coordination`);if(active){setData(next);setError('');}}catch(e){if(active)setError(e.message);}finally{if(active)timer=setTimeout(load,2000);}};
  void load();return()=>{active=false;clearTimeout(timer);};
 },[roomId]);
 const tasks=data?.tasks || [],byId=new Map(tasks.map(task=>[task.id,task]));
 const name=id=>id==='administrator'?'管理者':members[id]?.name || '未指定';
 const visible=tasks.filter(task=>!task.acknowledgment_only && (showDone || !['completed','cancelled'].includes(task.state)));
 return <Modal title="この会話の共同作業" onClose={onClose} className="coordination-modal"><div className="modal-body form-stack">
  <p>この会話に属する依頼と受け渡しの状況です。直近・進行中の最大100件を表示します。</p>
  {data?.digest ? <section className="coordination-task" aria-label="進捗ダイジェスト"><strong>直近24時間の実績と現在の待ち状況</strong>
   <p>保存した版（改訂含む）{data.digest.artifact_count}件 · 承認待ち {data.digest.approvals}件 · ブロッカー {data.digest.blockers}件 · 期限超過 {data.digest.overdue}件</p>
   {data.digest.artifacts.map(item=><div key={item.id}><button className="text-button" onClick={()=>onArtifact(item.id)}>{item.name}（第{item.version}版）</button> · {name(item.author_id)}</div>)}
   <p>売上・入金・顧客接点：未確認</p>
   {data.digest.operations.length ? data.digest.operations.map(item=><p key={item.tool_name}>{({browser_form_submit:'フォーム送信',browser_request_submit:'ページ通信',x_post:'X投稿'})[item.tool_name]}：結果記録 {item.recorded}件 / 結果不明 {item.unknown}件</p>) : <p>この期間の分類済み送信記録はありません。</p>}
   <p className="muted">{data.digest.operation_note}</p>
  </section> : null}
  <label><input type="checkbox" checked={showDone} onChange={e=>setShowDone(e.target.checked)}/> 完了・中止した依頼も表示</label>
  {error ? <p role="alert">{error}</p> : null}{!data && !error ? <p role="status">読み込み中…</p> : null}
  {data && !visible.length ? <p>表示する依頼はありません。</p> : null}
  {visible.map(task=>{
   const children=tasks.filter(child=>child.parent_id===task.id && !['completed','cancelled','failed'].includes(child.state));
   return <article className="coordination-task" key={task.id}>
    <div className="coordination-meta"><strong>{name(task.agent_id)}</strong><span>{task.paused?'停止中':task.approval_pending?'承認待ち':states[task.state]}</span></div>
    <p>{task.prompt}</p>
    <dl><dt>依頼元</dt><dd>{name(task.requester_id)}{task.parent_id ? ` · 親の依頼：${byId.get(task.parent_id)?.prompt || '以前の依頼'}` : ''}</dd>
     <dt>対応待ち</dt><dd>{task.waiting_for ? name(task.waiting_for) : children.length ? [...new Set(children.map(child=>name(child.agent_id)))].join('・') : task.wait_reason || 'なし'}</dd>
     <dt>次に返す相手</dt><dd>{name(task.next_agent_id || task.requester_id)}</dd>
     {task.blocker ? <><dt>阻害理由</dt><dd>{task.blocker}</dd></> : null}
     <dt>完成条件</dt><dd>{task.completion_condition || '未設定'}</dd><dt>停止条件</dt><dd>{task.stop_condition || '未設定'}</dd>
     <dt>開始 / 期限</dt><dd>{date(task.started_at)} / {date(task.deadline_at)}</dd>
     <dt>成果物の記録</dt><dd>{task.artifact_id ? <button className="text-button" onClick={()=>onArtifact(task.artifact_id)}>最新の成果物を見る（{date(task.last_artifact_at)}）</button> : 'この依頼に紐づく成果物はまだありません'}</dd>
     <dt>外部操作</dt><dd>{task.external_operations}件の実行記録（成功とは限りません）</dd>
    </dl>
    {task.approval_pending ? <p>外部操作の承認は「活動」の「承認待ち」で内容を確認してください。</p> : (task.paused || ['waiting_user','waiting_provider'].includes(task.state)) ? <form className="form-stack" onSubmit={e=>{e.preventDefault();void resume(task);}}><label className="field"><span>対応内容・追加指示</span><textarea rows={2} maxLength={2000} value={answers[task.id] || ''} onChange={e=>setAnswers(current=>({...current,[task.id]:e.target.value}))}/></label><button className="button secondary" disabled={busy}>対応して再開</button></form> : null}
   </article>;
  })}
 </div></Modal>;
}
