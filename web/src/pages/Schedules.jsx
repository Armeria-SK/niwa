import { Fragment, useRef, useState } from 'react';
import { EmptyState, Modal } from '../components.jsx';
import { ActivityIcon, PlusIcon } from '../icons.jsx';
import { locale, serverText, t } from '../i18n.js';
import { rich } from '../i18n-react.js';
import './schedules.css';

const formatTime = value => new Date(value).toLocaleString(locale());
// 間隔を割り切れるいちばん大きな単位で書く。kind は 'every'（〜ごと）か 'minimum'（最短〜おき）。
const INTERVAL_UNITS = [[10080, 'Weeks'], [1440, 'Days'], [60, 'Hours'], [1, 'Minutes']];
const formatInterval = (value, kind) => { const minutes = value / 60_000; const [size, name] = INTERVAL_UNITS.find(([size]) => minutes % size === 0); return t(`records.${kind}${name}`, { count: minutes / size }); };
const localTime = value => new Date(value - new Date(value).getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
const external = trigger => trigger === 'page_changes' || trigger === 'webhook';
/** 辞書の文の改行（\n）を <br /> にして並べる。 */
const lines = text => text.split('\n').map((line, index) => <Fragment key={index}>{index ? <br /> : null}{line}</Fragment>);
export function Schedules({ schedules, members, threads, onSave, onToggle, onDelete, onThread, onToken }) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [busy, setBusy] = useState(null);
  const [issued, setIssued] = useState(null);
  async function issue(row) {
    if (busy) return;
    setBusy(row.id);
    try { const result = await onToken(row.id); if (result) setIssued({ ...result, url: `${window.location.origin}${result.path}` }); } finally { setBusy(null); }
  }
  const available = threads.filter(room => !room.archived);
  async function toggle(row) {
    if (busy) return;
    setBusy(row.id);
    try { await onToggle(row.id, !row.enabled); } finally { setBusy(null); }
  }
  return <section>
    <div className="section-toolbar"><div><h2>{t('records.schedulesHeading')}</h2><p className="muted">{t('records.schedulesLead')}</p></div><button className="button primary" onClick={() => setAdding(true)} disabled={!available.length}><PlusIcon size={17} />{t('records.addSchedule')}</button></div>
    <p className="field-hint">{lines(t('records.schedulesRules'))}</p>
    {schedules.length ? <div className="activity-list">{schedules.map(row => {
      const exhausted = row.run_count >= row.max_runs || row.model_calls >= row.max_model_calls;
      const room = threads.find(item => item.id === row.room_id);
      const nextKey = row.trigger_kind === 'page_changes' ? (row.enabled ? 'nextCheck' : 'nextCheckAfterResume') : row.trigger_kind === 'webhook' ? (row.enabled ? 'nextWake' : 'nextWakeAfterResume') : row.enabled ? 'nextRun' : 'nextRunAfterResume';
      return <article className="activity-row" key={row.id}><div className="activity-row-body">
        <div className="activity-row-meta"><span>{members[row.agent_id]?.name}</span><span>{exhausted ? t('records.scheduleExhausted') : row.enabled ? t('records.scheduleEnabled') : t('records.schedulePaused')}</span></div>
        <h2>{row.prompt}</h2><p>{formatInterval(row.interval_ms, row.trigger_kind === 'webhook' ? 'minimum' : 'every')} · {t('records.runsUsed', { count: row.run_count, max: row.max_runs })} · {t('records.runTimeout', { count: row.timeout_ms / 60_000 })}</p>
        {row.trigger_kind === 'shared_changes' ? <p>{t('records.sharedChangesOnly')}</p> : null}
        {row.trigger_kind === 'page_changes' ? <p>{rich('records.pageWatch', { url: <span className="schedule-url">{row.source_url}</span> })}</p> : null}
        {row.trigger_kind === 'webhook' ? <p>{t(row.hook_ready ? 'records.webhookOnly' : 'records.webhookOnlyNoKey')}</p> : null}
        {external(row.trigger_kind) && row.checked_at ? <p className={row.check_failures ? 'task-reason' : ''}>{rich(row.trigger_kind === 'webhook' ? 'records.lastReceived' : 'records.lastChecked', { time: <time dateTime={new Date(row.checked_at).toISOString()}>{formatTime(row.checked_at)}</time>, status: serverText(row.check_status) })}</p> : null}
        {row.has_pending ? <p>{t('records.hasPending')}</p> : null}
        {row.autonomous ? <p>{t('records.autonomousNote')}</p> : null}
        <p>{t('records.modelCallsUsed', { count: row.model_calls, max: row.max_model_calls })}</p>
        {!exhausted ? <p>{rich(`records.${nextKey}`, { time: <time dateTime={new Date(row.next_at).toISOString()}>{formatTime(row.next_at)}</time> })}</p> : null}
        {row.wait_reason ? <p className="task-reason">{serverText(row.wait_reason)}</p> : null}
        <button className="text-button" onClick={() => onThread(row.room_id)}>{room?.title ? t('records.viewRoom', { title: room.title }) : t('records.viewRelatedThread')}</button>
      </div><div className="activity-row-action schedule-actions">{row.trigger_kind === 'webhook' ? <button className="button secondary" disabled={!!busy} onClick={() => issue(row)}>{row.hook_ready ? t('records.reissueKey') : t('records.issueKey')}</button> : null}<button className="button secondary" disabled={!!busy} onClick={() => setEditing(row)}>{t('common.edit')}</button><button className="button secondary" disabled={!!busy || exhausted} onClick={() => toggle(row)}>{row.enabled ? t('records.pause') : t('records.resume')}</button><button className="button subtle" disabled={!!busy} onClick={() => setDeleting(row)}>{t('records.deleteSchedule')}</button></div></article>;
    })}</div> : <EmptyState icon={ActivityIcon} title={t('records.emptySchedulesTitle')}>{available.length ? t('records.emptySchedulesBody') : t('records.emptySchedulesNoRoom')}</EmptyState>}
    <p className="field-hint">{lines(t('records.schedulesAfterNotes'))}</p>
    {deleting ? <Modal title={t('records.deleteScheduleTitle')} onClose={() => { if (!busy) setDeleting(null); }}><div className="modal-body form-stack"><p>{deleting.prompt}</p><p className="muted">{lines(t('records.deleteScheduleNote'))}</p></div><div className="form-actions"><button className="button subtle" disabled={!!busy} onClick={() => setDeleting(null)}>{t('records.dismiss')}</button><button className="button danger" disabled={!!busy} onClick={async () => { if (busy) return; setBusy(deleting.id); try { if (await onDelete(deleting.id)) setDeleting(null); } finally { setBusy(null); } }}>{t('records.deleteSchedule')}</button></div></Modal> : null}
    {issued ? <Modal title={t('records.webhookTitle')} onClose={() => setIssued(null)}><div className="modal-body form-stack">
      <p>{rich('records.webhookIntro', { warning: <strong>{t('records.webhookKeyOnce')}</strong> })}</p>
      <label className="field"><span>{t('records.webhookUrl')}</span><input readOnly value={issued.url} onFocus={e => e.target.select()} /></label>
      <label className="field"><span>{t('records.webhookHeader')}</span><textarea readOnly rows={2} value={`Authorization: Bearer ${issued.token}`} onFocus={e => e.target.select()} /></label>
      <p className="field-hint">{lines(t('records.webhookFormat'))}</p>
      <p className="field-hint">{lines(t('records.webhookReach'))}</p>
    </div><div className="form-actions"><button className="button primary" onClick={() => setIssued(null)}>{t('common.close')}</button></div></Modal> : null}
    {editing ? <ScheduleForm key={editing.id} initial={editing} members={members} threads={threads.filter(room => !room.archived || room.id === editing.room_id)} onSave={onSave} onClose={() => setEditing(null)} /> : null}
    {adding ? <ScheduleForm members={members} threads={available} onSave={onSave} onClose={() => setAdding(false)} /> : null}
  </section>;
}

function ScheduleForm({ members, threads, onSave, onClose, initial }) {
  const [roomId, setRoomId] = useState(initial?.room_id || threads[0]?.id || '');
  const [trigger, setTrigger] = useState(initial?.trigger_kind || 'interval');
  const [sourceUrl, setSourceUrl] = useState(initial?.source_url || '');
  const [autonomous, setAutonomous] = useState(!!initial?.autonomous);
  const [agentId, setAgentId] = useState(initial?.agent_id || '');
  const [prompt, setPrompt] = useState(initial?.prompt || '');
  const [first, setFirst] = useState(() => localTime(initial?.next_at ?? Date.now() + 3600_000));
  const [interval, setInterval] = useState(initial ? String(initial.interval_ms / 60_000) : '1');
  const [unit, setUnit] = useState(initial ? '1' : '1440');
  const [runs, setRuns] = useState(String(initial?.max_runs ?? 30));
  const [timeout, setTimeout] = useState(String((initial?.timeout_ms ?? 1800_000) / 60_000));
  const [modelLimit, setModelLimit] = useState(String(initial?.max_model_calls ?? 720));
  const [busy, setBusy] = useState(false);
  // 間違いは文言の名前で持ち、描くときに今の言語で引く。
  const [error, setError] = useState('');
  const submission = useRef(null);
  const room = threads.find(item => item.id === roomId);
  const selectableRooms = threads.filter(item => (!autonomous && trigger !== 'shared_changes') || item.scope === 'shared');
  const eligible = Object.values(members).filter(member => (member.status !== 'sleeping' || (initial?.agent_id === member.id && initial.room_id === roomId)) && (room?.scope === 'shared' || room?.members.includes(member.id)));
  const recipient = eligible.some(member => member.id === agentId) ? agentId : eligible[0]?.id || '';
  async function save(event) {
    event.preventDefault(); if (busy) return;
    const unchangedTime = initial && first === localTime(initial.next_at);
    const next_at = unchangedTime ? initial.next_at : new Date(first).getTime();
    if (!Number.isSafeInteger(next_at) || (!unchangedTime && next_at <= Date.now())) { setError('errorFirstInPast'); return; }
    const body = { agent_id: recipient, room_id: roomId, prompt: prompt.trim(), next_at,
      interval_ms: Number(interval) * Number(unit) * 60_000, max_runs: Number(runs), timeout_ms: Number(timeout) * 60_000,
      max_model_calls: Number(modelLimit), trigger_kind: trigger, autonomous, ...(trigger === 'page_changes' ? { source_url: sourceUrl.trim() } : {}) };
    const key = JSON.stringify(body);
    if (submission.current?.key !== key) submission.current = { key, id: crypto.randomUUID() };
    setBusy(true); setError('');
    try { if (await onSave({ ...body, id: initial?.id || submission.current.id, ...(initial ? { version: initial.version } : {}) })) onClose(); else setError('errorSaveFailed'); }
    finally { setBusy(false); }
  }
  const timeLabel = trigger === 'page_changes' ? (initial ? 'nextCheckAt' : 'firstCheckAt') : trigger === 'webhook' ? 'firstWakeAt' : initial ? 'nextRunAt' : 'firstRunAt';
  const intervalLabel = trigger === 'webhook' ? 'minimumIntervalLabel' : trigger === 'page_changes' ? 'checkIntervalLabel' : 'repeatIntervalLabel';
  return <Modal title={initial ? t('records.editSchedule') : t('records.addSchedule')} onClose={() => { if (!busy) onClose(); }}><form onSubmit={save}>
    <fieldset className="modal-body form-stack schedule-fields" disabled={busy}>
      <label className="schedule-autonomy"><input type="checkbox" checked={autonomous} onChange={e => { setAutonomous(e.target.checked); if (e.target.checked && room?.scope !== 'shared') setRoomId(threads.find(item => item.scope === 'shared')?.id || ''); }} />{t('records.chooseByInterest')}</label>
      <label className="field"><span>{t('records.triggerLabel')}</span><select aria-label={t('records.triggerLabel')} value={trigger} onChange={e => { const value = e.target.value; setTrigger(value); if (!initial && value === 'webhook') { setFirst(localTime(Date.now() + 300_000)); setInterval('10'); setUnit('1'); } if (!initial && value === 'page_changes') { setInterval('1'); setUnit('60'); } if (value === 'shared_changes' && room?.scope !== 'shared') setRoomId(threads.find(item => item.scope === 'shared')?.id || ''); }}><option value="interval">{t('records.triggerInterval')}</option><option value="shared_changes">{t('records.triggerShared')}</option><option value="page_changes">{t('records.triggerPage')}</option><option value="webhook">{t('records.triggerWebhook')}</option></select></label>
      {trigger === 'page_changes' ? <label className="field"><span>{t('records.sourceUrlLabel')}</span><input type="url" required maxLength={4096} value={sourceUrl} onChange={e => setSourceUrl(e.target.value)} placeholder="https://example.com/news/feed.xml" /></label> : null}
      <label className="field"><span>{t('records.roomLabel')}</span><select aria-label={t('records.roomLabel')} required value={roomId} onChange={e => setRoomId(e.target.value)}>{!selectableRooms.length ? <option value="">{t('records.noSharedRoom')}</option> : selectableRooms.map(item => <option key={item.id} value={item.id}>{t('records.roomOption', { title: item.title, scope: t(item.scope === 'shared' ? 'records.scopeShared' : 'records.scopePrivate') })}</option>)}</select></label>
      <label className="field"><span>{t('records.botLabel')}</span><select aria-label={t('records.botLabel')} required value={recipient} onChange={e => setAgentId(e.target.value)}>{!eligible.length ? <option value="">{t('records.noEligibleBot')}</option> : eligible.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label className="field"><span>{autonomous ? t('records.policyLabel') : t('records.promptLabel')}</span><textarea rows={3} required maxLength={20_000} value={prompt} onChange={e => setPrompt(e.target.value)} placeholder={autonomous ? t('records.policyPlaceholder') : t('records.promptPlaceholder')} /></label>
      {autonomous ? <p className="field-hint">{lines(t('records.autonomousHint'))}</p> : null}
      <label className="field"><span>{t(`records.${timeLabel}`)}</span><input type="datetime-local" required value={first} onChange={e => setFirst(e.target.value)} /></label>
      <p className="field-hint">{t('records.timeZoneHint', { zone: Intl.DateTimeFormat().resolvedOptions().timeZone })}</p>
      {trigger === 'shared_changes' ? <p className="field-hint">{lines(t('records.sharedChangesHint'))}</p> : null}
      {trigger === 'page_changes' ? <p className="field-hint">{lines(t('records.pageChangesHint'))}</p> : null}
      {trigger === 'webhook' ? <p className="field-hint">{lines(t('records.webhookHint'))}</p> : null}
      {external(trigger) ? <p className="field-hint">{t('records.externalHint')}</p> : null}
      <div className="schedule-interval"><label className="field"><span>{t(`records.${intervalLabel}`)}</span><input type="number" min="1" max={Math.floor(525600 / Number(unit))} step="1" required value={interval} onChange={e => setInterval(e.target.value)} /></label><label className="field"><span>{t('records.unitLabel')}</span><select aria-label={t('records.unitLabel')} value={unit} onChange={e => setUnit(e.target.value)}><option value="1">{t('records.unitMinutes')}</option><option value="60">{t('records.unitHours')}</option><option value="1440">{t('records.unitDays')}</option><option value="10080">{t('records.unitWeeks')}</option></select></label></div>
      <div className="schedule-numbers">
      <label className="field"><span>{t('records.maxRunsLabel')}</span><input type="number" min={Math.max(1, initial?.run_count || 0)} max="10000" step="1" required value={runs} onChange={e => setRuns(e.target.value)} /></label>
      <label className="field"><span>{t('records.timeoutLabel')}</span><input type="number" min="1" max="1440" step="1" required value={timeout} onChange={e => setTimeout(e.target.value)} /></label></div>
      <label className="field"><span>{t('records.maxModelCallsLabel')}</span><input type="number" min={Math.max(1, initial?.model_calls || 0)} max="1000000" step="1" required value={modelLimit} onChange={e => setModelLimit(e.target.value)} /></label>
      <p className="field-hint">{lines(t('records.limitsHint'))}</p>
      {error ? <p className="field-error" role="alert">{t(`records.${error}`)}</p> : null}
    </fieldset><div className="form-actions"><button type="button" className="button subtle" disabled={busy} onClick={onClose}>{t('records.dismiss')}</button><button className="button primary" disabled={busy || !recipient || !prompt.trim() || (trigger === 'page_changes' && !sourceUrl.trim())}>{busy ? t('records.savingShort') : t('records.saveSchedule')}</button></div>
  </form></Modal>;
}
