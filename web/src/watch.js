/** 見張りの画面で使う言葉。道具の名前を、何をしたかの言葉に置き換える。 */
const TOOL_LABELS = {
  page_read: 'ページの取得', browser_form_submit: 'フォームの送信', browser_request_submit: 'ページからの送信', web_download: 'ファイルの取得',
  workspace_write: '共有フォルダーへの書き込み', workspace_share: 'ファイルの共有', program_run: 'プログラムの実行', execution_start: '実行の開始',
  environment_prepare: '実行環境の準備', environment_test: '実行環境の試し', environment_activate: '実行環境の切り替え', environment_retire: '実行環境の片付け',
  packages_install: '部品（パッケージ）の追加',
};
export function toolLabel(tool) {
  if (TOOL_LABELS[tool]) return TOOL_LABELS[tool];
  const mcp = /^mcp_([a-z][a-z0-9_]{0,19}?)_(.+)$/.exec(String(tool || ''));
  return mcp ? `MCPの操作（${mcp[1]}：${mcp[2]}）` : `そのほかの操作（${tool || '不明'}）`;
}

/** いまの仕事を「動いている」と「待っている」に分ける。
 * 動いているのは、実行中で一時停止していない仕事だけ。順番待ち・入力や承認の判断待ち・一時停止中は、待っている側に入れる。 */
export function splitWork(items) {
  const moving = [], waiting = [];
  for (const item of items || []) (item.state === 'running' && !item.paused ? moving : waiting).push(item);
  return { moving, waiting };
}

/** 「記録あり／結果不明」。記録ありは、実行の結果が返ってきたことの記録で、相手側で意図どおりになった証明ではない。 */
export const outcomeLabel = item => item.outcome === 'recorded' ? (item.failed ? '記録あり（失敗の記録）' : '記録あり') : '結果不明';

/** 「3分前」のような、今からの近さ。未来や読めない時刻は空にする。 */
export function agoLabel(at, now) {
  const diff = Number(now) - Number(at);
  if (!Number.isFinite(diff) || !at || diff < 0) return '';
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'たった今';
  if (minutes < 60) return `${minutes}分前`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}時間前` : `${Math.floor(hours / 24)}日前`;
}

/** 上限に対する使った量。上限がなければ使った量だけを示す。 */
export function limitLabel(used, limit) {
  return limit ? `${Number(used || 0).toLocaleString('ja-JP')} / ${Number(limit).toLocaleString('ja-JP')}回` : `${Number(used || 0).toLocaleString('ja-JP')}回`;
}

/** 今夜の上限の状態。下見をしていない夜や、決めていない夜はそう書く。 */
export function nightLine(night) {
  if (!night) return '';
  if (night.decision === 'skipped') return '今夜は休ませると決めています。';
  if (night.decision === 'approved') return `今夜の上限：モデル呼び出し ${limitLabel(night.used, night.limit)}${night.in_night ? '' : '（夜はまだ始まっていません）'}`;
  return night.preview ? '今夜の計画はまだ決めていません。決めるまで夜の自発活動は始まりません。' : '夜の下見はオフです。夜も昼と同じ枠で動きます。';
}
