import { MOTIONS, SHAPES } from './data.js';
import { t } from './i18n.js';

const procedureCount = count => t('bots.procedureCount', { count });
const memoryCount = count => t('bots.memoryCountShort', { count });
/** 手順と記憶の数を一つの言い方にする（「手順1件と記憶3件」など）。どちらも0なら空。 */
function countsText(procedures, memories) {
  if (procedures && memories) return t('bots.pairJoin', { first: procedureCount(procedures), second: memoryCount(memories) });
  return procedures ? procedureCount(procedures) : memories ? memoryCount(memories) : '';
}

/** 書き出す中身を一行で。人格と見た目はいつも入り、手順と記憶は選んだ数だけ。 */
export function exportSummary(procedures = 0, memories = 0) {
  return [t('bots.summaryBase'), procedures ? procedureCount(procedures) : '', memories ? memoryCount(memories) : ''].filter(Boolean).join(t('bots.separator'));
}

/** 個別の会話から生まれて選べないものの知らせ。0件なら空。 */
export function privateNote(procedures = 0, memories = 0) {
  const counts = countsText(procedures, memories);
  return counts ? t('bots.privateNote', { things: counts }) : '';
}

/** 読み込めるファイルの長さ（文字数）。サーバーの上限と同じ。 */
export const BOT_FILE_MAX_LENGTH = 6_000_000;
// ファイルの中の場所ごとの、画面での呼び名（辞書の名前）。
const PLACES = { '/format': 'placeFormat', '/version': 'placeVersion', '/exported_at': 'placeExportedAt', '/note': 'placeNote', '/bot': 'placeBot', '/bot/name': 'name', '/bot/role': 'role', '/bot/persona': 'persona',
  '/appearance': 'appearance', '/appearance/shape': 'shape', '/appearance/color': 'color', '/appearance/motion': 'motion', '/procedures': 'placeProcedures', '/memories': 'placeMemories' };
const PROCEDURE_PARTS = { title: 'partTitle', conditions: 'partConditions', steps: 'partSteps' };
const quoted = text => t('bots.quoted', { text });

/** ファイルの中の場所（/procedures/0/steps/2 など）を、画面で読める言葉にする。 */
function place(path) {
  if (PLACES[path]) return quoted(t(`bots.${PLACES[path]}`));
  const procedure = /^\/procedures\/(\d+)(?:\/(title|conditions|steps)(?:\/(\d+))?)?$/.exec(path);
  if (procedure) {
    const n = Number(procedure[1]) + 1;
    if (!procedure[2]) return t('bots.placeProcedure', { n });
    const part = t(`bots.${PROCEDURE_PARTS[procedure[2]]}`);
    return procedure[3] ? t('bots.placeProcedureItem', { n, part, k: Number(procedure[3]) + 1 }) : t('bots.placeProcedurePart', { n, part });
  }
  const memory = /^\/memories\/(\d+)(?:\/body)?$/.exec(path);
  if (memory) return t('bots.placeMemory', { n: Number(memory[1]) + 1 });
  return quoted(path.split('/').pop() || path);
}

/** 読み込めない理由を1文にする。 */
export function problemText({ kind, path }) {
  switch (kind) {
    case 'size': return t('bots.problemSize');
    case 'json': return t('bots.problemJson');
    case 'format': return t('bots.problemFormat');
    case 'version': return t('bots.problemVersion');
    case 'missing': return t('bots.problemMissing', { place: place(path) });
    case 'unknown': return t('bots.problemUnknown', { place: place(path) });
    case 'blank': return t('bots.problemBlank', { place: place(path) });
    case 'too_long': return t('bots.problemTooLong', { place: place(path) });
    default: return t('bots.problemValue', { place: place(path) });
  }
}

/** 見た目を一行で。かたちと動きは画面と同じ呼び名にする。 */
export function appearanceText({ shape, color, motion }) {
  return t('bots.appearanceSummary', { shape: SHAPES.find(item => item.id === shape)?.name || shape, color, motion: MOTIONS.find(item => item.value === motion)?.label || motion });
}

/** 迎えると作られるもの。1文ずつ。手順と記憶を入れるときだけ、出所になる共有の会話を作る。 */
export function importPlan(preview, include) {
  const procedures = include.procedures ? preview.procedures.length : 0, memories = include.memories ? preview.memories : 0, name = preview.bot.name;
  const lines = [t('bots.planWelcome', { name }), t('bots.planKeepOthers'), t('bots.planModel')];
  if (procedures || memories) {
    lines.push(t('bots.planRoom', { title: preview.room_title }), t('bots.planPost', { things: countsText(procedures, memories) }), t('bots.planSource', { name }), t('bots.planOthersRead'));
  } else if (preview.procedures.length || preview.memories) lines.push(t('bots.planSkip'), t('bots.planNoRoom'));
  return lines;
}

/** 秘密らしい文字を伏せたときの知らせ。伏せていなければ空。 */
export function hiddenNote(count = 0) {
  return count ? t('bots.hiddenNote', { count }) : '';
}

/** Botの数が上限に達しているときの知らせ。まだ迎えられるなら空。 */
export function limitNote(members, limit) {
  return members >= limit ? t('bots.limitReached', { limit }) : '';
}
