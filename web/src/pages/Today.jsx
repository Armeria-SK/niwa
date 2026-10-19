import { Fragment, useEffect, useState } from 'react';
import { api } from '../api.js';
import { AttentionList } from '../AttentionList.jsx';
import { GardenScene } from '../GardenScene.jsx';
import { MorningBasket, NightPreview, useNight } from '../NightPlan.jsx';
import { Avatar, StatusLabel } from '../components.jsx';
import { documentName, kindLabel, qualityLabel } from '../artifact-display.js';
import { formatNumber, t } from '../i18n.js';
import { rich } from '../i18n-react.js';
import { DAY, dayLabel, todayDigest } from '../today.js';
import { trustAttention } from '../trust.js';
import { ChatIcon, ChevronRightIcon, FileIcon, PauseIcon, PlayIcon } from '../icons.jsx';

/** 開いて最初に見る画面。あなたの番・直近24時間にできたもの・庭の様子を1枚にまとめる。 */
export function Today({ onConflicts, onTrust, notice, paused, onPause, attention, members, memberMap, activities, artifacts, decisions, threads, onOpenTask, onThread, onRead, onRecap, onArtifact, onMember, onNewThread }) {
  // 開いたままでも日付と「直近24時間」がずれないよう、5分ごとに今の時刻を取り直す。
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 300_000); return () => clearInterval(timer); }, []);
  // 記憶の食い違いは開いたときに1回だけ数える（AIモデルは使わない）。0組なら何も出さない。
  const [conflicts, setConflicts] = useState(0);
  useEffect(() => { let active = true; api('/memories/conflicts').then(items => { if (active) setConflicts(items.length); }).catch(() => {}); return () => { active = false; }; }, []);
  // 任せる範囲の提案も開いたときに1回だけ読む。急ぎではないので、ほかの項目のあとに並べる。
  // 読んだ提案そのものを持ち、文言は描くたびに作る（言語を切り替えたときに追いつくように）。
  const [suggestions, setSuggestions] = useState([]);
  useEffect(() => { let active = true; api('/trust').then(value => { if (active && Array.isArray(value.suggestions)) setSuggestions(value.suggestions); }).catch(() => {}); return () => { active = false; }; }, []);
  const trust = trustAttention(suggestions);
  const items = [...attention, ...(conflicts ? [{ kind: 'conflicts', id: 'conflicts', title: t('today.conflictsTitle', { count: conflicts }), detail: t('today.conflictsDetail') }] : []), ...trust];
  const digest = todayDigest({ now, paused, attention: items, activities, artifacts, decisions });
  const [usage, setUsage] = useState(null);
  const finished = activities.filter(task => task.state === 'completed').length;
  useEffect(() => {
    let active = true;
    api(`/usage?since=${now - DAY}`).then(result => { if (active) setUsage(result); }).catch(() => { if (active) setUsage({ error: true }); });
    return () => { active = false; };
  }, [now, finished]);
  const [night, setNight] = useNight();
  const awake = members.filter(member => member.status !== 'sleeping'), sleeping = members.filter(member => member.status === 'sleeping');
  const br = <br />;
  return <main className="work-area today-page" id="main-content" tabIndex={-1}>
    <div className="page-heading"><div><span className="eyebrow">{dayLabel(now)}</span><h1>{t('today.title')}</h1><p>{digest.lines.map((line, index) => <Fragment key={index}>{index ? <br /> : null}{line}</Fragment>)}</p></div>{paused ? <button className="button secondary" onClick={onPause}><PlayIcon size={17} />{t('today.resume')}</button> : null}</div>
    <div className="today-scroll">
      {notice}
      {paused ? <div className="inline-notice"><PauseIcon size={18} /><p>{rich('today.pausedNotice', { br })}</p></div> : null}
      {members.length ? <GardenScene members={[...awake, ...sleeping]} paused={paused} onMember={onMember} /> : null}
      {threads.length ? null : <section className="today-card today-start"><h2>{t('today.startHeading')}</h2><p>{rich('today.startBody', { br })}</p><button className="button primary" onClick={onNewThread}><ChatIcon size={17} />{t('today.startButton')}</button></section>}
      <div className="today-grid">
        <div className="today-main">
          {night ? <NightPreview key={night.night.key} state={night} onChange={setNight} /> : null}
          {night ? <MorningBasket state={night} artifacts={artifacts} memberMap={memberMap} onOpenTask={onOpenTask} onArtifact={onArtifact} /> : null}
          <AttentionList items={items} members={memberMap} onOpen={onOpenTask} onThread={onThread} onRead={onRead} onRecap={onRecap} onConflicts={onConflicts} onTrust={onTrust} />
          <section className="today-card" aria-labelledby="today-made">
            <h2 id="today-made">{t('today.madeHeading')}</h2>
            {digest.decided.length || digest.made.length ? <ul className="today-list">
              {digest.decided.slice(0, 5).map(item => <li key={item.id}><span className="attention-chip ok">{t('today.decided')}</span><button type="button" className="today-item" onClick={() => item.thread ? onThread(item.thread) : onRecap()}><strong>{item.title}</strong><small>{memberMap[item.member]?.name}</small></button></li>)}
              {digest.made.slice(0, 6).map(item => <li key={item.id}><span className="attention-chip info">{kindLabel(item.kind)}</span><button type="button" className="today-item" onClick={() => onArtifact(item.id)}><strong><FileIcon size={15} />{documentName(item.name)}</strong><small>{memberMap[item.member]?.name} · {t('today.artifactVersion', { version: item.version || 1 })} · {qualityLabel(item.quality_status)}</small></button></li>)}
            </ul> : <p className="today-empty">{rich('today.madeEmpty', { br })}</p>}
            {digest.decided.length > 5 || digest.made.length > 6 ? <button type="button" className="text-button" onClick={onRecap}>{t('today.seeAllInRecords')}</button> : null}
          </section>
        </div>
        <aside className="today-side">
          {members.length > 6 ? <section className="today-card" aria-labelledby="today-garden">
            <h2 id="today-garden">{t('today.gardenBotsHeading')}</h2>
            <ul className="today-garden">{[...awake, ...sleeping].map(member => <li key={member.id}><button type="button" onClick={() => onMember(member.id)}><Avatar member={member} size={36} /><span className="today-garden-name"><strong>{member.name}</strong><StatusLabel member={member} paused={paused} showDescription={false} /></span><ChevronRightIcon size={15} /></button></li>)}</ul>
          </section> : null}
          <section className="today-card" aria-labelledby="today-usage">
            <h2 id="today-usage">{t('today.usageHeading')}</h2>
            {!usage ? <p className="today-empty" role="status">{t('common.loading')}</p> : usage.error ? <p className="today-empty">{t('today.usageError')}</p> : usage.calls ? <><dl className="today-usage"><div><dt>{t('today.usageCalls')}</dt><dd>{t('today.usageCallCount', { count: formatNumber(usage.calls) })}</dd></div><div><dt>{t('today.usageInput')}</dt><dd>{formatNumber(usage.input)}</dd></div><div><dt>{t('today.usageOutput')}</dt><dd>{formatNumber(usage.output)}</dd></div></dl><p className="field-hint">{t('today.usageUnitHint')}</p>{usage.estimated ? <p className="field-hint">{t('today.usageEstimated', { count: usage.estimated })}</p> : null}</> : <p className="today-empty">{t('today.usageNone')}</p>}
          </section>
        </aside>
      </div>
    </div>
  </main>;
}
