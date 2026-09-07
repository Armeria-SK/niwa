import { Type, type Static } from '@sinclair/typebox';

const note = () => Type.String({ minLength: 1, maxLength: 2000 });
export const summarySchema = Type.Object({
  conclusion: note(), reason: note(),
  unresolved: Type.Array(note(), { maxItems: 10 }), next_steps: Type.Array(note(), { maxItems: 10 }),
  sources: Type.Array(Type.Object({
    kind: Type.Union(['message', 'task', 'task_reply', 'artifact', 'memory'].map(kind => Type.Literal(kind))),
    source_id: Type.String({ minLength: 1, maxLength: 100 }),
    revision: Type.String({ pattern: '^[a-f0-9]{64}$' }),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 20 }),
}, { additionalProperties: false });
export type WorkSummary = Static<typeof summarySchema>;
