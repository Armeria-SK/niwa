import { redactSecrets } from '../../shared/redaction.ts';
import type { DigestBody, DigestDelta, DigestItem, DigestSection } from '../../domain/room-digest.ts';

/** A room message as the merge sees it: who wrote it and where it sits in the room. */
export type DigestSource = { author_id: string; rowid: number };
export type MergeResult = { body: DigestBody; applied: number; rejected: number } | { rejectedAll: true; applied: 0; rejected: number };

/** The rendered digest stays within about 8k estimated tokens (Niwa estimates bytes/3). */
const MAX_BYTES = 24_000;
const MAX_STUBS = 60;
/** Oldest first, these lose their full text first when the digest is too long; administrator items last. */
const COMPACT_ORDER: DigestSection[] = ['topic', 'artifact', 'decision', 'open_request', 'agreement', 'administrator'];
const ADMIN = 'administrator';

const excerpt = (text: string, size: number) => [...text].length > size ? `${[...text].slice(0, size - 1).join('')}…` : text;
const authorsOf = (sources: readonly string[], room: ReadonlyMap<string, DigestSource>) => [...new Set(sources.map(id => room.get(id)!.author_id))].slice(0, 3);

/**
 * Applies a model's delta to the previous digest. The model never rewrites the digest: every item it does not mention is carried forward
 * unchanged, sources must be messages of this room up to the new cutoff, and the server decides authors and authority.
 */
export function mergeDigest(previous: DigestBody, delta: DigestDelta, room: ReadonlyMap<string, DigestSource>, oldCutoff: number, newCutoff: number, revision: number): MergeResult {
  const cited = (sources: readonly string[]) => sources.every(id => { const source = room.get(id); return !!source && source.rowid <= newCutoff; });
  const fresh = (sources: readonly string[]) => sources.filter(id => room.get(id)!.rowid > oldCutoff);
  const body: DigestBody = structuredClone(previous);
  let applied = 0, rejected = 0;
  for (const add of delta.add) {
    if (!cited(add.sources)) { rejected++; continue; }
    const authors = authorsOf(add.sources, room);
    // Only the administrator's own words make an administrator item; an agreement needs two parties or the administrator.
    const section: DigestSection = add.section === 'administrator' && !authors.every(author => author === ADMIN) ? 'topic'
      : add.section === 'agreement' && authors.length < 2 && !authors.includes(ADMIN) ? 'decision' : add.section;
    body.items.push({ id: `d${body.next_id++}`, section, text: redactSecrets(add.text), sources: add.sources, authors, created_rev: revision, updated_rev: revision });
    applied++;
  }
  const changeable = (id: string, sources: readonly string[]): DigestItem | undefined => {
    const item = body.items.find(candidate => candidate.id === id);
    if (!item || item.admin_edited || !cited(sources)) return undefined;
    const added = fresh(sources);
    if (!added.length) return undefined;
    const newAuthors = new Set(added.map(source => room.get(source)!.author_id));
    if (item.section === 'administrator' && !newAuthors.has(ADMIN)) return undefined;
    if (item.section === 'agreement' && !newAuthors.has(ADMIN) && !item.authors.some(author => newAuthors.has(author))) return undefined;
    return item;
  };
  for (const update of delta.update) {
    const item = changeable(update.id, update.sources);
    if (!item) { rejected++; continue; }
    item.text = redactSecrets(update.text); item.sources = update.sources;
    item.authors = [...new Set([...item.authors, ...authorsOf(update.sources, room)])].slice(0, 3);
    item.updated_rev = revision; applied++;
  }
  for (const resolve of delta.resolve) {
    const item = changeable(resolve.id, resolve.sources);
    if (!item) { rejected++; continue; }
    body.items = body.items.filter(candidate => candidate !== item);
    body.resolved = [...body.resolved, { id: item.id, excerpt: excerpt(item.text, 80), source: resolve.sources.at(-1)! }].slice(-20);
    applied++;
  }
  const total = applied + rejected;
  if (total && rejected * 2 > total) return { rejectedAll: true, applied: 0, rejected };
  return { body: bound(body, room), applied, rejected };
}

/** Keeps the digest small: the oldest items become cited stubs, and past 60 stubs the oldest fold into a counted range. Nothing goes without a pointer. */
export function bound(body: DigestBody, room: ReadonlyMap<string, DigestSource>): DigestBody {
  const size = () => Buffer.byteLength(JSON.stringify(body));
  const compacted = new Set<DigestSection>();
  for (const section of COMPACT_ORDER) {
    while (size() > MAX_BYTES) {
      const index = body.items.findIndex(item => item.section === section);
      if (index < 0) break;
      const [item] = body.items.splice(index, 1);
      body.stubs.push({ id: item!.id, section, excerpt: excerpt(item!.text, 80), sources: item!.sources });
      compacted.add(section);
    }
  }
  while (body.stubs.length > MAX_STUBS || (size() > MAX_BYTES && body.stubs.length)) {
    // Administrator stubs are the last to fold.
    const index = body.stubs.findIndex(stub => stub.section !== 'administrator');
    const [stub] = body.stubs.splice(index < 0 ? 0 : index, 1);
    const at = (id: string) => room.get(id)?.rowid ?? 0;
    const ids = [...stub!.sources, ...(body.older_items ? [body.older_items.from_message_id, body.older_items.to_message_id] : [])].sort((a, b) => at(a) - at(b));
    body.older_items = { count: (body.older_items?.count ?? 0) + 1, from_message_id: ids[0]!, to_message_id: ids.at(-1)! };
  }
  if ((compacted.has('agreement') || compacted.has('administrator')) && !body.notices.includes('compacted_authority')) body.notices = ['compacted_authority'];
  return body;
}
