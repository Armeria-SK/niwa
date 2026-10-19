import { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { Sentences } from './components.jsx';
import { t } from './i18n.js';
import { BackIcon, PauseIcon, PlayIcon } from './icons.jsx';
import { replayItemView, replayTime } from './replay.js';

/** 仕事の脇の欄の中で、経過を時刻の順に1本で見せる。つまみで時点を選び、そこから直した指示で新しい仕事を作れる（元の仕事は変えない）。 */
export function TaskReplay({ taskId, onBack, onBranched }) {
  const [data, setData] = useState(null), [error, setError] = useState('');
  const [position, setPosition] = useState(0), [playing, setPlaying] = useState(false);
  const [branching, setBranching] = useState(false), [prompt, setPrompt] = useState(''), [busy, setBusy] = useState(false);
  const current = useRef(null);
  useEffect(() => {
    let active = true;
    api(`/tasks/${taskId}/replay`).then(value => { if (active) { setData(value); setPosition(Math.max(0, value.items.length - 1)); setPrompt(value.task.prompt); } }).catch(failure => { if (active) setError(failure.message); });
    return () => { active = false; };
  }, [taskId]);
  const count = data?.items.length ?? 0;
  // 再生は、いまの時点から1件ずつ進め、最後で止まる。
  useEffect(() => {
    if (!playing) return undefined;
    if (position >= count - 1) { setPlaying(false); return undefined; }
    const timer = setTimeout(() => setPosition(value => Math.min(count - 1, value + 1)), 900);
    return () => clearTimeout(timer);
  }, [playing, position, count]);
  useEffect(() => { current.current?.scrollIntoView({ block: 'nearest' }); }, [position]);
  async function branch(event) {
    event.preventDefault(); if (busy || !prompt.trim()) return;
    setBusy(true); setError('');
    try { const { task_id } = await api(`/tasks/${taskId}/branch`, 'POST', { at: data.items[position].at, prompt: prompt.trim() }); onBranched(task_id); }
    catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  if (error && !data) return <div className="modal-body"><p role="alert">{error}</p><button className="text-button" onClick={onBack}><BackIcon size={16} />{t('records.backToTask')}</button></div>;
  if (!data) return <div className="modal-body"><p role="status">{t('records.replayLoading')}</p></div>;
  const at = data.items[position];
  return <div className="modal-body form-stack task-replay">
    <button className="text-button" onClick={onBack}><BackIcon size={16} />{t('records.backToTask')}</button>
    <p className="field-hint"><Sentences>{t(data.truncated ? 'records.replayIntroTruncated' : 'records.replayIntro')}</Sentences></p>
    {count ? <>
      <div className="replay-controls">
        <button type="button" className="button subtle" aria-label={t('records.stepBack')} disabled={position <= 0} onClick={() => { setPlaying(false); setPosition(value => Math.max(0, value - 1)); }}>‹</button>
        <button type="button" className="button secondary" onClick={() => { if (!playing && position >= count - 1) setPosition(0); setPlaying(value => !value); }}>{playing ? <PauseIcon size={16} /> : <PlayIcon size={16} />}{playing ? t('records.pause') : t('records.play')}</button>
        <button type="button" className="button subtle" aria-label={t('records.stepForward')} disabled={position >= count - 1} onClick={() => { setPlaying(false); setPosition(value => Math.min(count - 1, value + 1)); }}>›</button>
        <input type="range" min="0" max={count - 1} value={position} aria-label={t('records.replayPosition')} onChange={event => { setPlaying(false); setPosition(Number(event.target.value)); }} />
        <span className="replay-at">{position + 1} / {count} · {replayTime(at.at)}</span>
      </div>
      <ol className="replay-list">{data.items.map((item, index) => { const view = replayItemView(item);
        return <li key={index} ref={index === position ? current : null} className={index > position ? 'later' : index === position ? 'current' : ''} aria-current={index === position ? 'step' : undefined}>
          <time>{replayTime(item.at)}</time><span className={`attention-chip ${view.tone}`}>{view.label}</span>{view.detail ? <p>{view.detail}</p> : null}
        </li>; })}</ol>
    </> : <p className="today-empty">{t('records.replayEmpty')}</p>}
    {count ? branching ? <form className="form-stack replay-branch" onSubmit={branch}>
      <h3 className="small-heading">{t('records.branchHeading', { time: replayTime(at.at) })}</h3>
      <p className="field-hint"><Sentences>{t('records.branchHint', { count: position + 1, name: data.task.name })}</Sentences></p>
      <label className="field"><span>{t('records.revisedInstruction')}</span><textarea rows={4} maxLength={8000} value={prompt} onChange={event => setPrompt(event.target.value)} /></label>
      {error ? <p role="alert">{error}</p> : null}
      <div className="inline-actions"><button className="button primary" disabled={busy || !prompt.trim()}>{busy ? t('records.creating') : t('records.createBranch')}</button><button type="button" className="button subtle" onClick={() => setBranching(false)}>{t('records.dismiss')}</button></div>
    </form> : <button type="button" className="button secondary" onClick={() => { setPlaying(false); setBranching(true); }}>{t('records.branchHere')}</button> : null}
  </div>;
}
