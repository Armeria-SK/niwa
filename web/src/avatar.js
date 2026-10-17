/** Botのアイコンの部品と動き。形のSVGは、1本のパスに「体の輪郭・目・目」が順に入っている（目は体にあけた穴）。 */

/** SVGの文字列から、体と目のパスを取り出す。目は瞬きで別に動かすので、穴として別に持つ。 */
export function avatarParts(svg) {
  const d = /<path\b[^>]*\sd="([^"]+)"/.exec(String(svg))?.[1] || '';
  const [body = '', ...eyes] = d.split(/(?=M)/).map(part => part.trim()).filter(Boolean);
  return { body, eyes };
}

/** 「状態に合わせる」ときの動き。kind は memberWork の値（running・waiting・paused・idle・sleeping）。 */
export const stateMotion = kind => ({ running: 'work', waiting: 'wait', sleeping: 'sleep' })[kind] || 'idle';

/** 実際に付ける動き。休眠中は目を閉じ、「なし」は止めたまま（瞬きもしない）、一時停止中は動かずに瞬きだけする。
 * 見本（preview）では「状態に合わせる」を作業中の動きで見せる。お祝いは「状態に合わせる」のときだけ。 */
export function avatarMotion({ preference = 'auto', runtime, sleeping = false, paused = false, preview = false }) {
  if (sleeping) return 'sleep';
  if (preference === 'none') return 'none';
  if (preference !== 'auto') return paused ? 'idle' : preference;
  if (preview) return 'work';
  if (runtime === 'celebrate') return 'celebrate';
  return paused ? 'idle' : runtime || 'idle';
}

/** 瞬きの間合い。Botごとに少しずつずらし、全員が同時に瞬きしないようにする（同じBotはいつも同じ間合い）。 */
export function blinkTiming(seed) {
  let hash = 0;
  for (const char of String(seed || '')) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  return { period: 4.2 + (hash % 25) / 10, delay: -((hash >>> 5) % 60) / 10 };
}
