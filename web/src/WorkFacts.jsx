import {deadlineLabel,validTime} from './deadline.js';
import {shortWork} from './work-display.js';
const time=value=>validTime(value)?new Date(value).toLocaleString('ja-JP'):'未確認';
export function WorkFacts({task,compact=false}) {
 const progress=task.progress;
 return <div className="work-facts">
  {progress?.waiting_tasks?.map(wait=><p key={wait.id}>待ち先：{wait.name} — {shortWork(wait.prompt)}</p>)}
  {!progress?.waiting_tasks?.length&&progress?.waiting_for?.length?<p>待ち先：{progress.waiting_for.join('・')}</p>:null}
  {!compact&&task.reason?<p>待機理由：{task.reason}</p>:null}
  {progress?.retry_at?<p>再確認予定：{time(progress.retry_at)}</p>:!compact&&task.state?.startsWith('waiting')?<p>自動再開の予定は設定されていません。</p>:null}
  {!compact&&<><p>最終活動・状態更新：{progress?.last_activity_at||task.updated_at?time(progress?.last_activity_at||task.updated_at):'未確認'}</p><p>{deadlineLabel(task.deadline_at)}</p>
   {['approval','user_input','authentication','invalid_output'].includes(progress?.kind)?<p>必要な対応：{({approval:'承認待ちの操作内容を確認してください。',user_input:task.reason||'質問内容を確認してください。',authentication:'設定から接続の認証状態を確認してください。',invalid_output:'応答形式の問題です。接続障害とは限りません。'})[progress.kind]}</p>:null}</>}
 </div>;
}
