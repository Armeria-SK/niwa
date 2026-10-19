import { providerLabel } from './providers.js';
import { t, formatNumber } from './i18n.js';

const number = value => formatNumber(value || 0);

/** 押す前に見せる入力の見積もり。会話を短くしたときは、そのことも書く。 */
export function estimateLabel(estimate) {
  if (!estimate) return '';
  const parts = [estimate.messages != null ? t('conversation.estimateMessages', { count: estimate.messages }) : null, estimate.memories != null ? t('conversation.estimateMemories', { count: estimate.memories }) : null].filter(Boolean);
  return `${t('conversation.estimateTokens', { tokens: number(estimate.estimated_input_tokens) })}${parts.length ? t('conversation.estimateBreakdown', { parts: parts.join(t('conversation.estimateSeparator')) }) : ''}${estimate.removed_messages ? t('conversation.estimateRemoved', { count: estimate.removed_messages }) : ''}${estimate.truncated ? t('conversation.estimateTruncated') : ''}`;
}

/** 使った量。接続先が量を返さないときは、送る前の見積もりで示す。 */
export function usedLabel(usage) {
  if (!usage) return '';
  const input = usage.input_tokens ?? usage.estimated_input_tokens;
  const known = usage.output_tokens != null;
  return t('conversation.usedTokens', { input: number(input), estimated: usage.input_tokens == null ? t('conversation.usedEstimated') : '', output: known ? number(usage.output_tokens) : t('conversation.unknown'), known });
}

/** モデルの呼び出しがうまくいかなかったときの説明。接続先の言葉ではなく、種類ごとに決めた文で伝える（文言は辞書の名前で持つ）。 */
const FAILURES = {
  AUTH_UNAVAILABLE: 'failureAuthUnavailable',
  AUTHENTICATION_FAILED: 'failureAuthenticationFailed',
  PERMISSION_DENIED: 'failurePermissionDenied',
  RATE_LIMITED: 'failureRateLimited',
  QUOTA_EXCEEDED: 'failureQuotaExceeded',
  PROVIDER_UNAVAILABLE: 'failureProviderUnavailable',
  NETWORK_ERROR: 'failureNetworkError',
  TIMED_OUT: 'failureTimedOut',
  ABORTED: 'failureAborted',
  INVALID_REQUEST: 'failureInvalidRequest',
  CAPABILITY_MISMATCH: 'failureInvalidRequest',
  OUTPUT_LIMIT: 'failureOutputLimit',
  INVALID_RESPONSE: 'failureInvalidResponse',
};
export function failureText(failure) {
  if (!failure) return '';
  const key = Object.hasOwn(FAILURES, failure.code) ? FAILURES[failure.code] : 'failureDefault';
  return t('conversation.failureWithCode', { message: t(`conversation.${key}`), code: failure.code });
}

export const CHECK_VERDICTS = {
  get pass() { return t('conversation.verdictPass'); },
  get fail() { return t('conversation.verdictFail'); },
  get unknown() { return t('conversation.verdictUnknown'); },
};

/** 点検の記録を、画面で読む形にする。壊れた記録は空の判断として扱う。 */
export function modelCheckView(row, criteria = []) {
  let checks = [];
  try { checks = JSON.parse(row.checks || '[]'); } catch { checks = []; }
  const [provider, ...rest] = String(row.review_model || '').split('/');
  const reasoning = rest.length > 1 ? rest.pop() : '';
  const model = rest.join('/');
  return { model: `${providerLabel(provider)} ${model}${reasoning && reasoning !== 'native' ? t('conversation.checkReasoning', { reasoning }) : ''}`, summary: row.note || '', at: row.created_at,
    current: row.sha256, checks: checks.map(item => ({ ...item, condition: criteria.find(c => c.id === item.criterion)?.condition || (item.criterion === 'overall' ? t('conversation.checkOverall') : t('conversation.completionCondition')), label: (Object.hasOwn(CHECK_VERDICTS, item.verdict) && CHECK_VERDICTS[item.verdict]) || t('conversation.unknown') })) };
}

/** 点検に使える接続先：作ったBotと別の接続先のうち、いまつながっているもの。 */
export function checkProviders(allowed = [], ready = []) {
  return allowed.filter(provider => ready.includes(provider));
}
