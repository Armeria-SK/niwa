const day = value => { const time = Number(value); return Number.isFinite(time) && time > 0 ? new Date(time).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' }) : ''; };

/** 手順を何回使ったかと、止めているかを一言で表す。 */
export function procedureUse(item) {
  const last = day(item.last_used_at);
  const use = item.uses ? `${item.uses}回使った${last ? `・最後は${last}` : ''}` : 'まだ使っていません';
  return item.enabled ? use : `止めています（${use}）`;
}
