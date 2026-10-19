import {formatNumber,serverText,t} from './i18n.js';

export const shortWork = text => {const line=String(text||t('today.untitledWork')).split(/\n/)[0];return line.length>64?line.slice(0,64)+'…':line;};
const STATE_KEYS={running:'stateRunning',queued:'stateQueued',waiting_child:'stateWaitingChild',waiting_user:'stateWaitingUser',waiting_provider:'stateWaitingProvider',completed:'stateCompleted',cancelled:'stateCancelled',failed:'stateFailed'};
// 進み具合の label はサーバーが日本語で書くので、今の言語に読み替えてから出す。
export const workLabel=(task,paused=false)=>paused&&!['completed','cancelled','failed'].includes(task.state)?t('today.workPaused'):serverText(task.progress?.label)||(Object.hasOwn(STATE_KEYS,task.state)?t('today.'+STATE_KEYS[task.state]):t('today.stateUnknown'));
export function memberWork(jobs,paused=false,sleeping=false) {
 const updated=task=>task.progress?.last_activity_at??task.updated_at??task.created_at??0;
 const open=jobs.filter(t=>!['completed','cancelled','failed'].includes(t.state)).sort((a,b)=>updated(b)-updated(a));
 const running=open.filter(t=>t.state==='running'&&!t.paused&&!paused&&!sleeping);
 const waiting=open.filter(t=>!running.includes(t)&&!t.paused&&!paused&&!sleeping);
 const stopped=open.filter(t=>t.paused||paused||sleeping);
 const current=running[0]||waiting[0]||stopped[0];
 return {jobs:[...running,...waiting,...stopped],kind:sleeping?'sleeping':running.length?'running':waiting.length?'waiting':stopped.length||paused?'paused':'idle',activity:sleeping?t('today.botDormant'):current?(open.length>1?t('today.workAndMore',{work:workLabel(current,paused||sleeping),count:open.length-1}):workLabel(current,paused||sleeping)):t('today.botIdle')};
}
export function presenceCounts(members) {
 const keys={running:'presenceRunning',waiting:'presenceWaiting',paused:'presencePaused',idle:'presenceIdle',sleeping:'presenceSleeping'};
 return Object.entries(keys).map(([kind,key])=>{const count=members.filter(m=>m.workKind===kind).length;return count?t('today.'+key,{count}):'';}).filter(Boolean).join(t('today.listSeparator'));
}

export function workCounts(tasks,paused=false) {
 const counts={running:0,waiting:0,paused:0,ended:0};
 for(const task of tasks){const terminal=['completed','cancelled','failed'].includes(task.state)||['done','canceled','failed'].includes(task.status);const kind=terminal?'ended':paused||task.paused||task.status==='paused'?'paused':task.state==='running'?'running':'waiting';counts[kind]++;}
 return Object.entries({running:'countRunning',waiting:'countWaiting',paused:'countPaused',ended:'countEnded'}).filter(([kind])=>counts[kind]).map(([kind,key])=>t('today.'+key,{count:counts[kind]})).join(t('today.listSeparator'));
}
/** モデルに送った回数と量。接続先が報告した数を使い、報告のない回の入力は送る前の見積もりで数える。 */
export function usageSummary(runs) {
 const list=Array.isArray(runs)?runs:[];let input=0,output=0,estimated=0;
 for(const run of list){
  if(Number.isFinite(run.input_tokens))input+=run.input_tokens;else{input+=Number(run.estimated_input_tokens)||0;estimated++;}
  if(Number.isFinite(run.output_tokens))output+=run.output_tokens;
 }
 return {calls:list.length,input,output,estimated};
}
/** 使用量を1行で読む。回数がなければ空。 */
export const usageLine=usage=>usage?.calls?t('today.usageLine',{count:usage.calls,calls:formatNumber(usage.calls),input:formatNumber(usage.input),output:formatNumber(usage.output)}):'';
