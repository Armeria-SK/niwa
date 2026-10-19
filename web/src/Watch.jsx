import { Fragment, useEffect, useState } from 'react';
import { api } from './api.js';
import { Sentences } from './components.jsx';
import { formatNumber, locale, serverText, t } from './i18n.js';
import { agoLabel, limitLabel, nightLine, outcomeLabel, splitWork, toolLabel } from './watch.js';

/** 辞書の文の改行（\n）を <br /> にして並べる。 */
const lines = text => text.split('\n').map((line, index) => <Fragment key={index}>{index ? <br /> : null}{line}</Fragment>);

/** 記録の「見張り」。動いている仕事と待っている仕事・外とのやりとり・承認待ち・今日の使用量を読むだけの画面。全体の一時停止は、ページの見出しのボタンで行う。 */
export function Watch({ paused }) {
  const [state, setState] = useState(null), [error, setError] = useState('');
  useEffect(() => {
    let active = true, timer;
    async function load() {
      clearTimeout(timer);
      try { const value = await api('/watch'); if (active) { setState(value); setError(''); } }
      catch (failure) { if (active) setError(failure.message); }
      // 開いている間だけ、5秒ごとに読み直す。
      if (active && !document.hidden) timer = setTimeout(load, 5000);
    }
    const onVisibility = () => { if (!document.hidden) void load(); else clearTimeout(timer); };
    document.addEventListener('visibilitychange', onVisibility);
    void load();
    return () => { active = false; clearTimeout(timer); document.removeEventListener('visibilitychange', onVisibility); };
  }, [paused]);
  const now = state?.checked_at ?? Date.now(), work = splitWork(state?.running);
  return <section className="watch-view" aria-labelledby="watch-heading">
    <div className="section-toolbar"><div><h2 id="watch-heading">{t('records.watchHeading')}</h2><p className="muted"><Sentences>{state ? t('records.watchIntroAt', { time: new Date(state.checked_at).toLocaleTimeString(locale()) }) : t('records.watchIntro')}</Sentences></p></div></div>
    {error ? <p role="alert">{error}</p> : null}
    {!state ? <p role="status">{t('common.loading')}</p> : <div className="watch-grid">
      <section className="today-card" aria-labelledby="watch-work"><h3 id="watch-work">{t('records.watchWork')}</h3>
        <h4 className="small-heading">{t('records.watchMoving', { count: work.moving.length })}</h4>
        {work.moving.length ? <WorkList items={work.moving} now={now} /> : <p className="today-empty">{t('records.watchNoMoving')}</p>}
        <h4 className="small-heading">{t('records.watchWaiting', { count: work.waiting.length })}</h4>
        {work.waiting.length ? <WorkList items={work.waiting} now={now} /> : <p className="today-empty">{t('records.watchNoWaiting')}</p>}
      </section>
      <section className="today-card" aria-labelledby="watch-outside"><h3 id="watch-outside">{t('records.watchOutside')}</h3>
        {state.outside.length ? <ul className="watch-list">{state.outside.map((item, index) => <li key={`${item.task_id}-${item.at}-${index}`}><div><strong>{toolLabel(item.tool)}</strong><span className="muted">{item.name} · {agoLabel(item.at, now) || new Date(item.at).toLocaleString(locale())}</span></div>{item.address ? <p className="watch-address">{item.address}</p> : null}<p className="watch-meta"><span className={`attention-chip ${item.outcome === 'recorded' ? (item.failed ? 'danger' : 'ok') : 'warn'}`}>{outcomeLabel(item)}</span></p></li>)}</ul>
          : <p className="today-empty">{t('records.watchNoOutside')}</p>}
        <p className="field-hint">{lines(t('records.watchOutcomeHint'))}</p>
      </section>
      <section className="today-card" aria-labelledby="watch-approvals"><h3 id="watch-approvals">{t('records.watchApprovals', { count: state.approvals.length })}</h3>
        {state.approvals.length ? <ul className="watch-list">{state.approvals.map(item => <li key={item.task_id}><div><strong>{serverText(item.name)}</strong><span className="muted">{serverText(item.room_title)} · {t('records.watchAskedAgo', { ago: agoLabel(item.since, now) })}</span></div><p>{item.title}</p></li>)}</ul>
          : <p className="today-empty">{t('records.watchNoApprovals')}</p>}
        {state.approvals.length ? <p className="field-hint">{t('records.watchApprovalHint')}</p> : null}
      </section>
      <section className="today-card" aria-labelledby="watch-usage"><h3 id="watch-usage">{t('records.watchUsage')}</h3>
        <dl className="today-usage"><div><dt>{t('records.usageCalls')}</dt><dd>{t('records.usageCallsValue', { count: formatNumber(state.usage.today.calls) })}</dd></div><div><dt>{t('records.usageInput')}</dt><dd>{formatNumber(state.usage.today.input)}</dd></div><div><dt>{t('records.usageOutput')}</dt><dd>{formatNumber(state.usage.today.output)}</dd></div></dl>
        <p className="field-hint">{lines(t('records.watchUsageHint'))}{state.usage.today.estimated ? <><br />{t('records.watchUsageEstimated', { count: state.usage.today.estimated })}</> : null}</p>
        <p className="watch-night"><Sentences>{nightLine(state.usage.night)}</Sentences></p>
        <h4 className="small-heading">{t('records.watchWakes')}</h4>
        <ul className="watch-meters">{state.usage.wakes.map(item => <li key={item.agent_id}><span>{serverText(item.name)}</span><meter min="0" max={item.limit} value={item.used} aria-label={t('records.watchWakeMeter', { name: item.name })} /><span>{limitLabel(item.used, item.limit)}</span></li>)}</ul>
      </section>
    </div>}
  </section>;
}

function WorkList({ items, now }) {
  return <ul className="watch-list">{items.map(item => <li key={item.id}><div><strong>{serverText(item.name)}</strong><span className="muted">{serverText(item.room_title)}</span></div><p>{item.title || t('records.workErased')}</p><p className="watch-meta"><span className={`attention-chip ${item.state === 'running' && !item.paused ? 'ok' : 'info'}`}>{item.paused ? t('records.statusPaused') : serverText(item.progress.label)}</span>{item.autonomous ? <span>{t('records.workAutonomous')}</span> : null}<span>{t('records.workUpdated', { ago: agoLabel(item.updated_at, now) })}</span></p></li>)}</ul>;
}
