/**
 * Lightweight serve-static middleware for Hono.
 *
 * Replaces @hono/node-server/serve-static with a runtime-agnostic
 * implementation that uses standard node:fs APIs (Bun supports these natively).
 * @module
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import type { MiddlewareHandler } from 'hono';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'text/xml; charset=utf-8',
  '.map': 'application/json',
  '.wasm': 'application/wasm',
};

function getMimeType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

interface ServeStaticOptions {
  /** Root directory to serve files from (relative to cwd). */
  root?: string;
  /** Explicit file path to serve (relative to root), overrides URL path. */
  path?: string;
}

/**
 * Serve static files from the filesystem.
 *
 * Compatible API with @hono/node-server/serve-static.
 */
export function serveStatic(options: ServeStaticOptions = {}): MiddlewareHandler {
  const root = options.root || './';

  return async (c, next) => {
    // Determine which file to serve
    const urlPath = options.path || c.req.path;

    // Prevent directory traversal
    if (urlPath.includes('..')) {
      return next();
    }

    const filePath = resolve(root, urlPath.startsWith('/') ? urlPath.slice(1) : urlPath);

    try {
      if (!existsSync(filePath)) {
        return next();
      }

      const stat = statSync(filePath);
      if (!stat.isFile()) {
        return next();
      }

      const content = readFileSync(filePath);
      const mimeType = getMimeType(filePath);

      return c.body(content, 200, {
        'Content-Type': mimeType,
        'Content-Length': String(content.length),
      });
    } catch {
      return next();
    }
  };
}
