import { MOTIONS, SHAPES } from './data.js';

/** 書き出す中身を一行で。人格と見た目はいつも入り、手順と記憶は選んだ数だけ。 */
export function exportSummary(procedures = 0, memories = 0) {
  return `人格・見た目${procedures ? `・手順${procedures}件` : ''}${memories ? `・記憶${memories}件` : ''}`;
}

/** 個別の会話から生まれて選べないものの知らせ。0件なら空。 */
export function privateNote(procedures = 0, memories = 0) {
  const parts = [procedures ? `手順${procedures}件` : '', memories ? `記憶${memories}件` : ''].filter(Boolean);
  return parts.length ? `個別の会話から生まれた${parts.join('と')}は、書き出せません。` : '';
}

/** 読み込めるファイルの長さ（文字数）。サーバーの上限と同じ。 */
export const BOT_FILE_MAX_LENGTH = 6_000_000;
const PLACES = { '/format': '形式', '/version': '版', '/exported_at': '書き出した日時', '/note': '説明', '/bot': 'Botの情報', '/bot/name': '名前', '/bot/role': '役割', '/bot/persona': '性格と話し方',
  '/appearance': '見た目', '/appearance/shape': 'かたち', '/appearance/color': 'カラー', '/appearance/motion': '動き', '/procedures': '手順', '/memories': '記憶' };
const PROCEDURE_PARTS = { title: '題', conditions: '使うとき', steps: '手順の中身' };

/** ファイルの中の場所（/procedures/0/steps/2 など）を、画面で読める言葉にする。 */
function place(path) {
  if (PLACES[path]) return `「${PLACES[path]}」`;
  const procedure = /^\/procedures\/(\d+)(?:\/(title|conditions|steps)(?:\/(\d+))?)?$/.exec(path);
  if (procedure) return `${Number(procedure[1]) + 1}件目の手順${procedure[2] ? `の「${PROCEDURE_PARTS[procedure[2]]}」` : ''}${procedure[3] ? `の${Number(procedure[3]) + 1}つ目` : ''}`;
  const memory = /^\/memories\/(\d+)(?:\/body)?$/.exec(path);
  if (memory) return `${Number(memory[1]) + 1}件目の記憶`;
  return `「${path.split('/').pop() || path}」`;
}

/** 読み込めない理由を1文にする。 */
export function problemText({ kind, path }) {
  switch (kind) {
    case 'size': return 'ファイルが大きすぎます。';
    case 'json': return 'JSONとして読めません。';
    case 'format': return 'Niwaで書き出したBotのファイルではありません。';
    case 'version': return 'このファイルの版には対応していません。';
    case 'missing': return `${place(path)}がありません。`;
    case 'unknown': return `知らない項目${place(path)}があります。`;
    case 'blank': return `${place(path)}が空です。`;
    case 'too_long': return `${place(path)}が長すぎます。`;
    default: return `${place(path)}の値が、Niwaで使える形ではありません。`;
  }
}

/** 見た目を一行で。かたちと動きは画面と同じ呼び名にする。 */
export function appearanceText({ shape, color, motion }) {
  return `かたち：${SHAPES.find(item => item.id === shape)?.name || shape}・カラー：${color}・動き：${MOTIONS.find(item => item.value === motion)?.label || motion}`;
}

/** 迎えると作られるもの。1文ずつ。手順と記憶を入れるときだけ、出所になる共有の会話を作る。 */
export function importPlan(preview, include) {
  const procedures = include.procedures ? preview.procedures.length : 0, memories = include.memories ? preview.memories : 0, name = preview.bot.name;
  const lines = [`新しいBot「${name}」を1体迎えます。`, '今いるBotは書き換えません。', 'モデルは「新しいBotの標準モデル」を使います。'];
  if (procedures || memories) {
    const parts = [procedures ? `手順${procedures}件` : '', memories ? `記憶${memories}件` : ''].filter(Boolean).join('と');
    lines.push(`共有の会話「${preview.room_title}」を1つ作ります。`, `そこに${parts}を、あなたの発言として1件ずつ載せます。`, `${name}は、それぞれの発言を出所として覚えます。`, 'ほかのBotも、この会話を読めます。');
  } else if (preview.procedures.length || preview.memories) lines.push('手順と記憶は入れません。', '会話も作りません。');
  return lines;
}

/** 秘密らしい文字を伏せたときの知らせ。伏せていなければ空。 */
export function hiddenNote(count = 0) {
  return count ? `秘密らしい文字を${count}か所伏せました。伏せたまま迎えます。` : '';
}

/** Botの数が上限に達しているときの知らせ。まだ迎えられるなら空。 */
export function limitNote(members, limit) {
  return members >= limit ? `迎えられるBotの上限（${limit}体）に達しています。休ませているBotも数に入ります。設定の「活動と人数」で上限を変えられます。` : '';
}
