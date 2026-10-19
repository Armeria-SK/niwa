import { Avatar } from './components.jsx';
import { t } from './i18n.js';

/** 庭に置くのは6体まで。並べる位置（左からの割合）と、地面からの高さを順に使う。 */
const SPOTS = { 1: [50], 2: [30, 66], 3: [18, 48, 78], 4: [16, 38, 60, 84], 5: [12, 31, 50, 69, 88], 6: [10, 26, 42, 58, 74, 90] };
const HEIGHTS = [74, 46, 58, 80, 50, 66];
const MAX_BOTS = 6;

/** Botの今の様子を、短いことばと動きの種類にする。 */
function botState(member, paused) {
  if (member.status === 'sleeping') return { kind: 'sleep', text: t('today.botDormant') };
  if (paused) return { kind: 'still', text: t('today.workPaused') };
  const text = (member.activity || '').split(' · ')[0] || t('today.botIdle');
  return { kind: member.runtimeMotion === 'work' ? 'work' : member.runtimeMotion === 'wait' ? 'wait' : 'still', text };
}

/** きょうの画面の上に描く庭。Botたちが今の様子といっしょに並び、押すとそのBotを開く。 */
export function GardenScene({ members, paused, onMember }) {
  const states = members.map(member => ({ member, ...botState(member, paused) }));
  const count = kind => states.filter(item => item.kind === kind).length;
  const shown = [...states.filter(item => item.kind !== 'sleep'), ...states.filter(item => item.kind === 'sleep')].slice(0, MAX_BOTS);
  const lefts = SPOTS[shown.length] || [];
  return <section className="today-hero" aria-labelledby="garden-title">
    <div className="garden-scene" aria-hidden="true">
      <svg viewBox="0 0 1200 280" preserveAspectRatio="xMidYMax slice">
        <circle cx="1046" cy="66" r="70" fill="#F6EBCB" opacity=".35" />
        <circle cx="1046" cy="66" r="44" fill="#F6EBCB" />
        <g className="cloud"><ellipse cx="160" cy="64" rx="64" ry="16" fill="#FFFFFF" opacity=".7" /><ellipse cx="196" cy="54" rx="38" ry="14" fill="#FFFFFF" opacity=".7" /></g>
        <g className="cloud two"><ellipse cx="520" cy="44" rx="48" ry="11" fill="#FFFFFF" opacity=".6" /><ellipse cx="548" cy="36" rx="26" ry="10" fill="#FFFFFF" opacity=".6" /></g>
        <path d="M0 176 C 160 126 300 136 430 156 C 560 176 640 126 780 124 C 920 122 1040 156 1200 138 L1200 280 L0 280 Z" fill="#DCE7D7" />
        <path d="M0 208 C 120 184 240 176 380 190 C 520 204 600 184 720 180 C 860 176 980 198 1200 184 L1200 280 L0 280 Z" fill="#CCDDC8" />
        <g transform="translate(78 120)"><rect x="-5" y="34" width="10" height="44" rx="4" fill="#B8A089" /><circle cx="0" cy="22" r="34" fill="#B5CFAE" /><circle cx="-22" cy="40" r="22" fill="#A8C6A1" /><circle cx="22" cy="38" r="24" fill="#A2C19B" /></g>
        <g transform="translate(1128 108)"><rect x="-5" y="40" width="10" height="48" rx="4" fill="#B39780" /><circle cx="0" cy="26" r="32" fill="#E7B48C" /><circle cx="-20" cy="44" r="20" fill="#DE9E72" /><circle cx="20" cy="42" r="22" fill="#E2A97F" /></g>
        <path className="leaf" d="M1100 140 q6 -6 12 0 q-6 6 -12 0z" fill="#D98E5E" />
        <path className="leaf b" d="M1140 132 q6 -6 12 0 q-6 6 -12 0z" fill="#E2A97F" />
        <path className="leaf c" d="M1118 150 q5 -5 10 0 q-5 5 -10 0z" fill="#C97D4E" />
        <path d="M0 236 C 200 224 400 230 600 228 C 800 226 1000 232 1200 224 L1200 280 L0 280 Z" fill="#ECE6D6" />
        <path d="M0 248 C 200 236 400 242 600 240 C 800 238 1000 244 1200 236" fill="none" stroke="#DCD4BF" strokeWidth="1.5" />
        <path d="M0 259 C 200 247 400 253 600 251 C 800 249 1000 255 1200 247" fill="none" stroke="#DCD4BF" strokeWidth="1.5" />
        <path d="M0 270 C 200 258 400 264 600 262 C 800 260 1000 266 1200 258" fill="none" stroke="#DCD4BF" strokeWidth="1.5" />
        <ellipse cx="760" cy="246" rx="76" ry="13" fill="#D3E3E6" />
        <ellipse className="pond-ring" cx="760" cy="246" rx="60" ry="9" fill="none" stroke="#B9D2D7" strokeWidth="1.5" />
        <ellipse className="pond-ring b" cx="760" cy="246" rx="60" ry="9" fill="none" stroke="#B9D2D7" strokeWidth="1.5" />
        <ellipse cx="300" cy="250" rx="30" ry="9" fill="#CFCBBE" />
        <ellipse cx="342" cy="255" rx="15" ry="5" fill="#DAD6CA" />
        <ellipse cx="980" cy="252" rx="26" ry="8" fill="#CFCBBE" />
        <path className="grass" d="M210 222 c1 -8 2 -12 5 -17 M216 222 c0 -9 1 -13 4 -19 M222 222 c-1 -6 0 -10 3 -13" fill="none" stroke="#8FB08A" strokeWidth="2" strokeLinecap="round" />
        <path className="grass b" d="M560 214 c1 -8 2 -12 5 -17 M566 214 c0 -9 1 -13 4 -19 M572 214 c-1 -6 0 -10 3 -13" fill="none" stroke="#8FB08A" strokeWidth="2" strokeLinecap="round" />
        <path className="grass c" d="M890 220 c1 -8 2 -12 5 -17 M896 220 c0 -9 1 -13 4 -19 M902 220 c-1 -6 0 -10 3 -13" fill="none" stroke="#8FB08A" strokeWidth="2" strokeLinecap="round" />
        <path className="grass" d="M1060 226 c1 -8 2 -12 5 -17 M1066 226 c0 -9 1 -13 4 -19" fill="none" stroke="#8FB08A" strokeWidth="2" strokeLinecap="round" />
      </svg>
    </div>
    <div className="garden-head">
      <h2 className="glass" id="garden-title">{t('today.gardenHeading')}</h2>
      {count('work') ? <span className="attention-chip ok glass">{t('today.gardenWorking', { count: count('work') })}</span> : null}
      {count('wait') ? <span className="attention-chip warn glass">{t('today.gardenWaiting', { count: count('wait') })}</span> : null}
      {count('still') ? <span className="attention-chip muted glass">{t(paused ? 'today.gardenPaused' : 'today.gardenFree', { count: count('still') })}</span> : null}
      {count('sleep') ? <span className="attention-chip muted glass">{t('today.gardenSleeping', { count: count('sleep') })}</span> : null}
    </div>
    {shown.map(({ member, kind, text }, index) => <div key={member.id} className="garden-spot" style={{ left: `${lefts[index]}%`, bottom: `calc(${HEIGHTS[index]}px * var(--garden-lift, 1))` }}>
      <button type="button" className="garden-bot" aria-label={t('today.gardenBotLabel', { name: member.name, state: text })} onClick={() => onMember(member.id)}>
        <span className={`garden-tag ${kind}`} style={{ animationDelay: `${300 + index * 120}ms` }}><strong>{member.name}</strong><span>{text}</span></span>
        <Avatar member={member} size={60} />
        <span className={`garden-shadow ${kind === 'work' ? 'work' : ''}`} aria-hidden="true" />
        {kind === 'sleep' ? <><span className="garden-z" aria-hidden="true">z</span><span className="garden-z b" aria-hidden="true">z</span></> : null}
      </button>
    </div>)}
    {states.length > MAX_BOTS ? <span className="garden-more attention-chip muted glass">{t('today.gardenMore', { count: states.length - MAX_BOTS })}</span> : null}
  </section>;
}
