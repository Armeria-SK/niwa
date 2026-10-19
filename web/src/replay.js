import { locale, serverText, t } from './i18n.js';

/** 経過の再生で使う言葉。記録の種類ごとに、見出し・中身・色を決める。表には辞書の文言の名前を置き、出すときに今の言語で引く。 */
const EVENTS = { queued: 'eventQueued', running: 'eventRunning', completed: 'eventCompleted', failed: 'eventFailed', cancelled: 'eventCancelled', waiting_child: 'eventWaitingChild', waiting_user: 'eventWaitingUser',
  waiting_provider: 'eventWaitingProvider', paused: 'eventPaused', resumed: 'eventResumed', instructed: 'eventInstructed', retried: 'eventRetried', interrupted: 'eventInterrupted' };
const PHASES = { work: 'phaseWork', memory_review: 'phaseMemoryReview', room_digest: 'phaseRoomDigest', task_summary_save: 'phaseTaskSummarySave', read_recovery: 'phaseReadRecovery', read_recovery_report: 'phaseReadRecoveryReport' };
const STATUSES = { completed: 'runCompleted', failed: 'runFailed', discarded: 'runDiscarded', unknown: 'runUnknown' };
const LINKS = { request: 'linkRequest', response: 'linkResponse', progress: 'linkProgress', followup: 'linkFollowup', amend: 'linkAmend', cancel: 'linkCancel' };
const DECISIONS = { approved: 'decisionApproved', declined: 'decisionDeclined', auto: 'decisionAuto' };
// 表にある種類は今の言語の言葉に、無い種類は fallback（ふつうは記録の値そのまま）にする。
const word = (table, value, fallback = value) => Object.hasOwn(table, value) ? t(`records.${table[value]}`) : fallback;

export function replayItemView(item) {
  const tokens = item.input_tokens != null ? t('records.replayTokens', { input: item.input_tokens.toLocaleString(locale()), output: (item.output_tokens ?? 0).toLocaleString(locale()) }) : t('records.replayTokensEstimated', { input: Number(item.estimated_input_tokens || 0).toLocaleString(locale()) });
  switch (item.type) {
    case 'event': return { label: t('records.replayState'), detail: word(EVENTS, item.code), tone: item.code === 'failed' ? 'danger' : item.code === 'completed' ? 'ok' : 'info' };
    case 'model': return { label: t('records.replayModel'), detail: t('records.replayModelDetail', { phase: word(PHASES, item.phase), status: word(STATUSES, item.status), tokens }), tone: item.status === 'failed' ? 'danger' : 'info' };
    case 'tool': return { label: t('records.replayTool', { name: item.name }), detail: [item.args, item.failed ? t('records.replayToolFailed') : item.result ? `→ ${item.result}` : ''].filter(Boolean).join(' '), tone: item.failed ? 'danger' : 'info' };
    case 'outside': return { label: t('records.replayOutside', { name: item.name }), detail: t(item.outcome === 'recorded' ? 'records.outcomeRecorded' : 'records.outcomeUnknown'), tone: item.outcome === 'recorded' ? 'ok' : 'warn' };
    case 'message': return { label: t('records.replayMessage', { kind: word(LINKS, item.link, t('records.linkOther')), author: serverText(item.author) }), detail: item.text, tone: 'ok' };
    case 'instruction': return { label: t('records.replayInstruction'), detail: item.text, tone: 'warn' };
    case 'note': return { label: t('records.replayNote'), detail: item.text, tone: 'info' };
    case 'approval': return { label: t('records.replayApproval'), detail: word(DECISIONS, item.decision), tone: item.decision === 'declined' ? 'danger' : 'ok' };
    default: return { label: t('records.replayRecord'), detail: '', tone: 'info' };
  }
}

/** 時刻の表示（時:分:秒）。ほかの画面と同じく、ブラウザーの時刻で出す。 */
export const replayTime = at => new Date(at).toLocaleTimeString(locale(), { hour12: false });
