import { readFileSync, realpathSync, statSync } from 'node:fs';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
/** Only the built UI is public. The product root and shared files are never served here. */
export function serveStatic(root: string, req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  try {
    const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    const base = realpathSync(root);
    const file = realpathSync(resolve(base, `.${pathname === '/' ? '/index.html' : pathname}`));
    const within = relative(base, file);
    if (isAbsolute(within) || within.startsWith(`..${sep}`) || within === '..' || !mime[extname(file)] || !statSync(file).isFile()) return false;
    res.writeHead(200, { 'Content-Type': mime[extname(file)]!, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
    res.end(req.method === 'HEAD' ? undefined : readFileSync(file)); return true;
  } catch { return false; }
}
