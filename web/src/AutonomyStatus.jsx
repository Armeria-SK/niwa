import { useEffect, useRef, useState } from 'react';
import { Avatar, Switch } from './components.jsx';
import { ChevronDownIcon } from './icons.jsx';
import './AutonomyStatus.css';
import { api } from './api.js';
import { locale, serverText, t } from './i18n.js';

// サーバーが書く起動の理由のうち、短い言い方で見せるもの（値は文言の名前）。ほかの理由はサーバーの文をそのまま訳す。
const REASON_LABELS = { '予定なしの起動機会を待機中': 'autonomyReasonQueued', '予定なしの定期判定から起動': 'autonomyReasonStarted', '前回の活動を継続・待機中': 'autonomyReasonContinuing', '活動完了後の間隔': 'autonomyReasonBreak', '失敗後の待機': 'autonomyReasonRetry', '既存の仕事を優先': 'autonomyReasonRequests', '利用できる共有会話がありません': 'autonomyReasonNoRoom' };
const reasonLabel = reason => REASON_LABELS[reason] ? t(`settings.${REASON_LABELS[reason]}`) : serverText(reason);
const INITIATIVE_STATES = { active: 'initiativeActive', resting: 'initiativeResting', paused: 'initiativePaused', completed: 'initiativeCompleted' };

export function AutonomyStatus({ members = [] }) {
  const epoch=useRef(0),pending=useRef(false);
  const [savingAgent,setSavingAgent]=useState(null),[saveError,setSaveError]=useState('');
  const [rows, setRows] = useState([]), [error, setError] = useState('');
  const [initiatives,setInitiatives]=useState(null),[saving,setSaving]=useState(false);
  useEffect(() => {
    let active = true, timer;
    async function load() {
      const version=epoch.current;
      try { const [data,work] = await Promise.all([api('/autonomy'),api('/initiatives')]); if (active && version===epoch.current && !pending.current) { setRows(data);setInitiatives(work); setError(''); } }
      catch (e) { if (active) setError(e.message); }
      finally { if (active) timer = setTimeout(load, 5000); }
    }
    void load(); return () => { active = false; clearTimeout(timer); };
  }, []);
  async function change(path,body){setSaving(true);try{await api(path,'PATCH',body);setInitiatives(await api('/initiatives'));setError('');}catch(e){setError(e.message);}finally{setSaving(false);}}
  async function setAgent(id,enabled){
    pending.current=true;epoch.current++;setSavingAgent(id);setSaveError('');
    try{await api(`/agents/${id}/autonomy`,'PATCH',{enabled});setRows(await api('/autonomy'));}
    catch(e){setSaveError(e.message);}
    finally{epoch.current++;pending.current=false;setSavingAgent(null);}
  }
  const nextTime = value => {
    if (!value) return '';
    const date = new Date(value), today = new Date().toDateString() === date.toDateString();
    return t('settings.autonomyNextCheck', { time: `${today ? '' : date.toLocaleDateString(locale(), { month:'numeric', day:'numeric' }) + ' '}${date.toLocaleTimeString(locale(), { hour:'2-digit', minute:'2-digit' })}` });
  };
  return <section className="autonomy-status" aria-label={t('settings.autonomyTitle')}>
    <div className="autonomy-status-heading"><h3>{t('settings.autonomyTitle')}</h3><span>{t('settings.autonomySaved')}</span></div>
    <p className="autonomy-status-hint">{t('settings.autonomyHint1')}<br />{t('settings.autonomyHint2')}</p>
    <div className="autonomy-status-list">{rows.map(row => <div className="autonomy-member-row" key={row.agent_id}><details className="autonomy-member">
      <summary><Avatar member={members.find(member => member.id === row.agent_id)} size={30} motion="none" />
        <span className="autonomy-member-name">{row.name}</span>
        <span className="autonomy-member-state"><span>{reasonLabel(row.reason)}</span>{row.next_at ? <time dateTime={new Date(row.next_at).toISOString()}>{nextTime(row.next_at)}</time> : null}</span>
        <ChevronDownIcon className="autonomy-member-chevron" size={14} />
      </summary>
      <div className="autonomy-member-detail"><p>{serverText(row.reason)}</p><p>{t('settings.autonomyModelCalls', { calls: row.model_calls })}</p><p>{row.next_at ? t('settings.autonomyNextAt', { time: new Date(row.next_at).toLocaleString(locale()) }) : t('settings.autonomyNoNext')}</p></div>
    </details><div className="autonomy-member-toggle"><Switch label={t('settings.autonomyAllowBot', { name: row.name })} checked={row.enabled===true} disabled={savingAgent!==null||typeof row.enabled!=='boolean'} onChange={value=>setAgent(row.agent_id,value)} />{savingAgent===row.agent_id?<small role="status">{t('settings.autonomySaving')}</small>:null}</div></div>)}</div>
    {saveError?<p className="autonomy-status-error" role="alert">{t('settings.autonomySaveFailed', { error: serverText(saveError) })}</p>:null}
    {initiatives ? <details className="initiative-section"><summary>{t('settings.initiativesTitle')} <span>{t('common.items', { count: initiatives.items.length })}</span></summary>
      <label className="autonomy-status-hint"><input type="checkbox" checked={initiatives.enabled} disabled={saving} onChange={e=>change('/initiatives',{enabled:e.target.checked})} /> {t('settings.initiativesUse')}</label>
      <p className="autonomy-status-hint">{t('settings.initiativesHint1')}<br />{t('settings.initiativesHint2')}<br />{t('settings.initiativesHint3')}</p>
      {initiatives.items.map(item=><details className="initiative-item" key={item.id}><summary>{item.body.purpose}<span>{INITIATIVE_STATES[item.state] ? t(`settings.${INITIATIVE_STATES[item.state]}`) : null}</span></summary>
        <div className="initiative-detail"><p>{t('settings.initiativeOwner', { name: members.find(m=>m.id===item.owner_id)?.name || t('settings.deletedBot') })}</p><p>{t('settings.initiativeReason', { text: item.body.reason ?? '' })}</p><p>{t('settings.initiativeCompletion', { text: item.body.completion ?? '' })}</p><p>{t('settings.initiativeNextAction', { text: item.body.next_action ?? '' })}</p><p>{t('settings.initiativeMethod', { text: item.body.method ?? '' })}</p><p>{t('settings.initiativeResult', { text: item.body.last_result || t('settings.initiativeNoResult') })}</p>
          {item.waits?.map(wait=><p key={wait.id}>{t('settings.initiativeWait', { reason: serverText(wait.reason) ?? '', detail: serverText(wait.wait_reason) ?? '' })}</p>)}<p>{t('settings.initiativeWaitCondition', { text: item.body.wait.detail || t('common.none') })}</p>
          <p>{t('settings.initiativeReviewReason', { text: serverText(item.review_reason) ?? '' })}</p><p>{t('settings.initiativeReviewAt', { time: new Date(item.review_at).toLocaleString(locale()) })}</p><p>{t('settings.initiativeCounts', { tasks: item.tasks.length, evidence: item.evidence.length })}</p>
          {item.state!=='completed'?<button type="button" disabled={saving} onClick={()=>change('/initiatives/'+item.id,{paused:item.state!=='paused',revision:item.revision})}>{item.state==='paused'?t('settings.initiativeResume'):t('settings.initiativePause')}</button>:null}
        </div></details>)}
      {!initiatives.items.length?<p className="autonomy-status-hint">{t('settings.initiativesEmpty')}</p>:null}
    </details>:null}
    {!rows.length && !error ? <p className="autonomy-status-hint">{t('settings.autonomyChecking')}</p> : null}
    {error ? <p className="autonomy-status-error" role="status">{t('settings.autonomyUpdateFailed', { error: serverText(error) })}</p> : null}
  </section>;
}
