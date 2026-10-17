/** 会話ごとに「最後に見たときの発言数」を覚え、その差を未読として数える。記録はこの端末のブラウザーにだけ置く。 */
export const SEEN_KEY = 'niwa-seen-messages';

/** 記録が初めてなら、今ある発言を既読として始める。以後に増えた会話は、記録がなければ全部を未読とする。 */
export function startSeen(rooms, stored) {
  if (stored && typeof stored === 'object' && !Array.isArray(stored)) return stored;
  return Object.fromEntries(rooms.map(room => [room.id, Number(room.message_count) || 0]));
}
export const unreadOf = (room, seen) => seen ? Math.max(0, (Number(room.message_count) || 0) - (Number(seen[room.id]) || 0)) : 0;
export function markSeen(seen, room) {
  const count = Number(room.message_count) || 0;
  return seen && seen[room.id] === count ? seen : { ...seen, [room.id]: count };
}
export function readSeen() { try { return JSON.parse(localStorage.getItem(SEEN_KEY) || 'null'); } catch { return null; } }
export function writeSeen(seen) { try { localStorage.setItem(SEEN_KEY, JSON.stringify(seen)); } catch { /* Storage can be disabled by the browser. */ } }
