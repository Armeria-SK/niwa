export async function api(path, method = 'GET', body) {
  const response = await fetch(`/api${path}`, { method, credentials: 'same-origin', cache: 'no-store',
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(({ invalid: '入力内容を確認してください。', conflict: '状態が変わりました。最新の内容を確認してください。', authentication_required: 'ログインしてください。', forbidden: 'この操作は許可されていません。' })[result.error] || '操作を完了できませんでした。設定と接続を確認してください。');
    error.status = response.status; throw error;
  }
  return result;
}
