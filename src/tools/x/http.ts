/** Bounded JSON transport for fixed X endpoints. No redirects, arbitrary proxy, logging or automatic retry. */
export async function xJson(url: string, init: RequestInit, fetcher: typeof fetch = fetch) {
  const target = new URL(url);
  if (target.origin !== 'https://api.x.com' || target.username || target.password || target.hash) throw new Error('Invalid X endpoint');
  const signal = AbortSignal.any([AbortSignal.timeout(20_000), ...(init.signal ? [init.signal] : [])]);
  const response = await fetcher(target, { ...init, redirect: 'error', signal });
  if (!response.body) throw new Error('X returned no response body');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) { const part = await reader.read(); if (part.done) break;
      if ((bytes += part.value.byteLength) > 256 * 1024) throw new Error('X response too large'); chunks.push(part.value); }
    signal.throwIfAborted();
    let data: unknown;
    try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('Invalid X JSON response'); }
    return { status: response.status, data };
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
