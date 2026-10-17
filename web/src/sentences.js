const OPEN = '「『（(', CLOSE = '」』）)';

/** 文の終わり（「。」）ごとに分ける。かぎかっこや丸かっこの中の「。」では分けない。 */
export function splitSentences(text) {
  const parts = []; let depth = 0, start = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (OPEN.includes(char)) depth++;
    else if (CLOSE.includes(char)) depth = Math.max(0, depth - 1);
    else if (char === '。' && depth === 0) { parts.push(text.slice(start, index + 1)); start = index + 1; }
  }
  parts.push(text.slice(start));
  return parts.map(part => part.trim()).filter(Boolean);
}
