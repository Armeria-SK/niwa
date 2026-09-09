export const shortWork = text => {const line=String(text||'名称未設定の仕事').split(/\n/)[0];return line.length>64?line.slice(0,64)+'…':line;};
export const workLabel=(task,paused=false)=>paused&&!['completed','cancelled','failed'].includes(task.state)?'停止中':task.progress?.label||({running:'作業中',queued:'順番待ち',waiting_child:'仲間の結果待ち',waiting_user:'対応待ち（理由未確認）',waiting_provider:'理由未確認の待機',completed:'完了',cancelled:'中止',failed:'失敗'})[task.state]||'状態未確認';
export function memberWork(jobs,paused=false,sleeping=false) {
 const open=jobs.filter(t=>!['completed','cancelled','failed'].includes(t.state));
 const running=open.filter(t=>t.state==='running'&&!t.paused&&!paused&&!sleeping);
 const waiting=open.filter(t=>!running.includes(t)&&!t.paused&&!paused&&!sleeping);
 const stopped=open.filter(t=>t.paused||paused||sleeping);
 const current=running[0]||waiting[0]||stopped[0];
 return {jobs:[...running,...waiting,...stopped],kind:sleeping?'sleeping':running.length?'running':waiting.length?'waiting':stopped.length||paused?'paused':'idle',activity:sleeping?'休眠中':current?workLabel(current,paused||sleeping)+(open.length>1?`・ほか${open.length-1}件`:''):'返答待機'};
}
export function presenceCounts(members) {
 const labels={running:'実行中',waiting:'待機',paused:'停止',idle:'返答待機',sleeping:'休眠'};
 return Object.entries(labels).map(([kind,label])=>{const count=members.filter(m=>m.workKind===kind).length;return count?`${label}${count}人`:'';}).filter(Boolean).join('・');
}
