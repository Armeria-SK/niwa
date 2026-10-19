import { language } from './i18n.js';

const OPEN = '「『（(', CLOSE = '」』）)';
// 日本語のほかの言語では、“ ” の中でも分けず、英語や韓国語の文の終わり（空白の前の「.」「!」「?」）でも分ける。
const QUOTED_OPEN = OPEN + '“', QUOTED_CLOSE = CLOSE + '”';

/** 文の終わり（「。」）ごとに分ける。かぎかっこや丸かっこの中の「。」では分けない。 */
export function splitSentences(text) {
  const other = language() !== 'ja';
  const open = other ? QUOTED_OPEN : OPEN, close = other ? QUOTED_CLOSE : CLOSE;
  const parts = []; let depth = 0, start = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (open.includes(char)) depth++;
    else if (close.includes(char)) depth = Math.max(0, depth - 1);
    else if (depth === 0 && (char === '。' || (other && '.!?'.includes(char) && /\s/.test(text[index + 1] || '')))) { parts.push(text.slice(start, index + 1)); start = index + 1; }
  }
  parts.push(text.slice(start));
  return parts.map(part => part.trim()).filter(Boolean);
}
