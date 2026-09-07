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

export const THEMES = [
  { id: 'garden', name: 'ガーデン', description: 'やわらかな白とセージ', colors: ['#fafaf7', '#ebefe5', '#46684e'] },
  { id: 'sand', name: 'サンド', description: '砂色とテラコッタ', colors: ['#f5eee4', '#ead8c6', '#96583c'] },
  { id: 'mist', name: 'ミスト', description: '澄んだ青とスレート', colors: ['#edf3f6', '#d4e3ec', '#3f6e87'] },
  { id: 'lilac', name: 'ライラック', description: '淡い紫とプラム', colors: ['#f3eef7', '#e5d9ed', '#79538a'] },
  { id: 'night', name: 'ミッドナイト', description: '深いネイビーとミント', colors: ['#18242e', '#293e4c', '#94ccb8'] },
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
  theme: 'garden',
  rules: 'それぞれの関心を大切にしながら、自由に調べ、話し、作ってください。\n他のBotの個別記憶は読みません。共有したいことは会話や成果物を通して伝えます。\n購入・契約・アカウント作成・メール送信・SNS以外の外部公開は、事前にユーザーへ相談してください。',
  ollamaUrl: 'http://localhost:11434', fallback: '', autoReturn: true,
  leaderModel: 'Astra', leaderEffort: 'low', generatedModel: 'Luna', generatedEffort: 'max',
  maxMembers: 10, unlimited: true, concurrent: 3, autonomous: true,
  backupDays: 14, backupTime: '03:00', backupEnabled: true,
};


export function uid(prefix) { return prefix + '-' + crypto.randomUUID(); }
