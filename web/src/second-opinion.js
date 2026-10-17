import { providerLabel } from './providers.js';

const number = value => Number(value || 0).toLocaleString('ja-JP');

/** 押す前に見せる入力の見積もり。会話を短くしたときは、そのことも書く。 */
export function estimateLabel(estimate) {
  if (!estimate) return '';
  const parts = [estimate.messages != null ? `会話${estimate.messages}件` : null, estimate.memories != null ? `記憶${estimate.memories}件` : null].filter(Boolean);
  return `入力の見積もり：約${number(estimate.estimated_input_tokens)}トークン${parts.length ? `（${parts.join('・')}）` : ''}${estimate.removed_messages ? `。古い発言${estimate.removed_messages}件は入りきらないので外します` : ''}${estimate.truncated ? '。長いので先頭の部分だけを渡します' : ''}`;
}

/** 使った量。接続先が量を返さないときは、送る前の見積もりで示す。 */
export function usedLabel(usage) {
  if (!usage) return '';
  const input = usage.input_tokens ?? usage.estimated_input_tokens;
  return `入力${number(input)}${usage.input_tokens == null ? '（見積もり）' : ''}・出力${usage.output_tokens == null ? '不明' : number(usage.output_tokens)}トークン`;
}

/** モデルの呼び出しがうまくいかなかったときの説明。接続先の言葉ではなく、種類ごとに決めた文で伝える。 */
const FAILURES = {
  AUTH_UNAVAILABLE: 'この接続先は、まだ設定されていないか、ログインが切れています。',
  AUTHENTICATION_FAILED: '接続先に鍵を受け付けてもらえませんでした。',
  PERMISSION_DENIED: 'このモデルを使う許可がありません。',
  RATE_LIMITED: '接続先が混み合っています。少し待ってから試してください。',
  QUOTA_EXCEEDED: '接続先の利用枠に達しています。',
  PROVIDER_UNAVAILABLE: '接続先が応答していません。',
  NETWORK_ERROR: '接続先につながりませんでした。',
  TIMED_OUT: '時間内に答えが届きませんでした。',
  ABORTED: '途中でやめました。',
  INVALID_REQUEST: 'このモデルでは受け付けられない形でした。',
  CAPABILITY_MISMATCH: 'このモデルでは受け付けられない形でした。',
  OUTPUT_LIMIT: '答えが長すぎて途中で切れました。',
  INVALID_RESPONSE: 'モデルの答えを読めませんでした。',
};
export function failureText(failure) {
  if (!failure) return '';
  return `${FAILURES[failure.code] || 'モデルの呼び出しを完了できませんでした。'}（${failure.code}）`;
}

export const CHECK_VERDICTS = { pass: '条件を満たす', fail: '直したほうがよい', unknown: '本文からは判断できない' };

/** 点検の記録を、画面で読む形にする。壊れた記録は空の判断として扱う。 */
export function modelCheckView(row, criteria = []) {
  let checks = [];
  try { checks = JSON.parse(row.checks || '[]'); } catch { checks = []; }
  const [provider, ...rest] = String(row.review_model || '').split('/');
  const reasoning = rest.length > 1 ? rest.pop() : '';
  const model = rest.join('/');
  return { model: `${providerLabel(provider)} ${model}${reasoning && reasoning !== 'native' ? `・推論 ${reasoning}` : ''}`, summary: row.note || '', at: row.created_at,
    current: row.sha256, checks: checks.map(item => ({ ...item, condition: criteria.find(c => c.id === item.criterion)?.condition || (item.criterion === 'overall' ? '全体として、正確で、筋が通り、役に立つか' : '完成条件'), label: CHECK_VERDICTS[item.verdict] || '不明' })) };
}

/** 点検に使える接続先：作ったBotと別の接続先のうち、いまつながっているもの。 */
export function checkProviders(allowed = [], ready = []) {
  return allowed.filter(provider => ready.includes(provider));
}
