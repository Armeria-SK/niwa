import { Type, type Static } from '@sinclair/typebox';
const revision = Type.String({ minLength: 1, maxLength: 64 });
const ref = Type.Integer({ minimum: 0, maximum: 99 });
export const interactionSchema = Type.Union([
  Type.Object({ action: Type.Literal('click'), revision, ref }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal('fill'), revision, ref, value: Type.String({ maxLength: 1000 }) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal('scroll'), revision, pixels: Type.Integer({ minimum: -2000, maximum: 2000 }) }, { additionalProperties: false }),
]);
export type BrowserInteraction = Static<typeof interactionSchema>;
