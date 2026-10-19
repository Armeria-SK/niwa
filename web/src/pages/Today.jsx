import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { AttentionList } from '../AttentionList.jsx';
import { GardenScene } from '../GardenScene.jsx';
import { MorningBasket, NightPreview, useNight } from '../NightPlan.jsx';
import { Avatar, StatusLabel, Sentences } from '../components.jsx';
import { documentName, kindLabel, qualityLabel } from '../artifact-display.js';
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
  const [trust, setTrust] = useState([]);
  useEffect(() => { let active = true; api('/trust').then(value => { if (active) setTrust(trustAttention(value.suggestions)); }).catch(() => {}); return () => { active = false; }; }, []);
  const items = [...attention, ...(conflicts ? [{ kind: 'conflicts', id: 'conflicts', title: `食い違いかもしれない記憶が${conflicts}組あります`, detail: 'Botが覚えていることを見比べて、直すか、そのままにするかを決めます。' }] : []), ...trust];
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
  return <main className="work-area today-page" id="main-content" tabIndex={-1}>
    <div className="page-heading"><div><span className="eyebrow">{dayLabel(now)}</span><h1>きょう</h1><p><Sentences>{digest.summary}</Sentences></p></div>{paused ? <button className="button secondary" onClick={onPause}><PlayIcon size={17} />活動を再開</button> : null}</div>
    <div className="today-scroll">
      {notice}
      {paused ? <div className="inline-notice"><PauseIcon size={18} /><p>Botの活動を一時停止しています。<br />再開するまで、仕事も自分から動く活動も進みません。</p></div> : null}
      {members.length ? <GardenScene members={[...awake, ...sleeping]} paused={paused} onMember={onMember} /> : null}
      {threads.length ? null : <section className="today-card today-start"><h2>最初の会話を始めましょう</h2><p>リーダーに、名前や好きなことを話してみてください。<br />話した内容から、少しずつ記憶が育ちます。</p><button className="button primary" onClick={onNewThread}><ChatIcon size={17} />会話を始める</button></section>}
      <div className="today-grid">
        <div className="today-main">
          {night ? <NightPreview key={night.night.key} state={night} onChange={setNight} /> : null}
          {night ? <MorningBasket state={night} artifacts={artifacts} memberMap={memberMap} onOpenTask={onOpenTask} onArtifact={onArtifact} /> : null}
          <AttentionList items={items} members={memberMap} onOpen={onOpenTask} onThread={onThread} onRead={onRead} onRecap={onRecap} onConflicts={onConflicts} onTrust={onTrust} />
          <section className="today-card" aria-labelledby="today-made">
            <h2 id="today-made">直近24時間にできたもの</h2>
            {digest.decided.length || digest.made.length ? <ul className="today-list">
              {digest.decided.slice(0, 5).map(item => <li key={item.id}><span className="attention-chip ok">決まったこと</span><button type="button" className="today-item" onClick={() => item.thread ? onThread(item.thread) : onRecap()}><strong>{item.title}</strong><small>{memberMap[item.member]?.name}</small></button></li>)}
              {digest.made.slice(0, 6).map(item => <li key={item.id}><span className="attention-chip info">{kindLabel(item.kind)}</span><button type="button" className="today-item" onClick={() => onArtifact(item.id)}><strong><FileIcon size={15} />{documentName(item.name)}</strong><small>{memberMap[item.member]?.name} · 第{item.version || 1}版 · {qualityLabel(item.quality_status)}</small></button></li>)}
            </ul> : <p className="today-empty">まだありません。<br />Botが決めたことや作ったものが、ここに集まります。</p>}
            {digest.decided.length > 5 || digest.made.length > 6 ? <button type="button" className="text-button" onClick={onRecap}>記録ですべて見る</button> : null}
          </section>
        </div>
        <aside className="today-side">
          {members.length > 6 ? <section className="today-card" aria-labelledby="today-garden">
            <h2 id="today-garden">庭のBot</h2>
            <ul className="today-garden">{[...awake, ...sleeping].map(member => <li key={member.id}><button type="button" onClick={() => onMember(member.id)}><Avatar member={member} size={36} /><span className="today-garden-name"><strong>{member.name}</strong><StatusLabel member={member} paused={paused} showDescription={false} /></span><ChevronRightIcon size={15} /></button></li>)}</ul>
          </section> : null}
          <section className="today-card" aria-labelledby="today-usage">
            <h2 id="today-usage">直近24時間のモデルの使用量</h2>
            {!usage ? <p className="today-empty" role="status">読み込んでいます…</p> : usage.error ? <p className="today-empty">使用量を読み込めませんでした。</p> : usage.calls ? <><dl className="today-usage"><div><dt>呼び出し</dt><dd>{usage.calls.toLocaleString('ja-JP')}回</dd></div><div><dt>入力</dt><dd>{usage.input.toLocaleString('ja-JP')}</dd></div><div><dt>出力</dt><dd>{usage.output.toLocaleString('ja-JP')}</dd></div></dl><p className="field-hint">入力・出力の単位はトークン（モデルが文字を数える単位）です。</p>{usage.estimated ? <p className="field-hint">うち{usage.estimated}回は接続先から量の報告がなく、入力は送る前の見積もりで数えています。</p> : null}</> : <p className="today-empty">直近24時間は、モデルを呼び出していません。</p>}
          </section>
        </aside>
      </div>
    </div>
  </main>;
}
