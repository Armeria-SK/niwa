import { t } from './i18n.js';

const KINDS = { form: 'kindForm', page_request: 'kindPageRequest', request: 'kindRequest' };

/** 承認の種類を、何をする操作かの言葉にする。 */
export function kindLabel(kind) {
  const value = String(kind || '');
  const mcp = /^mcp:mcp_([a-z][a-z0-9_]{0,19}?)_(.+)$/.exec(value);
  if (mcp) return t('records.kindMcp', { server: mcp[1], tool: mcp[2] });
  return t(`records.${Object.hasOwn(KINDS, value) ? KINDS[value] : 'kindOther'}`);
}

/** 任せる提案の文。何回続けて承認したかと、何を聞かずに進めるようになるかを書く。 */
export function suggestionText(item) {
  return t('records.trustSuggestion', { name: item.name, kind: kindLabel(item.kind), count: item.streak });
}

/** 「あなたの番」に出す提案。急ぎではないので、ほかの項目のあとに並べる。 */
export function trustAttention(suggestions = []) {
  return suggestions.map(item => ({ kind: 'trust', id: `${item.agent_id}:${item.kind}`, title: t('records.trustAttentionTitle', { name: item.name }), detail: suggestionText(item), member: item.agent_id, at: item.last_at }));
}
