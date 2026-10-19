import { formatNumber, t } from './i18n.js';

/** 見張りの画面で使う言葉。道具の名前を、何をしたかの言葉（辞書の文言の名前）に置き換える。 */
const TOOL_LABELS = {
  page_read: 'toolPageRead', browser_form_submit: 'toolBrowserFormSubmit', browser_request_submit: 'toolBrowserRequestSubmit', web_download: 'toolWebDownload',
  workspace_write: 'toolWorkspaceWrite', workspace_share: 'toolWorkspaceShare', program_run: 'toolProgramRun', execution_start: 'toolExecutionStart',
  environment_prepare: 'toolEnvironmentPrepare', environment_test: 'toolEnvironmentTest', environment_activate: 'toolEnvironmentActivate', environment_retire: 'toolEnvironmentRetire',
  packages_install: 'toolPackagesInstall',
};
export function toolLabel(tool) {
  if (Object.hasOwn(TOOL_LABELS, tool)) return t(`records.${TOOL_LABELS[tool]}`);
  const mcp = /^mcp_([a-z][a-z0-9_]{0,19}?)_(.+)$/.exec(String(tool || ''));
  return mcp ? t('records.toolMcp', { server: mcp[1], tool: mcp[2] }) : t('records.toolOther', { tool: tool || t('records.toolUnknown') });
}

/** いまの仕事を「動いている」と「待っている」に分ける。
 * 動いているのは、実行中で一時停止していない仕事だけ。順番待ち・入力や承認の判断待ち・一時停止中は、待っている側に入れる。 */
export function splitWork(items) {
  const moving = [], waiting = [];
  for (const item of items || []) (item.state === 'running' && !item.paused ? moving : waiting).push(item);
  return { moving, waiting };
}

/** 「記録あり／結果不明」。記録ありは、実行の結果が返ってきたことの記録で、相手側で意図どおりになった証明ではない。 */
export const outcomeLabel = item => t(item.outcome === 'recorded' ? (item.failed ? 'records.outcomeRecordedFailed' : 'records.outcomeRecorded') : 'records.outcomeUnknown');

/** 「3分前」のような、今からの近さ。未来や読めない時刻は空にする。 */
export function agoLabel(at, now) {
  const diff = Number(now) - Number(at);
  if (!Number.isFinite(diff) || !at || diff < 0) return '';
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return t('records.agoNow');
  if (minutes < 60) return t('records.agoMinutes', { count: minutes });
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? t('records.agoHours', { count: hours }) : t('records.agoDays', { count: Math.floor(hours / 24) });
}

/** 上限に対する使った量。上限がなければ使った量だけを示す。 */
export function limitLabel(used, limit) {
  return limit ? t('records.limitUsed', { used: formatNumber(used || 0), limit: formatNumber(limit) }) : t('records.limitUsedOnly', { used: formatNumber(used || 0) });
}

/** 今夜の上限の状態。下見をしていない夜や、決めていない夜はそう書く。 */
export function nightLine(night) {
  if (!night) return '';
  if (night.decision === 'skipped') return t('records.nightSkipped');
  if (night.decision === 'approved') return t(night.in_night ? 'records.nightApproved' : 'records.nightApprovedNotStarted', { usage: limitLabel(night.used, night.limit) });
  return t(night.preview ? 'records.nightUndecided' : 'records.nightPreviewOff');
}
