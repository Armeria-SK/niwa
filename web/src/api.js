import { t } from './i18n.js';

// サーバーが返すエラーの種類と、画面に出す説明の文言の名前。
const ERRORS = { invalid: 'errorInvalid', conflict: 'errorConflict', forbidden: 'errorForbidden', origin_rejected: 'errorOriginRejected', tailnet_required: 'errorTailnetRequired', rate_limited: 'errorRateLimited', limit: 'errorLimit' };

export async function api(path, method = 'GET', body) {
  const response = await fetch(`/api${path}`, { method, credentials: 'same-origin', cache: 'no-store',
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(t(`shell.${Object.hasOwn(ERRORS, result.error) ? ERRORS[result.error] : 'errorUnknown'}`));
    error.status = response.status; throw error;
  }
  return result;
}
