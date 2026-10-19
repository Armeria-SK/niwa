/** 効果音。音の素材は持たず、Web Audio でその場に短い音を作る。鳴らすかどうかは、この端末のブラウザーにだけ覚える。 */
export const SOUNDS_KEY = 'niwa-sounds';
export const SOUND_KINDS = ['message', 'attention'];
const DEFAULTS = { message: true, attention: true };

export function readSounds() {
  try {
    const saved = JSON.parse(localStorage.getItem(SOUNDS_KEY) || 'null');
    return Object.fromEntries(SOUND_KINDS.map(kind => [kind, typeof saved?.[kind] === 'boolean' ? saved[kind] : DEFAULTS[kind]]));
  } catch { return { ...DEFAULTS }; }
}
export function writeSounds(sounds) { try { localStorage.setItem(SOUNDS_KEY, JSON.stringify(sounds)); } catch { /* Storage can be disabled by the browser. */ } }

/** 比べるための今の様子。会話ごとのBotの発言数と、あなたの返事を待っているもの（承認・質問・止まった仕事）。 */
export function soundSnapshot(rooms, attention) {
  return {
    bots: new Map(rooms.map(room => [room.id, Number(room.bot_message_count) || 0])),
    waiting: new Set(attention.filter(item => item.kind !== 'decisions').map(item => `${item.kind}:${item.id}`)),
  };
}

/** 前の様子と比べて鳴らす音を1つ選ぶ。最初の読み込み（前がない）では鳴らさない。両方なら、返事を待つ音を優先する。 */
export function soundCue(previous, next) {
  if (!previous) return null;
  if ([...next.waiting].some(key => !previous.waiting.has(key))) return 'attention';
  // 新しくできた会話は、前に無かったので0件から数える。
  if ([...next.bots].some(([id, count]) => count > (previous.bots.get(id) ?? 0))) return 'message';
  return null;
}

// 音の高さ（Hz）と、鳴り始めるまでの秒。届いた知らせは柔らかい2音、返事を待つ知らせは上がる3音。
const TONES = { message: [[784, 0], [1047, 0.11]], attention: [[659, 0], [880, 0.12], [1175, 0.24]] };
let context = null;

function audio() {
  if (context) return context;
  const Context = typeof window === 'undefined' ? undefined : window.AudioContext || window.webkitAudioContext;
  if (!Context) return null;
  try { context = new Context(); } catch { return null; }
  return context;
}

/** ブラウザーは、画面に一度触れるまで音を出させない。最初のクリックかキー入力で音を使えるようにしておく。 */
export function unlockSounds() {
  if (typeof window === 'undefined') return () => {};
  const unlock = () => { const ctx = audio(); if (ctx?.state === 'suspended') void ctx.resume().catch(() => {}); };
  window.addEventListener('pointerdown', unlock); window.addEventListener('keydown', unlock);
  return () => { window.removeEventListener('pointerdown', unlock); window.removeEventListener('keydown', unlock); };
}

export function playSound(kind) {
  const ctx = audio(); const tones = TONES[kind];
  if (!ctx || !tones) return;
  // 使えるようになるのを待ってから鳴らす。まだ画面に触れていなければ、鳴らさずに終わる。
  // 触れるまで待たされた古い知らせは、あとから鳴らさない。
  if (ctx.state !== 'running') { const asked = Date.now(); ctx.resume().then(() => { if (ctx.state === 'running' && Date.now() - asked < 1000) schedule(ctx, tones); }, () => {}); return; }
  schedule(ctx, tones);
}

function schedule(ctx, tones) {
  const start = ctx.currentTime + 0.02;
  for (const [frequency, delay] of tones) {
    const at = start + delay, oscillator = ctx.createOscillator(), gain = ctx.createGain();
    oscillator.type = 'sine'; oscillator.frequency.value = frequency;
    // すぐ立ち上がって、木琴のように静かに消える。
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.12, at + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.42);
    oscillator.connect(gain).connect(ctx.destination);
    oscillator.start(at); oscillator.stop(at + 0.45);
  }
}
