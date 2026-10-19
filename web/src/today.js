import { artifactGroups } from './artifact-display.js';
import { locale, t } from './i18n.js';

export const DAY = 86_400_000;
const at = value => Number(typeof value === 'string' ? Date.parse(value) : value) || 0;

/** 「きょう」の画面に出す、直近24時間のまとめ。成果物は版の束ごとに最新の1件だけを数える。 */
export function todayDigest({ now, paused = false, attention = [], activities = [], artifacts = [], decisions = [] }) {
  const since = now - DAY;
  const made = artifactGroups(artifacts).map(group => group.latest).filter(item => at(item.created_at) >= since);
  const decided = decisions.filter(item => at(item.created_at) >= since).sort((a, b) => at(b.created_at) - at(a.created_at));
  const working = paused ? 0 : new Set(activities.filter(task => task.state === 'running' && !task.paused).map(task => task.member)).size;
  // lines は1文ずつ。画面は1文ごとに改行して見せる（「。」で区切れない言語でも同じに並ぶように）。
  const lines = [
    attention.length ? t('today.digestAttention', { count: attention.length }) : t('today.digestNoAttention'),
    paused ? t('today.digestPaused') : working ? t('today.digestWorking', { count: working }) : t('today.digestIdle'),
    made.length || decided.length ? t('today.digestMade', { decided: decided.length, made: made.length }) : null,
  ].filter(Boolean);
  return { since, made, decided, working, lines, summary: lines.join(t('today.sentenceGap')) };
}

export const dayLabel = now => new Date(now).toLocaleDateString(locale(), { month: 'long', day: 'numeric', weekday: 'short' });
