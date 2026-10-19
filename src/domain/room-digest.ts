import { Type, type Static } from '@sinclair/typebox';

/** What a 会話のまとめ item records. The server, not the model, decides the authors and whether an item may claim agreement or administrator authority. */
export const DIGEST_SECTIONS = ['decision', 'agreement', 'open_request', 'administrator', 'topic', 'artifact'] as const;
export type DigestSection = typeof DIGEST_SECTIONS[number];
const section = Type.Union(DIGEST_SECTIONS.map(name => Type.Literal(name)));
const id = Type.String({ minLength: 1, maxLength: 16, pattern: '^d[0-9]+$' });
const sources = Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { minItems: 1, maxItems: 3 });

export const digestItemSchema = Type.Object({
  id, section, text: Type.String({ minLength: 1, maxLength: 300 }), sources, authors: Type.Array(Type.String({ maxLength: 64 }), { maxItems: 3 }),
  admin_edited: Type.Optional(Type.Literal(true)), created_rev: Type.Integer({ minimum: 1 }), updated_rev: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false });
export type DigestItem = Static<typeof digestItemSchema>;
export const digestBodySchema = Type.Object({
  items: Type.Array(digestItemSchema),
  /** Older items kept as a pointer: a short excerpt and where to read the original. */
  stubs: Type.Array(Type.Object({ id, section, excerpt: Type.String({ maxLength: 80 }), sources }, { additionalProperties: false })),
  older_items: Type.Union([Type.Null(), Type.Object({ count: Type.Integer({ minimum: 1 }), from_message_id: Type.String(), to_message_id: Type.String() }, { additionalProperties: false })]),
  resolved: Type.Array(Type.Object({ id, excerpt: Type.String({ maxLength: 80 }), source: Type.String() }, { additionalProperties: false }), { maxItems: 20 }),
  /** Codes the screen explains in the display language. compacted_authority: agreement or administrator items were shortened to pointers. */
  notices: Type.Array(Type.Literal('compacted_authority'), { maxItems: 1 }),
  next_id: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false });
export type DigestBody = Static<typeof digestBodySchema>;
export const emptyDigest = (): DigestBody => ({ items: [], stubs: [], older_items: null, resolved: [], notices: [], next_id: 1 });

/** The only thing a model returns: changes to the previous items, each citing the messages it rests on. */
export const digestDeltaSchema = Type.Object({
  add: Type.Array(Type.Object({ section, text: Type.String({ minLength: 1, maxLength: 300 }), sources }, { additionalProperties: false }), { maxItems: 20 }),
  update: Type.Array(Type.Object({ id, text: Type.String({ minLength: 1, maxLength: 300 }), sources }, { additionalProperties: false }), { maxItems: 20 }),
  resolve: Type.Array(Type.Object({ id, sources }, { additionalProperties: false }), { maxItems: 20 }),
}, { additionalProperties: false });
export type DigestDelta = Static<typeof digestDeltaSchema>;
