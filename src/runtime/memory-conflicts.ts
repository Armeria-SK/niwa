import { createHash } from 'node:crypto';

/** One memory as the conflict check reads it. The revision makes a dismissed pair come back once either memory is corrected. */
export interface MemoryText { agent_id: string; id: string; revision: number; body: string }
export interface MemoryConflict { pair: string; a: MemoryText; b: MemoryText; differences: string[]; score: number }

const KANJI_DIGITS: Record<string, number> = { 〇: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const COUNTERS = '時日月年回人冊件分円個つ曜週';
// Words that make a statement tentative or negative. A memory that says "not yet decided" next to one that states the fact is worth a look.
const TENTATIVE = /ない|ません|ず[、。]|未定|未決|まだ|かもしれ|案がある|やめ|中止/;

/** 「十四」→14 のように、漢数字1語を数にする。 */
function kanjiNumber(text: string): number {
  if (!text.includes('十')) return Number([...text].map(char => KANJI_DIGITS[char]).join(''));
  const [tens, ones] = text.split('十');
  return (tens ? KANJI_DIGITS[tens]! : 1) * 10 + (ones ? KANJI_DIGITS[ones]! : 0);
}
/** Width, case and kanji numerals that count something (第二・三時) are unified so 第2土曜 and 第二土曜 read the same. */
export function normalizeMemory(body: string): string {
  return body.normalize('NFKC').toLowerCase()
    .replace(/第([一二三四五六七八九十〇]+)/g, (_all, digits: string) => `第${kanjiNumber(digits)}`)
    .replace(new RegExp(`([一二三四五六七八九十〇]+)(?=[${COUNTERS}])`, 'g'), (_all, digits: string) => String(kanjiNumber(digits)));
}
/** Content words: runs of kanji, katakana or latin letters. Japanese has no spaces, so these runs stand in for words. */
function words(text: string): Set<string> {
  return new Set(text.match(/[\p{Script=Han}]{2,}|[\p{Script=Katakana}ー]{2,}|[a-z][a-z0-9]+/gu) ?? []);
}
/** Values with what they count: 第2 → 第:2, 14時 → 時:14, 土曜 → 曜:土. Only values of the same kind are compared. */
function facts(text: string): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  const add = (kind: string, value: string) => { if (!found.has(kind)) found.set(kind, new Set()); found.get(kind)!.add(value); };
  for (const match of text.matchAll(new RegExp(`(第)?(\\d+(?:[.:]\\d+)?)([${COUNTERS}%])?`, 'g'))) {
    const kind = match[1] ?? match[3];
    if (kind) add(kind, match[2]!);
  }
  for (const match of text.matchAll(/([月火水木金土日])曜/g)) add('曜日', match[1]!);
  return found;
}
const label = (kind: string, values: Set<string>) => [...values].map(value => kind === '第' ? `第${value}` : kind === '曜日' ? `${value}曜` : `${value}${kind}`).join('・');

export function conflictPairKey(a: MemoryText, b: MemoryText): string {
  const [first, second] = [a, b].map(item => `${item.agent_id}:${item.id}:${item.revision}`).sort();
  return createHash('sha256').update(`${first}\n${second}`).digest('hex');
}

/** Pairs of memories that talk about the same thing but disagree on a number, a date, a weekday, or whether it is settled.
 * This only reads the words and never calls a model, so it costs nothing. It points at candidates; the person decides. */
export function findMemoryConflicts(memories: MemoryText[], limit = 50): MemoryConflict[] {
  const read = memories.map(memory => { const text = normalizeMemory(memory.body); return { memory, text, words: words(text), facts: facts(text), tentative: TENTATIVE.test(text) }; });
  // Count shared words through an index so the check does not compare every pair. Words in most memories say nothing about a topic.
  const index = new Map<string, number[]>();
  read.forEach((item, position) => { for (const word of item.words) { if (!index.has(word)) index.set(word, []); index.get(word)!.push(position); } });
  const common = Math.max(8, read.length * 0.25), shared = new Map<number, number>();
  for (const positions of index.values()) {
    if (positions.length > common) continue;
    for (let i = 0; i < positions.length; i++) for (let j = i + 1; j < positions.length; j++) {
      const key = positions[i]! * read.length + positions[j]!;
      shared.set(key, (shared.get(key) ?? 0) + 1);
    }
  }
  const found: MemoryConflict[] = [];
  for (const [key, count] of shared) {
    const a = read[Math.floor(key / read.length)]!, b = read[key % read.length]!;
    const overlap = count / Math.min(a.words.size, b.words.size);
    if (count < 2 || overlap < 0.5 || a.text === b.text) continue;
    const differences: string[] = [];
    for (const [kind, values] of a.facts) {
      const other = b.facts.get(kind);
      if (other && ![...values].some(value => other.has(value))) differences.push(`${label(kind, values)} ⇄ ${label(kind, other)}`);
    }
    if (a.tentative !== b.tentative) differences.push('片方だけ「まだ」「ない」などの言い方');
    if (differences.length) found.push({ pair: conflictPairKey(a.memory, b.memory), a: a.memory, b: b.memory, differences, score: overlap + differences.length * 0.2 });
  }
  return found.sort((x, y) => y.score - x.score || x.pair.localeCompare(y.pair)).slice(0, limit);
}
