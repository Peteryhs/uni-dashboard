/**
 * Static asset serving for the built web client.
 *
 * This exists so `cli.mjs serve` is the same shape as the deployment target: one origin serving both
 * the app shell and /v1, which is exactly what Cloudflare Workers static assets gives for free. That
 * arrangement means the client never needs a CORS path, and a CORS path that only exists in dev is a
 * bug waiting for deploy day.
 *
 * On Workers this whole file disappears: the platform serves ./dist and the Worker keeps only the
 * /v1 handlers. Nothing else imports it, so deleting it is a one-line change to server.mjs.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_ROOT = path.join(import.meta.dirname, '../../web/dist');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

export function createStaticHandler({ root = DEFAULT_ROOT } = {}) {
  const resolvedRoot = path.resolve(root);

  async function resolveFile(pathname) {
    // Decode first, then normalise, then confirm the result is still inside the root. Checking for
    // ".." in the raw string is not enough: "%2e%2e" and backslashes on Windows both get past it.
    let decoded;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return null; // malformed percent-encoding
    }
    if (decoded.includes('\0')) return null;

    const candidate = path.resolve(resolvedRoot, '.' + path.posix.normalize(decoded.replace(/\\/g, '/')));
    const rel = path.relative(resolvedRoot, candidate);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;

    try {
      const info = await stat(candidate);
      if (info.isDirectory()) return null;
      return { file: candidate, size: info.size, mtime: info.mtimeMs };
    } catch {
      return null;
    }
  }

  /**
   * Returns true when it has handled the request. The caller keeps ownership of everything it
   * already routed, so /v1 and /healthz can never be shadowed by a file on disk.
   */
  return async function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;

    let hit = await resolveFile(pathname === '/' ? '/index.html' : pathname);

    // SPA fallback. Only for requests that look like navigation: a missing .js must 404 rather than
    // quietly return HTML, because a bundle that parses as HTML produces a baffling console error
    // instead of an obvious missing-file error.
    const isAsset = path.extname(pathname) !== '';
    if (!hit && !isAsset) hit = await resolveFile('/index.html');

    if (!hit) return false;

    const ext = path.extname(hit.file).toLowerCase();
    const type = MIME[ext] ?? 'application/octet-stream';

    // Vite fingerprints everything under /assets/, so those are safe to cache forever. The shell
    // must not be, or a deploy never reaches an open tab.
    const immutable = pathname.startsWith('/assets/') && isAsset;
    const etag = `W/"${hit.size.toString(16)}-${Math.round(hit.mtime).toString(16)}"`;

    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { etag });
      return res.end(), true;
    }

    res.writeHead(200, {
      'content-type': type,
      'content-length': hit.size,
      etag,
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      // Cheap hardening for a page that renders data fetched from the same origin.
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'same-origin',
    });

    if (req.method === 'HEAD') return res.end(), true;

    await new Promise((resolve, reject) => {
      const stream = createReadStream(hit.file);
      stream.on('error', reject);
      stream.on('end', resolve);
      stream.pipe(res);
    }).catch(() => res.destroy());

    return true;
  };
}

export async function webRootExists(root = DEFAULT_ROOT) {
  try {
    await stat(path.join(root, 'index.html'));
    return true;
  } catch {
    return false;
  }
}

export { DEFAULT_ROOT as WEB_ROOT };
