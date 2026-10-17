/** 承認の種類を、何をする操作かの言葉にする。 */
export function kindLabel(kind) {
  const value = String(kind || '');
  const mcp = /^mcp:mcp_([a-z][a-z0-9_]{0,19}?)_(.+)$/.exec(value);
  if (mcp) return `MCPの書き込み（${mcp[1]}：${mcp[2]}）`;
  return ({ form: 'Webフォームの送信', page_request: 'ページからの送信', request: '支払い・購入・公開などの承認' })[value] || 'そのほかの操作';
}

/** 任せる提案の文。何回続けて承認したかと、何を聞かずに進めるようになるかを書く。 */
export function suggestionText(item) {
  return `${item.name}の「${kindLabel(item.kind)}」を、${item.streak}回続けてそのまま承認しています。この種類は聞かずに進めてよいですか？`;
}

/** 「あなたの番」に出す提案。急ぎではないので、ほかの項目のあとに並べる。 */
export function trustAttention(suggestions = []) {
  return suggestions.map(item => ({ kind: 'trust', id: `${item.agent_id}:${item.kind}`, title: `${item.name}に任せる範囲の提案`, detail: suggestionText(item), member: item.agent_id, at: item.last_at }));
}
