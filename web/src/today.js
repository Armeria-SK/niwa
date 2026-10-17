import { artifactGroups } from './artifact-display.js';

export const DAY = 86_400_000;
const at = value => Number(typeof value === 'string' ? Date.parse(value) : value) || 0;

/** 「きょう」の画面に出す、直近24時間のまとめ。成果物は版の束ごとに最新の1件だけを数える。 */
export function todayDigest({ now, paused = false, attention = [], activities = [], artifacts = [], decisions = [] }) {
  const since = now - DAY;
  const made = artifactGroups(artifacts).map(group => group.latest).filter(item => at(item.created_at) >= since);
  const decided = decisions.filter(item => at(item.created_at) >= since).sort((a, b) => at(b.created_at) - at(a.created_at));
  const working = paused ? 0 : new Set(activities.filter(task => task.state === 'running' && !task.paused).map(task => task.member)).size;
  const lines = [
    attention.length ? `あなたの番が${attention.length}件あります。` : 'あなたの判断を待っているものはありません。',
    paused ? 'Botの活動は一時停止しています。' : working ? `いま${working}体のBotが仕事を進めています。` : 'いま進めている仕事はありません。',
    made.length || decided.length ? `直近24時間で、決まったことが${decided.length}件、できたものが${made.length}件あります。` : null,
  ];
  return { since, made, decided, working, summary: lines.filter(Boolean).join('') };
}

export const dayLabel = now => new Date(now).toLocaleDateString('ja-JP', { month: 'long', day: 'numeric', weekday: 'short' });
