/** 接続先を1枚のカードにまとめる。見出しに名前・一言・状態を出し、設定の欄は開いたときだけ見せる。
 * tone は状態の色（ok：つながっている、warn：途中、muted：まだ）。 */
export function ConnectionCard({ title, tag, summary, state, tone = 'muted', children }) {
  return <details className="connection-card">
    <summary>
      <span className="connection-card-title"><strong>{title}</strong>{tag ? <span className="attention-chip warn">{tag}</span> : null}</span>
      <span className="connection-card-summary">{summary}</span>
      <span className="connection-card-foot"><span className={`attention-chip ${tone}`}>{state}</span><span className="connection-card-toggle" aria-hidden="true" /></span>
    </summary>
    <div className="connection-card-body">{children}</div>
  </details>;
}
