import type { Message } from '../../domain/types.ts';
import { messageTokens } from '../room-digests.ts';

/** Earlier administrator messages stay word for word within this budget, newest first; then as short pointers; then only a count. */
const ADMIN_TOKENS = 8_000, ADMIN_STUBS = 20;
/** A memory review also reads the messages it has not reviewed yet from before the cutoff, oldest first, within this budget. */
const COVERAGE_TOKENS = 12_000;

export type DigestRoom = {
  /** Room messages sent word for word, in room order. */
  selected: Message[];
  /** Earlier administrator messages that did not fit word for word. */
  earlier_administrator: { stubs: { message_id: string; created_at: string; excerpt: string }[]; omitted: number };
  /** The newest message a memory review has now seen without a gap since its mark. */
  reviewed_through?: string;
};

/**
 * The conversation as a task in digest mode sends it: what the digest summarizes (up to the pinned cutoff) is left out, except
 * administrator messages; everything after the cutoff is sent word for word, so later messages only ever append.
 */
export function composeDigestRoom(messages: readonly Message[], rowids: readonly number[], cutoff: number, review?: { mark: string | undefined }): DigestRoom {
  let split = 0;
  while (split < messages.length && rowids[split]! <= cutoff) split++;
  const earlier = messages.slice(0, split), keep = new Set<number>();
  for (let index = split; index < messages.length; index++) keep.add(index);
  let budget = ADMIN_TOKENS;
  const stubs: DigestRoom['earlier_administrator']['stubs'] = [];
  let omitted = 0;
  for (let index = earlier.length - 1; index >= 0; index--) {
    const message = earlier[index]!;
    if (message.author_id !== 'administrator') continue;
    const tokens = messageTokens(message);
    if (tokens <= budget) { budget -= tokens; keep.add(index); }
    else if (stubs.length < ADMIN_STUBS) stubs.unshift({ message_id: message.id, created_at: message.created_at, excerpt: [...message.body].slice(0, 160).join('') });
    else omitted++;
  }
  let reviewed_through: string | undefined;
  if (review) {
    // From the mark on; a Bot reviewing this room for the first time starts 40 messages before the cutoff.
    const marked = review.mark === undefined ? -1 : messages.findIndex(message => message.id === review.mark);
    const start = marked >= 0 ? marked + 1 : Math.max(0, split - 40);
    let room = COVERAGE_TOKENS, last = start - 1, cut = false;
    for (let index = start; index < split; index++) {
      if (!keep.has(index)) {
        const tokens = messageTokens(messages[index]!);
        if (tokens > room) { cut = true; break; }
        room -= tokens; keep.add(index);
      }
      last = index;
    }
    // The mark moves only as far as the review saw every message: to the end of a cut chunk, otherwise to the newest message.
    reviewed_through = cut ? messages[last]?.id : messages.at(-1)?.id;
  }
  return { selected: messages.filter((_message, index) => keep.has(index)), earlier_administrator: { stubs, omitted }, ...(reviewed_through ? { reviewed_through } : {}) };
}
