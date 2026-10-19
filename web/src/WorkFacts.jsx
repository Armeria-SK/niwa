import {deadlineLabel,validTime} from './deadline.js';
import {locale,serverText,t} from './i18n.js';
import {shortWork} from './work-display.js';
const time=value=>validTime(value)?new Date(value).toLocaleString(locale()):t('today.unknownTime');
// 待っている理由（task.reason）はサーバーが日本語で書くので、今の言語に読み替えてから出す。
const ACTIONS={approval:'actionApproval',user_input:'actionUserInput',authentication:'actionAuthentication',invalid_output:'actionInvalidOutput'};
export function WorkFacts({task,compact=false}) {
 const progress=task.progress;
 const action=kind=>kind==='user_input'&&task.reason?serverText(task.reason):t('today.'+ACTIONS[kind]);
 return <div className="work-facts">
  {progress?.waiting_tasks?.map(wait=><p key={wait.id}>{t('today.waitingOnTask',{name:wait.name,work:shortWork(wait.prompt)})}</p>)}
  {!progress?.waiting_tasks?.length&&progress?.waiting_for?.length?<p>{t('today.waitingOn',{names:progress.waiting_for.join(t('today.listSeparator'))})}</p>:null}
  {!compact&&task.reason?<p>{t('today.waitReason',{reason:serverText(task.reason)})}</p>:null}
  {progress?.retry_at?<p>{t('today.retryAt',{time:time(progress.retry_at)})}</p>:!compact&&task.state?.startsWith('waiting')?<p>{t('today.noAutoResume')}</p>:null}
  {!compact&&<><p>{t('today.lastActivity',{time:progress?.last_activity_at||task.updated_at?time(progress?.last_activity_at||task.updated_at):t('today.unknownTime')})}</p><p>{deadlineLabel(task.deadline_at)}</p>
   {Object.hasOwn(ACTIONS,progress?.kind??'')?<p>{t('today.requiredAction',{action:action(progress.kind)})}</p>:null}</>}
 </div>;
}
