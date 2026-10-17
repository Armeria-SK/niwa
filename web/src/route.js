/** 画面ごとのURL（#のあと）。共有したり、戻る・進むで行き来したりできるようにする。 */
export const PAGES = ['today', 'conversation', 'bots', 'records', 'settings'];
export const BOT_TABS = ['profile', 'memory', 'procedures', 'export'];
// 「みんなの記憶」は、Botの代わりに everyone を選んだ形で開く（#bots/everyone/conflicts）。
export const EVERYONE_TABS = ['search', 'conflicts'];
export const RECORD_TABS = ['recap', 'running', 'approval', 'artifacts', 'schedules', 'watch'];
export const SETTINGS_TABS = ['theme', 'rules', 'models', 'mcp', 'activity', 'backup'];
// 前の名前のURL（ブックマークや、MCPの認証から戻るページ）もそのまま開けるようにする。
const OLD_NAMES = { members: 'bots', activity: 'records' };
const ID = /^[\w-]{1,128}$/;

/** 「#bots/ID/memory」のような文字を { page, id, tab, task } に読む。読めない部分は捨て、印がなければ「きょう」。 */
export function parseRoute(hash) {
  const [head = '', ...rest] = String(hash || '').replace(/^#/, '').split('/').map(part => { try { return decodeURIComponent(part); } catch { return ''; } });
  const page = OLD_NAMES[head] || head;
  if (!PAGES.includes(page)) return { page: 'today' };
  const [first, second, third] = rest;
  if (page === 'conversation') return ID.test(first || '') ? { page, id: first } : { page };
  if (page === 'bots') return ID.test(first || '') ? { page, id: first, ...((first === 'everyone' ? EVERYONE_TABS : BOT_TABS).includes(second) ? { tab: second } : {}) } : { page };
  if (page === 'records') {
    if (first === 'task' && ID.test(second || '')) return { page, task: second, ...(third === 'replay' ? { replay: true } : {}) };
    return RECORD_TABS.includes(first) ? { page, tab: first } : { page };
  }
  if (page === 'settings') return SETTINGS_TABS.includes(first) ? { page, tab: first } : { page };
  return { page };
}

/** parseRoute の逆。余分な部分は付けない。 */
export function routeHash(route) {
  const { page, id, tab, task, replay } = route, parts = [page];
  if (page === 'conversation' && id) parts.push(id);
  else if (page === 'bots' && id) parts.push(id, ...(tab ? [tab] : []));
  else if (page === 'records') parts.push(...(task ? ['task', task, ...(replay ? ['replay'] : [])] : tab ? [tab] : []));
  else if (page === 'settings' && tab) parts.push(tab);
  return '#' + parts.map(encodeURIComponent).join('/');
}
