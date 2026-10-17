import { useEffect, useState } from 'react';
import { api } from './api.js';
import { Sentences } from './components.jsx';
import { agoLabel, limitLabel, nightLine, outcomeLabel, splitWork, toolLabel } from './watch.js';

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
    <div className="section-toolbar"><div><h2 id="watch-heading">見張り</h2><p className="muted"><Sentences>{`いま動いていることと、外に出たことを、読むだけで確かめる画面です。${state ? `${new Date(state.checked_at).toLocaleTimeString('ja-JP')}の時点で、5秒ごとに読み直します。` : ''}`}</Sentences></p></div></div>
    {error ? <p role="alert">{error}</p> : null}
    {!state ? <p role="status">読み込んでいます…</p> : <div className="watch-grid">
      <section className="today-card" aria-labelledby="watch-work"><h3 id="watch-work">いまの仕事</h3>
        <h4 className="small-heading">動いている仕事（{work.moving.length}件）</h4>
        {work.moving.length ? <WorkList items={work.moving} now={now} /> : <p className="today-empty">いま動いている仕事はありません。</p>}
        <h4 className="small-heading">待っている仕事（{work.waiting.length}件）</h4>
        {work.waiting.length ? <WorkList items={work.waiting} now={now} /> : <p className="today-empty">待っている仕事はありません。</p>}
      </section>
      <section className="today-card" aria-labelledby="watch-outside"><h3 id="watch-outside">直近の外とのやりとり</h3>
        {state.outside.length ? <ul className="watch-list">{state.outside.map((item, index) => <li key={`${item.task_id}-${item.at}-${index}`}><div><strong>{toolLabel(item.tool)}</strong><span className="muted">{item.name} · {agoLabel(item.at, now) || new Date(item.at).toLocaleString('ja-JP')}</span></div>{item.address ? <p className="watch-address">{item.address}</p> : null}<p className="watch-meta"><span className={`attention-chip ${item.outcome === 'recorded' ? (item.failed ? 'danger' : 'ok') : 'warn'}`}>{outcomeLabel(item)}</span></p></li>)}</ul>
          : <p className="today-empty">まだ外とのやりとりはありません。</p>}
        <p className="field-hint">「記録あり」は、結果が返ってきたことの記録です。<br />相手側で意図どおりになったことの証明ではありません。<br />「結果不明」は、送ったあとの結果を確かめられていないものです。</p>
      </section>
      <section className="today-card" aria-labelledby="watch-approvals"><h3 id="watch-approvals">承認待ち（{state.approvals.length}件）</h3>
        {state.approvals.length ? <ul className="watch-list">{state.approvals.map(item => <li key={item.task_id}><div><strong>{item.name}</strong><span className="muted">{item.room_title} · {agoLabel(item.since, now)}から</span></div><p>{item.title}</p></li>)}</ul>
          : <p className="today-empty">承認を待っている操作はありません。</p>}
        {state.approvals.length ? <p className="field-hint">承認や見送りは「承認待ち」のタブで行います。</p> : null}
      </section>
      <section className="today-card" aria-labelledby="watch-usage"><h3 id="watch-usage">今日の使用量と上限</h3>
        <dl className="today-usage"><div><dt>呼び出し</dt><dd>{state.usage.today.calls.toLocaleString('ja-JP')}回</dd></div><div><dt>入力</dt><dd>{state.usage.today.input.toLocaleString('ja-JP')}</dd></div><div><dt>出力</dt><dd>{state.usage.today.output.toLocaleString('ja-JP')}</dd></div></dl>
        <p className="field-hint">今日の0時（日本時間）からの量です。<br />入力・出力の単位はトークンです。{state.usage.today.estimated ? <><br />うち{state.usage.today.estimated}回は量の報告がなく、見積もりで数えています。</> : null}</p>
        <p className="watch-night"><Sentences>{nightLine(state.usage.night)}</Sentences></p>
        <h4 className="small-heading">自分から動く活動の枠（1時間ごと）</h4>
        <ul className="watch-meters">{state.usage.wakes.map(item => <li key={item.agent_id}><span>{item.name}</span><meter min="0" max={item.limit} value={item.used} aria-label={`${item.name}の枠`} /><span>{limitLabel(item.used, item.limit)}</span></li>)}</ul>
      </section>
    </div>}
  </section>;
}

function WorkList({ items, now }) {
  return <ul className="watch-list">{items.map(item => <li key={item.id}><div><strong>{item.name}</strong><span className="muted">{item.room_title}</span></div><p>{item.title || '（中身を消した仕事）'}</p><p className="watch-meta"><span className={`attention-chip ${item.state === 'running' && !item.paused ? 'ok' : 'info'}`}>{item.paused ? '一時停止中' : item.progress.label}</span>{item.autonomous ? <span>自分から動く活動</span> : null}<span>更新：{agoLabel(item.updated_at, now)}</span></p></li>)}</ul>;
}
