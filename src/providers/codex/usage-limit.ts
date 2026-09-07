/** Wire error fields are hints, never proof that quota has recovered. */
export function subscriptionUsageLimit(value: unknown): { reset_at?: number } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const error = value as Record<string, unknown>;
  if (error['type'] !== 'usage_limit_reached' && error['code'] !== 'usage_limit_reached') return;
  const reset = error['resets_at'];
  // Codex reports Unix seconds. Keep only a timestamp representable by JS Date.
  return typeof reset === 'number' && Number.isSafeInteger(reset) && reset >= 0 && reset <= 8_640_000_000_000
    ? { reset_at: reset } : {};
}
