import { Type, type Static } from '@sinclair/typebox';

export const memoryReviewSchema = Type.Object({
  memories: Type.Array(Type.Object({
    source_message_id: Type.String({ minLength: 1, maxLength: 100 }),
    body: Type.String({ minLength: 1, maxLength: 2000 }),
  }, { additionalProperties: false }), { maxItems: 5 }),
}, { additionalProperties: false });
export type MemoryReview = Static<typeof memoryReviewSchema>;
