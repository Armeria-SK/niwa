// Derived from Carried c695f855419ffc69d1e62b04f1de8de36c7c162d, core/contracts/src/plain-json.ts.
// Apache-2.0. Modified for Niwa; see THIRD_PARTY_NOTICES.md and provenance/carried.json.
export interface PlainJsonLimits {
  max_depth: number;
  max_nodes: number;
  max_bytes: number;
}

export function isPlainJsonValue(
  value: unknown,
  limits: PlainJsonLimits,
): boolean {
  if (
    !Number.isSafeInteger(limits.max_depth) ||
    limits.max_depth < 0 ||
    !Number.isSafeInteger(limits.max_nodes) ||
    limits.max_nodes < 1 ||
    !Number.isSafeInteger(limits.max_bytes) ||
    limits.max_bytes < 1
  ) {
    return false;
  }
  try {
    validate(value, 0, { nodes: 0, seen: new WeakSet<object>() }, limits);
    const serialized = JSON.stringify(value);
    return (
      serialized !== undefined &&
      new TextEncoder().encode(serialized).byteLength <= limits.max_bytes
    );
  } catch {
    return false;
  }
}

function validate(
  value: unknown,
  depth: number,
  state: { nodes: number; seen: WeakSet<object> },
  limits: PlainJsonLimits,
): void {
  state.nodes += 1;
  if (depth > limits.max_depth || state.nodes > limits.max_nodes) {
    throw new Error('JSON safety budget exceeded.');
  }
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return;
  }
  if (typeof value !== 'object') throw new Error('The value is not JSON data.');
  if (state.seen.has(value)) throw new Error('Cyclic or aliased JSON data is forbidden.');
  state.seen.add(value);
  if (Array.isArray(value)) {
    for (const child of value) validate(child, depth + 1, state, limits);
    return;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error('Only plain JSON objects are accepted.');
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string')) {
    throw new Error('Symbol keys are not JSON data.');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of keys as string[]) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ) {
      throw new Error('Only enumerable JSON data properties are accepted.');
    }
    validate(descriptor.value, depth + 1, state, limits);
  }
}
