import { Type } from '@sinclair/typebox';

export const profileSchema = Type.Partial(Type.Object({
  name: Type.String({ minLength: 1, maxLength: 100 }), role: Type.String({ maxLength: 100 }),
  persona: Type.String({ maxLength: 10_000 }),
  shape: Type.String({ pattern: '^(pebble|triangle|diamond|bean|cloud|droplet|heart|star|crescent|capsule|square|puddle|ghost|bunny|cat|bear|mushroom|bell|peanut|comet)$' }),
  color: Type.String({ pattern: '^#[0-9a-fA-F]{6}$' }), motion: Type.Union(['auto', 'none', 'float', 'sway', 'pulse'].map(value => Type.Literal(value))),
}, { additionalProperties: false }));
