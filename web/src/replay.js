/** 経過の再生で使う言葉。記録の種類ごとに、見出し・中身・色を決める。 */
const EVENTS = { queued: '実行待ち', running: '実行を開始', completed: '完了', failed: '失敗', cancelled: '中止', waiting_child: 'ほかのBotの結果を待機', waiting_user: '確認・回答を待機',
  waiting_provider: '接続・モデルの回復を待機', paused: '一時停止', resumed: '再開', instructed: '追加指示を保存', retried: '再試行', interrupted: '中断' };
const PHASES = { work: '返答・作業', memory_review: '記憶の整理', task_summary_save: '結果の整理', read_recovery: '調べ方の立て直し', read_recovery_report: '確認できた範囲のまとめ' };
const STATUSES = { completed: '完了', failed: '失敗', discarded: '使わなかった', unknown: '結果不明' };
const LINKS = { request: '依頼', response: '返答', progress: '途中の報告', followup: '追加の発言', amend: '依頼の修正', cancel: '中止の依頼' };
const DECISIONS = { approved: '承認した', declined: '見送った', auto: '任せた範囲で自動' };

export function replayItemView(item) {
  const tokens = item.input_tokens != null ? `入力${item.input_tokens.toLocaleString('ja-JP')}・出力${(item.output_tokens ?? 0).toLocaleString('ja-JP')}` : `入力の見積もり${Number(item.estimated_input_tokens || 0).toLocaleString('ja-JP')}`;
  switch (item.type) {
    case 'event': return { label: '状態', detail: EVENTS[item.code] || item.code, tone: item.code === 'failed' ? 'danger' : item.code === 'completed' ? 'ok' : 'info' };
    case 'model': return { label: 'モデル呼び出し', detail: `${PHASES[item.phase] || item.phase}：${STATUSES[item.status] || item.status}（${tokens}）`, tone: item.status === 'failed' ? 'danger' : 'info' };
    case 'tool': return { label: `道具 ${item.name}`, detail: [item.args, item.failed ? '→ 失敗' : item.result ? `→ ${item.result}` : ''].filter(Boolean).join(' '), tone: item.failed ? 'danger' : 'info' };
    case 'outside': return { label: `外部への操作 ${item.name}`, detail: item.outcome === 'recorded' ? '記録あり' : '結果不明', tone: item.outcome === 'recorded' ? 'ok' : 'warn' };
    case 'message': return { label: `${LINKS[item.link] || '発言'}（${item.author}）`, detail: item.text, tone: 'ok' };
    case 'instruction': return { label: '追加の指示', detail: item.text, tone: 'warn' };
    case 'note': return { label: '作業メモ', detail: item.text, tone: 'info' };
    case 'approval': return { label: '承認', detail: DECISIONS[item.decision] || item.decision, tone: item.decision === 'declined' ? 'danger' : 'ok' };
    default: return { label: '記録', detail: '', tone: 'info' };
  }
}

/** 時刻の表示（日本時間・時:分:秒）。 */
export const replayTime = at => new Date(at).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour12: false });
