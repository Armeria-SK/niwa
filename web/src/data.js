export const SHAPES = [
  { id: 'pebble', name: 'まる' },
  { id: 'triangle', name: 'さんかく' },
  { id: 'diamond', name: 'ひし形' },
  { id: 'bean', name: 'まめ' },
  { id: 'cloud', name: 'くも' },
  { id: 'droplet', name: 'しずく' },
  { id: 'heart', name: 'ハート' },
  { id: 'star', name: 'ほし' },
  { id: 'crescent', name: 'つき' },
  { id: 'capsule', name: 'カプセル' },
  { id: 'square', name: 'しかく' },
  { id: 'puddle', name: 'みずたま' },
  { id: 'ghost', name: 'おばけ' },
  { id: 'bunny', name: 'うさぎ' },
  { id: 'cat', name: 'ねこ' },
  { id: 'bear', name: 'くま' },
  { id: 'mushroom', name: 'きのこ' },
  { id: 'bell', name: 'すず' },
  { id: 'peanut', name: 'ピーナツ' },
  { id: 'comet', name: 'ながれぼし' },
];

/** アイコンの動き。Botのプロフィールで選べる値と、その呼び名。 */
export const MOTIONS = [{ value: 'auto', label: '状態に合わせる' }, { value: 'none', label: 'なし' }, { value: 'float', label: 'ふわふわ' }, { value: 'sway', label: 'ゆらゆら' }, { value: 'pulse', label: 'ぽよぽよ' }];

/** 配色テーマ。preview は設定の見本に描く色（地・左の列・紙・主色・選んだものの地）で、themes.css の値と同じにする。 */
export const THEMES = [
  { id: 'auto', name: '自動', description: '端末の明るさに合わせる（ガーデン／ミッドナイト）', preview: { canvas: '#f4f3ee', rail: '#18242e', paper: '#ffffff', accent: '#2f6b4f', soft: '#26453d' } },
  { id: 'garden', name: 'ガーデン', description: '生成りの白と苔の緑', preview: { canvas: '#f4f3ee', rail: '#ecebe4', paper: '#ffffff', accent: '#2f6b4f', soft: '#e4efe7' } },
  { id: 'sand', name: 'サンド', description: '砂色とテラコッタ', preview: { canvas: '#f5eee4', rail: '#eee2d3', paper: '#fffbf5', accent: '#96583c', soft: '#f0e1d3' } },
  { id: 'mist', name: 'ミスト', description: '澄んだ青とスレート', preview: { canvas: '#edf3f6', rail: '#e2ecf2', paper: '#fafdff', accent: '#3f6e87', soft: '#dce9f1' } },
  { id: 'lilac', name: 'ライラック', description: '淡い紫とプラム', preview: { canvas: '#f3eef7', rail: '#ece3f2', paper: '#fffcff', accent: '#79538a', soft: '#ebe0f2' } },
  { id: 'blossom', name: 'ブロッサム', description: '桜色の白とローズ', preview: { canvas: '#f8f1f2', rail: '#f1e5e8', paper: '#fffcfd', accent: '#a8476a', soft: '#f7e7ed' } },
  { id: 'honey', name: 'ハニー', description: '生成りと蜂蜜色', preview: { canvas: '#f8f3e6', rail: '#f1e8d3', paper: '#fffdf7', accent: '#8e5810', soft: '#f6ead0' } },
  { id: 'lagoon', name: 'ラグーン', description: '澄んだ水色とティール', preview: { canvas: '#eef6f5', rail: '#e2efed', paper: '#fbfefe', accent: '#19706b', soft: '#dcefec' } },
  { id: 'night', name: 'ミッドナイト', description: '深いネイビーとミント', preview: { canvas: '#18242e', rail: '#14202a', paper: '#20313e', accent: '#94ccb8', soft: '#26453d' } },
  { id: 'forest', name: 'フォレスト', description: '深い森の緑と若葉', preview: { canvas: '#142019', rail: '#101a14', paper: '#1b2a21', accent: '#8fd19e', soft: '#23402d' } },
  { id: 'twilight', name: 'トワイライト', description: '夕暮れの藍とラベンダー', preview: { canvas: '#1a1a2e', rail: '#151527', paper: '#23233a', accent: '#b9a6f2', soft: '#34305a' } },
  { id: 'graphite', name: 'グラファイト', description: '墨色の灰とアプリコット', preview: { canvas: '#1c1d1f', rail: '#17181a', paper: '#252629', accent: '#f0a983', soft: '#45332a' } },
];

export const PALETTE = [
  { color: '#61B8A5', name: 'ミント' },
  { color: '#EFA12E', name: 'アンバー' },
  { color: '#6765ED', name: 'ブルー' },
  { color: '#9463E5', name: 'ラベンダー' },
  { color: '#EF7770', name: 'コーラル' },
  { color: '#718491', name: 'スレート' },
];

export const initialSettings = {
  theme: 'auto', language: 'ja',
  rules: 'それぞれの関心を大切にしながら、自由に調べ、話し、作ってください。\n他のBotの個別記憶は読みません。共有したいことは会話や成果物を通して伝えます。\n購入・契約・アカウント作成・メール送信・SNS以外の外部公開は、事前にユーザーへ相談してください。',
  maxMembers: 10, unlimited: true, concurrent: 3, autonomous: true,
  backupDays: 14, backupTime: '03:00', backupEnabled: true,
};


export function uid(prefix) { return prefix + '-' + crypto.randomUUID(); }
