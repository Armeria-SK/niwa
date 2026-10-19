import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import { serverText, t } from './i18n.js';

/** Claudeの接続設定が変わったことを各モデル選択へ知らせる。 */
export const ANTHROPIC_CHANGED = 'niwa:anthropic-changed';
export const notifyAnthropicChanged = () => window.dispatchEvent(new Event(ANTHROPIC_CHANGED));

/** APIキーが保存されていれば、そのキーで使えるClaudeのモデルを新しい順に取得する。キーの保存・削除後は自動で取り直す。
 * enabled を外すと取りに行かない（親が取った一覧を使い回すとき）。 */
export function useAnthropicModels(enabled = true) {
  // error はサーバーの文のまま覚え、listFailed（一覧を取れなかった）と合わせて、描くときに今の言語の文にする。
  const [state, setState] = useState({ keyConfigured: false, models: [], error: '', listFailed: false, manual: false, loading: true });
  const reload = useCallback(async () => {
    setState(current => ({ ...current, loading: true }));
    try {
      const status = await api('/anthropic');
      if (!status.keyConfigured) { setState({ keyConfigured: false, models: [], error: '', listFailed: false, manual: false, loading: false }); return; }
      try { setState({ keyConfigured: true, models: await api('/anthropic/models'), error: '', listFailed: false, manual: false, loading: false }); }
      catch {
        // 一覧を取得できない理由を確認し、キーが拒否された場合以外はモデルIDの直接入力を許す。
        const check = await api('/anthropic/check', 'POST', {}).catch(() => ({ ok: false, code: 'UNKNOWN', message: '' }));
        const rejected = ['AUTHENTICATION_FAILED', 'PERMISSION_DENIED'].includes(check.code);
        setState({ keyConfigured: true, models: [], error: check.ok ? '' : check.message || '', listFailed: !check.ok, manual: !rejected, loading: false });
      }
    } catch (error) { setState({ keyConfigured: false, models: [], error: error.message, listFailed: false, manual: false, loading: false }); }
  }, []);
  useEffect(() => {
    if (!enabled) return undefined;
    void reload();
    window.addEventListener(ANTHROPIC_CHANGED, reload);
    return () => window.removeEventListener(ANTHROPIC_CHANGED, reload);
  }, [reload, enabled]);
  const { listFailed, ...rest } = state;
  const message = state.error ? serverText(state.error) : listFailed ? t('settings.claudeListFailed') : '';
  return { ...rest, error: listFailed && state.manual ? t('settings.claudeListFailedManual', { message }) : message, reload };
}
