// Derived from Carried c695f855419ffc69d1e62b04f1de8de36c7c162d, core/contracts/src/model-contract.ts.
// Apache-2.0. Modified for Niwa; upstream revision and source path are recorded above.
import { Type, type Static } from '@sinclair/typebox';

export const reasoningEffortSchema = Type.Union([
  Type.Literal('minimal'),
  Type.Literal('low'),
  Type.Literal('medium'),
  Type.Literal('high'),
  Type.Literal('xhigh'),
  Type.Literal('max'),
]);
export type ReasoningEffort = Static<typeof reasoningEffortSchema>;

export const jsonObjectSchema = Type.Record(Type.String(), Type.Unknown());
export type JsonObject = Static<typeof jsonObjectSchema>;

export const modelToolCallSchema = Type.Object(
  {
    tool_call_id: Type.String({ minLength: 1, maxLength: 128 }),
    name: Type.String({ minLength: 1, maxLength: 128 }),
    arguments: jsonObjectSchema,
  },
  { additionalProperties: false },
);
export type ModelToolCall = Static<typeof modelToolCallSchema>;

export const userModelMessageSchema = Type.Object(
  { role: Type.Literal('user'), content: Type.String() },
  { additionalProperties: false },
);

export const assistantModelMessageSchema = Type.Object(
  {
    role: Type.Literal('assistant'),
    content: Type.Optional(Type.String()),
    tool_calls: Type.Optional(Type.Array(modelToolCallSchema)),
  },
  { additionalProperties: false },
);

export const toolModelMessageSchema = Type.Object(
  {
    role: Type.Literal('tool'),
    tool_call_id: Type.String({ minLength: 1, maxLength: 128 }),
    name: Type.String({ minLength: 1, maxLength: 128 }),
    content: Type.String(),
  },
  { additionalProperties: false },
);

export const modelMessageSchema = Type.Union([
  userModelMessageSchema,
  assistantModelMessageSchema,
  toolModelMessageSchema,
]);
export type ModelMessage = Static<typeof modelMessageSchema>;

export const modelToolDefinitionSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 128 }),
    description: Type.String({ minLength: 1 }),
    input_schema: jsonObjectSchema,
  },
  { additionalProperties: false },
);
export type ModelToolDefinition = Static<typeof modelToolDefinitionSchema>;

export const modelResponseContractSchema = Type.Union([
  Type.Object({ type: Type.Literal('text') }, { additionalProperties: false }),
  Type.Object(
    {
      type: Type.Literal('json_schema'),
      name: Type.String({ minLength: 1, maxLength: 128 }),
      schema: jsonObjectSchema,
      strict: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
]);
export type ModelResponseContract = Static<typeof modelResponseContractSchema>;

export const modelOptionsSchema = Type.Object(
  {
    temperature: Type.Optional(Type.Number({ minimum: 0, maximum: 2 })),
    top_p: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 1 })),
  },
  { additionalProperties: false },
);
export type ModelOptions = Static<typeof modelOptionsSchema>;

export const modelBudgetSchema = Type.Object(
  {
    max_output_tokens: Type.Integer({ minimum: 1 }),
    max_total_tokens: Type.Integer({ minimum: 1 }),
    max_requests: Type.Integer({ minimum: 1 }),
    max_tool_calls: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type ModelBudget = Static<typeof modelBudgetSchema>;

export const modelRequestSchema = Type.Object(
  {
    system_instructions: Type.String({ minLength: 1 }),
    messages: Type.Array(modelMessageSchema),
    tools: Type.Array(modelToolDefinitionSchema),
    response_contract: modelResponseContractSchema,
    reasoning_effort: Type.Optional(reasoningEffortSchema),
    model_options: modelOptionsSchema,
    budget: modelBudgetSchema,
  },
  { $id: 'ModelRequest', additionalProperties: false },
);
export type ModelRequest = Static<typeof modelRequestSchema>;

export const modelFailureCodeSchema = Type.Union([
  Type.Literal('INVALID_REQUEST'),
  Type.Literal('CAPABILITY_MISMATCH'),
  Type.Literal('AUTH_UNAVAILABLE'),
  Type.Literal('AUTHENTICATION_FAILED'),
  Type.Literal('PERMISSION_DENIED'),
  Type.Literal('RATE_LIMITED'),
  Type.Literal('QUOTA_EXCEEDED'),
  Type.Literal('PROVIDER_UNAVAILABLE'),
  Type.Literal('PROVIDER_ERROR'),
  Type.Literal('TIMED_OUT'),
  Type.Literal('ABORTED'),
  Type.Literal('NETWORK_ERROR'),
  Type.Literal('INVALID_RESPONSE'),
  Type.Literal('OUTPUT_LIMIT'),
]);
export type ModelFailureCode = Static<typeof modelFailureCodeSchema>;

export const modelFailureOriginSchema = Type.Union([
  Type.Literal('local'),
  Type.Literal('provider'),
  Type.Literal('transport'),
]);
export type ModelFailureOrigin = Static<typeof modelFailureOriginSchema>;

export const modelEventLimitDimensionSchema = Type.Union([
  Type.Literal('event_count'),
  Type.Literal('bytes'),
  Type.Literal('tool_call_count'),
]);
export type ModelEventLimitDimension = Static<typeof modelEventLimitDimensionSchema>;

const modelEventLimitFields = {
  limit_dimension: Type.Optional(modelEventLimitDimensionSchema),
  event_count: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  max_events: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  total_bytes: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  max_total_bytes: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  tool_call_count: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  max_tool_calls: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
};

export const modelEventSchema = Type.Union([
  Type.Object(
    { type: Type.Literal('text_delta'), text: Type.String() },
    { additionalProperties: false },
  ),
  Type.Object(
    { type: Type.Literal('reasoning_summary'), summary: Type.String() },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal('tool_call'),
      tool_call_id: Type.String({ minLength: 1, maxLength: 128 }),
      name: Type.String({ minLength: 1, maxLength: 128 }),
      arguments: jsonObjectSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal('usage'),
      input_tokens: Type.Integer({ minimum: 0 }),
      output_tokens: Type.Integer({ minimum: 0 }),
      total_tokens: Type.Integer({ minimum: 0 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal('completed'),
      finish_reason: Type.Union([
        Type.Literal('stop'),
        Type.Literal('tool_calls'),
        Type.Literal('length'),
        Type.Literal('content_filter'),
        Type.Literal('other'),
      ]),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal('failed'),
      error: Type.Object(
        {
          code: modelFailureCodeSchema,
          message: Type.String(),
          retryable: Type.Boolean(),
          origin: Type.Optional(modelFailureOriginSchema),
          provider_request_sent: Type.Optional(Type.Boolean()),
          /** Provider-reported reset estimate, Unix seconds; recovery needs confirmation. */
          reset_at: Type.Optional(Type.Integer({ minimum: 0, maximum: 8_640_000_000_000 })),
          ...modelEventLimitFields,
        },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
]);
export type ModelEvent = Static<typeof modelEventSchema>;
