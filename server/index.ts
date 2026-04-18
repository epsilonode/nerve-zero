/**
 * Nerve server entry point.
 *
 * Starts HTTP and optional HTTPS servers (for secure-context features like
 * microphone access), sets up WebSocket proxying to the ZeroClaw gateway,
 * starts file watchers, and registers graceful shutdown handlers.
 *
 * Runtime: Bun (uses node:http/node:https compat for ws upgrade support)
 * @module
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import app from './app.js';
import { releaseWhisperContext } from './services/whisper-local.js';
import { config, validateConfig, printStartupBanner, probeGateway } from './lib/config.js';
import { setupWebSocketProxy, closeAllWebSockets } from './lib/ws-proxy.js';
import { startFileWatcher, stopFileWatcher } from './lib/file-watcher.js';

// ── Startup banner + validation ──────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgPath = path.resolve(__dirname, '..', 'package.json');
const pkgVersion: string = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).version || '0.0.0';

printStartupBanner(pkgVersion);
validateConfig();

// ── Start file watchers ──────────────────────────────────────────────

startFileWatcher();

// ── HTTP server ──────────────────────────────────────────────────────

const MAX_BODY_BYTES = config.limits.maxBodyBytes;

let browserOpened = false;

function shouldOpenBrowser(): boolean {
  if (browserOpened) return false;
  if (process.env.NERVE_OPEN_BROWSER === 'false') return false;
  return config.host === '127.0.0.1' || config.host === 'localhost' || config.host === '::1';
}

function openBrowser(url: string): void {
  if (!shouldOpenBrowser()) return;

  browserOpened = true;
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
      return;
    }
    if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
      return;
    }
    spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // browser launch is best-effort only
  }
}

/**
 * Convert a Node.js IncomingMessage into a web-standard Request,
 * pass it through Hono, and write the Response back.
 */
async function handleNodeRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  protocol: 'http' | 'https',
): Promise<void> {
  const host = req.headers.host || `localhost:${config.port}`;
  const url = new URL(req.url || '/', `${protocol}://${host}`);

  // Read body with size limit
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    totalBytes += (chunk as Buffer).length;
    if (totalBytes > MAX_BODY_BYTES) {
      res.writeHead(413, { 'Content-Type': 'text/plain' });
      res.end('Request body too large');
      return;
    }
    chunks.push(chunk as Buffer);
  }
  const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value) {
      if (Array.isArray(value)) {
        for (const v of value) headers.append(key, v);
      } else {
        headers.set(key, value);
      }
    }
  }

  const request = new Request(url.toString(), {
    method: req.method,
    headers,
    body: req.method !== 'GET' && req.method !== 'HEAD' ? body : undefined,
    duplex: 'half',
  });

  try {
    const response = await app.fetch(request, { incoming: req });

    const responseHeaders = Object.fromEntries(response.headers.entries());
    const contentType = response.headers.get('content-type') || '';

    // Stream SSE responses instead of buffering
    if (contentType.includes('text/event-stream') && response.body) {
      res.writeHead(response.status, responseHeaders);
      const reader = response.body.getReader();
      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) { res.end(); return; }
          if (!res.writable) { reader.cancel(); return; }
          res.write(value);
        }
      };
      pump().catch(() => res.end());
      req.on('close', () => reader.cancel());
      return;
    }

    // Buffer non-streaming responses normally
    res.writeHead(response.status, responseHeaders);
    const arrayBuf = await response.arrayBuffer();
    res.end(Buffer.from(arrayBuf));
  } catch (err) {
    console.error(`[${protocol}] error:`, (err as Error).message);
    if (!res.headersSent) {
      res.writeHead(500);
    }
    res.end('Internal Server Error');
  }
}

const httpServer = http.createServer((req, res) => handleNodeRequest(req, res, 'http'));

httpServer.listen(config.port, config.host, () => {
  const localUrl = `http://${config.host}:${config.port}`;
  console.log(`\x1b[33m[nerve-zero]\x1b[0m ${localUrl}`);
  openBrowser(localUrl);
});

// Friendly error on port conflict
httpServer.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\x1b[31m[nerve-zero]\x1b[0m Port ${config.port} is already in use. Is another instance running?`);
    process.exit(1);
  }
  throw err;
});

// Set up WS proxy on HTTP server (for remote access without SSL)
setupWebSocketProxy(httpServer);

// Non-blocking gateway health check
probeGateway();

// ── HTTPS server (for secure context — microphone access, WSS proxy) ─

let sslServer: https.Server | undefined;

if (fs.existsSync(config.certPath) && fs.existsSync(config.keyPath)) {
  const sslOptions = {
    cert: fs.readFileSync(config.certPath),
    key: fs.readFileSync(config.keyPath),
  };

  sslServer = https.createServer(sslOptions, (req, res) => handleNodeRequest(req, res, 'https'));

  sslServer.listen(config.sslPort, config.host, () => {
    console.log(`\x1b[33m[nerve-zero]\x1b[0m https://${config.host}:${config.sslPort}`);
  });

  setupWebSocketProxy(sslServer);
}

// ── Graceful shutdown ────────────────────────────────────────────────

function shutdown(signal: string) {
  console.log(`\n[nerve-zero] ${signal} received, shutting down...`);

  stopFileWatcher();
  closeAllWebSockets();
  releaseWhisperContext().catch(() => {});

  httpServer.close(() => {
    console.log('[nerve-zero] HTTP server closed');
  });

  if (sslServer) {
    sslServer.close(() => {
      console.log('[nerve-zero] HTTPS server closed');
    });
  }

  // Give connections 5s to drain, then force exit
  setTimeout(() => {
    console.log('[nerve-zero] Force exit');
    process.exit(0);
  }, 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
