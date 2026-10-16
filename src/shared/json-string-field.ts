/** Incrementally decode one top-level string field from streamed JSON object text. Display-only; never authoritative. */
export class JsonStringFieldStream {
  readonly #field: string; readonly #max: number;
  #depth = 0; #expectKey = false; #awaitValue = false; #key: string | undefined;
  #inString = false; #role: 'key' | 'value' | 'skip' = 'skip'; #escape: 0 | 1 | 2 = 0; #hex = ''; #keyText = '';
  #value = ''; #found = false; #complete = false; #truncated = false; #invalid = false; #closed = false;
  constructor(field: string, maxLength = 8000) {
    if (!field || field.length > 256 || !Number.isSafeInteger(maxLength) || maxLength < 1) throw new Error('Invalid field stream');
    this.#field = field; this.#max = maxLength;
  }
  /** Last occurrence wins, matching JSON.parse. Trailing lone high surrogates wait for their pair. */
  get value(): string { return /[\uD800-\uDBFF]$/u.test(this.#value) ? this.#value.slice(0, -1) : this.#value; }
  get found(): boolean { return this.#found; }
  get complete(): boolean { return this.#complete; }
  get truncated(): boolean { return this.#truncated; }
  get invalid(): boolean { return this.#invalid; }
  push(chunk: string): void {
    if (typeof chunk !== 'string') { this.#invalid = true; return; }
    for (let index = 0; index < chunk.length && !this.#invalid && !this.#closed; index++) this.#step(chunk[index]!);
  }
  #append(text: string): void {
    if (this.#role === 'key') { if (this.#keyText.length < 512) this.#keyText += text; return; }
    if (this.#role !== 'value') return;
    if (this.#value.length >= this.#max) { this.#truncated = true; return; }
    this.#value += text;
  }
  #step(c: string): void {
    if (this.#inString) {
      if (this.#escape === 1) {
        this.#escape = 0;
        const simple: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
        if (c === 'u') { this.#escape = 2; this.#hex = ''; return; }
        if (!(c in simple)) { this.#invalid = true; return; }
        this.#append(simple[c]!); return;
      }
      if (this.#escape === 2) {
        if (!/^[0-9a-fA-F]$/u.test(c)) { this.#invalid = true; return; }
        this.#hex += c; if (this.#hex.length < 4) return;
        this.#escape = 0; this.#append(String.fromCharCode(Number.parseInt(this.#hex, 16))); return;
      }
      if (c === '\\') { this.#escape = 1; return; }
      if (c === '"') {
        this.#inString = false;
        if (this.#role === 'key') this.#key = this.#keyText;
        else if (this.#role === 'value') this.#complete = true;
        this.#role = 'skip'; return;
      }
      this.#append(c); return;
    }
    if (c === ' ' || c === '\n' || c === '\r' || c === '\t') return;
    if (c === '"') {
      this.#inString = true;
      if (this.#depth === 1 && this.#expectKey) { this.#role = 'key'; this.#keyText = ''; this.#expectKey = false; }
      else if (this.#depth === 1 && this.#awaitValue && this.#key === this.#field) { this.#role = 'value'; this.#value = ''; this.#found = true; this.#complete = false; this.#truncated = false; this.#awaitValue = false; }
      else { this.#role = 'skip'; if (this.#depth === 1) this.#awaitValue = false; }
      return;
    }
    if (c === '{' || c === '[') {
      if (this.#depth === 0 && c !== '{') { this.#invalid = true; return; }
      if (this.#depth === 1) this.#awaitValue = false;
      this.#depth++; if (this.#depth === 1) this.#expectKey = true;
      return;
    }
    if (c === '}' || c === ']') {
      this.#depth--; if (this.#depth < 0) { this.#invalid = true; return; }
      if (this.#depth === 0) this.#closed = true;
      return;
    }
    if (this.#depth === 0) { this.#invalid = true; return; }
    if (this.#depth !== 1) return;
    if (c === ':') { this.#awaitValue = true; return; }
    if (c === ',') { this.#expectKey = true; this.#awaitValue = false; this.#key = undefined; return; }
    this.#awaitValue = false;
  }
}
