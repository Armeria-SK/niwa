/** API keys travel with every request, so plain HTTP is accepted only for servers on this machine. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'localhost' || host === '[::1]' || /^127(?:\.\d{1,3}){3}$/u.test(host);
}

/** Normalized base URL (no trailing slash), or undefined when it is unsafe or malformed. */
export function normalizeCompatibleUrl(value: string): string | undefined {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\x00-\x20\x7f]/u.test(value)) return undefined;
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  if (url.username || url.password || url.search || url.hash || value.includes('?') || value.includes('#')) return undefined;
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) return undefined;
  return url.href.replace(/\/+$/u, '');
}

export function compatibleUrl(baseUrl: string, endpoint: 'chat/completions' | 'models'): URL {
  const normalized = normalizeCompatibleUrl(baseUrl);
  if (!normalized) throw new Error('Invalid OpenAI-compatible URL');
  return new URL(endpoint, `${normalized}/`);
}
