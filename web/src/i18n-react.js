import { createElement, Fragment, useSyncExternalStore } from 'react';
import { isLanguage, language, parts, setLanguage, subscribeLanguage } from './i18n.js';

/** 今の言語。App が使い、切り替わると画面全体を描き直す。 */
export function useLanguage() { return useSyncExternalStore(subscribeLanguage, language, () => 'ja'); }

/** 文言の {name} に部品を差し込んで描く。例：rich('today.waiting', { count: <strong>{n}</strong> })。 */
export function rich(key, vars) { return createElement(Fragment, null, ...parts(key, vars)); }

// 韓国語と簡体字の中国語は、その言葉の字形のフォントを、選んだときだけ読み込む（日本語のフォントは main.jsx で読む）。
const FONTS = { ko: () => import('@fontsource-variable/noto-sans-kr'), 'zh-CN': () => import('@fontsource-variable/noto-sans-sc') };
const STORAGE = 'niwa-language';

/** 言語を切り替え、その言語のフォントを読み込み、次に開いたときの最初の表示のために覚えておく。 */
export async function applyLanguage(chosen) {
  const id = isLanguage(chosen) ? chosen : 'ja';
  const font = FONTS[id]?.().catch(() => { /* The system font still shows the text. */ });
  await setLanguage(id);
  try { localStorage.setItem(STORAGE, id); } catch { /* Storage can be disabled by the browser. */ }
  await font;
}
/** 前に開いたときの言語。サーバーの設定が届くまでの最初の表示に使う。 */
export function rememberedLanguage() { try { return localStorage.getItem(STORAGE) || 'ja'; } catch { return 'ja'; } }
