import ja from './locales/ja/index.js';

/** 選べる言語。name は、どの言語で表示していても読めるように、その言語自身での呼び名にする。 */
export const LANGUAGES = [
  { id: 'ja', name: '日本語', locale: 'ja-JP', sample: '画面の言葉も、Botの返事も日本語に' },
  { id: 'en', name: 'English', locale: 'en-US', sample: 'Screens and Bot replies in English' },
  { id: 'ko', name: '한국어', locale: 'ko-KR', sample: '화면도 봇의 답장도 한국어로' },
  { id: 'zh-CN', name: '简体中文', locale: 'zh-CN', sample: '界面和 Bot 的回复都用简体中文' },
];
const IDS = LANGUAGES.map(language => language.id);
// 日本語は元の文言なので最初から持つ。ほかの言語は選んだときに読み込む（使わない言語の分だけ最初の読み込みを軽くする）。
const LOADERS = { en: () => import('./locales/en/index.js'), ko: () => import('./locales/ko/index.js'), 'zh-CN': () => import('./locales/zh-CN/index.js') };
const dictionaries = { ja };
const listeners = new Set();
let current = 'ja';

export function isLanguage(id) { return IDS.includes(id); }
/** 今の言語のID（'ja'・'en'・'ko'・'zh-CN'）。 */
export function language() { return current; }
/** 日付や数の書き方に渡す地域の名前（toLocaleString などの第1引数）。 */
export function locale() { return LANGUAGES.find(item => item.id === current).locale; }
export function subscribeLanguage(listener) { listeners.add(listener); return () => listeners.delete(listener); }

/** 言語を切り替える。辞書を読み込んでから切り替えるので、途中で文言が混ざらない。知らないIDは日本語として扱う。 */
export async function setLanguage(id) {
  const next = isLanguage(id) ? id : 'ja';
  if (!dictionaries[next]) dictionaries[next] = (await LOADERS[next]()).default;
  if (next === current) return;
  current = next;
  if (typeof document !== 'undefined') document.documentElement.lang = next;
  for (const listener of listeners) listener();
}

function lookup(dictionary, key) {
  const dot = key.indexOf('.');
  return dot < 0 ? undefined : dictionary?.[key.slice(0, dot)]?.[key.slice(dot + 1)];
}
function fill(text, vars) { return vars ? text.replace(/\{(\w+)\}/g, (match, name) => name in vars ? String(vars[name]) : match) : text; }

/** 画面の文言。key は「画面の名前.文言の名前」（例：'nav.today'）。
 * 辞書の値は文字列（{name} を vars で埋める）か、vars を受け取って文字列を返す関数（英語の単数・複数などに使う）。
 * 今の言語に無い文言は日本語を、日本語にも無ければ key をそのまま出す。 */
export function t(key, vars) {
  const value = lookup(dictionaries[current], key) ?? lookup(ja, key);
  if (value === undefined) return key;
  return typeof value === 'function' ? value(vars ?? {}) : fill(value, vars);
}

/** 文言の中に部品（リンクや太字など）を差し込むときの形。文字列と部品の配列を返す（React の rich() が並べる）。 */
export function parts(key, vars = {}) {
  const value = lookup(dictionaries[current], key) ?? lookup(ja, key);
  const text = value === undefined ? key : typeof value === 'function' ? value(vars) : value;
  if (typeof text !== 'string') return [text];
  return text.split(/(\{\w+\})/).filter(Boolean).map(piece => {
    const name = piece.match(/^\{(\w+)\}$/)?.[1];
    return name && name in vars ? vars[name] : piece;
  });
}

/** サーバーが日本語で作った文言（進み具合・待っている理由・知らせ・エラーなど）を今の言語にする。
 * 決まった文はそのまま引き、名前や数が入る文は辞書の patterns（正規表現と置き換え）で引く。どちらにも無ければ元の文のまま。 */
export function serverText(text) {
  if (current === 'ja' || typeof text !== 'string' || !text) return text;
  const server = dictionaries[current]?.server;
  if (!server) return text;
  const exact = server.exact?.[text];
  if (exact !== undefined) return exact;
  for (const [pattern, replace] of server.patterns ?? []) {
    const match = text.match(pattern);
    if (match) return typeof replace === 'function' ? replace(...match.slice(1)) : text.replace(pattern, replace);
  }
  return text;
}

/** 数の書き方（区切りなど）を今の言語に合わせる。 */
export function formatNumber(value, options) { return Number(value).toLocaleString(locale(), options); }
/** 名前などの並びを今の言語の書き方でつなぐ（日本語は「、」、英語は「, and」など）。 */
export function formatList(items, options = { type: 'conjunction' }) { return new Intl.ListFormat(locale(), options).format(items.map(String)); }
