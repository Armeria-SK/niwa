import { t } from './i18n.js';

// 名前は今の言語で読む（getter にして、言語を切り替えると呼び名も変わるようにする）。
const cap = id => id[0].toUpperCase() + id.slice(1);
export const SHAPES = ['pebble', 'triangle', 'diamond', 'bean', 'cloud', 'droplet', 'heart', 'star', 'crescent', 'capsule', 'square', 'puddle', 'ghost', 'bunny', 'cat', 'bear', 'mushroom', 'bell', 'peanut', 'comet']
  .map(id => ({ id, get name() { return t(`shell.shape${cap(id)}`); } }));

/** アイコンの動き。Botのプロフィールで選べる値と、その呼び名。 */
export const MOTIONS = [{ value: 'auto', get label() { return t('shell.motionAuto'); } }, { value: 'none', get label() { return t('common.none'); } }, { value: 'float', get label() { return t('shell.motionFloat'); } }, { value: 'sway', get label() { return t('shell.motionSway'); } }, { value: 'pulse', get label() { return t('shell.motionPulse'); } }];

/** 配色テーマ。preview は設定の見本に描く色（地・左の列・紙・主色・選んだものの地）で、themes.css の値と同じにする。 */
const theme = (id, preview) => ({ id, get name() { return t(`shell.theme${cap(id)}`); }, get description() { return t(`shell.theme${cap(id)}Description`); }, preview });
export const THEMES = [
  theme('auto', { canvas: '#f4f3ee', rail: '#18242e', paper: '#ffffff', accent: '#2f6b4f', soft: '#26453d' }),
  theme('garden', { canvas: '#f4f3ee', rail: '#ecebe4', paper: '#ffffff', accent: '#2f6b4f', soft: '#e4efe7' }),
  theme('sand', { canvas: '#f5eee4', rail: '#eee2d3', paper: '#fffbf5', accent: '#96583c', soft: '#f0e1d3' }),
  theme('mist', { canvas: '#edf3f6', rail: '#e2ecf2', paper: '#fafdff', accent: '#3f6e87', soft: '#dce9f1' }),
  theme('lilac', { canvas: '#f3eef7', rail: '#ece3f2', paper: '#fffcff', accent: '#79538a', soft: '#ebe0f2' }),
  theme('blossom', { canvas: '#f8f1f2', rail: '#f1e5e8', paper: '#fffcfd', accent: '#a8476a', soft: '#f7e7ed' }),
  theme('honey', { canvas: '#f8f3e6', rail: '#f1e8d3', paper: '#fffdf7', accent: '#8e5810', soft: '#f6ead0' }),
  theme('lagoon', { canvas: '#eef6f5', rail: '#e2efed', paper: '#fbfefe', accent: '#19706b', soft: '#dcefec' }),
  theme('night', { canvas: '#18242e', rail: '#14202a', paper: '#20313e', accent: '#94ccb8', soft: '#26453d' }),
  theme('forest', { canvas: '#142019', rail: '#101a14', paper: '#1b2a21', accent: '#8fd19e', soft: '#23402d' }),
  theme('twilight', { canvas: '#1a1a2e', rail: '#151527', paper: '#23233a', accent: '#b9a6f2', soft: '#34305a' }),
  theme('graphite', { canvas: '#1c1d1f', rail: '#17181a', paper: '#252629', accent: '#f0a983', soft: '#45332a' }),
];

export const PALETTE = [
  { color: '#61B8A5', get name() { return t('shell.colorMint'); } },
  { color: '#EFA12E', get name() { return t('shell.colorAmber'); } },
  { color: '#6765ED', get name() { return t('shell.colorBlue'); } },
  { color: '#9463E5', get name() { return t('shell.colorLavender'); } },
  { color: '#EF7770', get name() { return t('shell.colorCoral'); } },
  { color: '#718491', get name() { return t('shell.colorSlate'); } },
];

export const initialSettings = {
  theme: 'auto', language: 'ja',
  rules: 'それぞれの関心を大切にしながら、自由に調べ、話し、作ってください。\n他のBotの個別記憶は読みません。共有したいことは会話や成果物を通して伝えます。\n購入・契約・アカウント作成・メール送信・SNS以外の外部公開は、事前にユーザーへ相談してください。',
  maxMembers: 10, unlimited: true, concurrent: 3, autonomous: true,
  backupDays: 14, backupTime: '03:00', backupEnabled: true,
};


export function uid(prefix) { return prefix + '-' + crypto.randomUUID(); }
