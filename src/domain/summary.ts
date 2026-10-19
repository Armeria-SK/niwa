import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

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

const clip = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? [...value.trim()].slice(0, 2000).join('') : undefined;
/**
 * A handoff summary as the model returned it, repaired where the server knows better: each cited source takes the revision Niwa itself
 * handed out for it (models often miscopy the 64-character hashes), unknown or duplicate sources are dropped, and over-long text or lists
 * are cut to the limits. What the model alone can say (conclusion, reason, which sources) is never invented.
 */
export function repairSummary(value: unknown, offered: readonly { kind: string; source_id: string; revision: string }[]): { summary?: WorkSummary; invalid: string[] } {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const list = (key: string) => (Array.isArray(input[key]) ? input[key] as unknown[] : input[key] === undefined ? [] : undefined)?.map(clip).filter((item): item is string => !!item).slice(0, 10);
  const seen = new Set<string>();
  const sources = (Array.isArray(input.sources) ? input.sources as unknown[] : []).flatMap(item => {
    const source = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    const known = offered.find(entry => entry.kind === source.kind && entry.source_id === source.source_id);
    const key = known ? `${known.kind}:${known.source_id}` : '';
    if (!known || seen.has(key)) return [];
    seen.add(key);
    return [{ kind: known.kind as WorkSummary['sources'][number]['kind'], source_id: known.source_id, revision: known.revision }];
  }).slice(0, 20);
  const summary = { conclusion: clip(input.conclusion), reason: clip(input.reason), unresolved: list('unresolved'), next_steps: list('next_steps'), sources };
  const invalid = Object.entries(summary).filter(([key, item]) => item === undefined || (key === 'sources' && !sources.length)).map(([key]) => key);
  return invalid.length || !Value.Check(summarySchema, summary) ? { invalid: invalid.length ? invalid : ['shape'] } : { summary: summary as WorkSummary, invalid: [] };
}
