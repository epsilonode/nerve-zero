/**
 * WebSocket proxy — bridges browser clients to the ZeroClaw gateway.
 *
 * Clients connect to `ws(s)://host:port/ws?target=<gateway-ws-url>` and this
 * module opens a corresponding connection to the gateway, relaying messages
 * bidirectionally. The current ZeroClaw gateway authenticates at upgrade time
 * and starts chat sessions directly on `/ws/chat`.
 * @module
 */

import type { Server as HttpsServer } from 'node:https';
import type { Server as HttpServer, IncomingMessage } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import type { Duplex } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { config, WS_ALLOWED_HOSTS, SESSION_COOKIE_NAME } from './config.js';
import { verifySession, parseSessionCookie } from './session.js';
import { canInjectGatewayToken } from './trust-utils.js';
import { isAllowedOrigin } from './origin-utils.js';

/** Active WSS instances — used for graceful shutdown */
const activeWssInstances: WebSocketServer[] = [];

/** Close all active WebSocket connections */
export function closeAllWebSockets(): void {
  for (const wss of activeWssInstances) {
    for (const client of wss.clients) client.close(1001, 'Server shutting down');
    wss.close();
  }
  activeWssInstances.length = 0;
}

/** Set up the WS/WSS proxy on an HTTP or HTTPS server. */
export function setupWebSocketProxy(server: HttpServer | HttpsServer): void {
  const wss = new WebSocketServer({ noServer: true });
  activeWssInstances.push(wss);

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!req.url?.startsWith('/ws')) {
      socket.destroy();
      return;
    }

    const originHeader = Array.isArray(req.headers.origin) ? req.headers.origin[0] : req.headers.origin;
    if (!isAllowedOrigin(originHeader)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n\r\nOrigin not allowed');
      socket.destroy();
      return;
    }

    if (config.auth) {
      const token = parseSessionCookie(req.headers.cookie, SESSION_COOKIE_NAME);
      if (!token || !verifySession(token, config.sessionSecret)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Type: text/plain\r\n\r\nAuthentication required');
        socket.destroy();
        return;
      }
    }

    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (clientWs: WebSocket, req: IncomingMessage) => {
    const connId = randomUUID().slice(0, 8);
    const tag = `[ws-proxy:${connId}]`;
    const requestUrl = new URL(req.url || '/', 'https://localhost');
    const target = requestUrl.searchParams.get('target');

    if (!target) {
      clientWs.close(1008, 'Missing ?target= param');
      return;
    }

    let targetUrl: URL;
    try {
      targetUrl = new URL(target);
    } catch {
      clientWs.close(1008, 'Invalid target URL');
      return;
    }

    if (!['ws:', 'wss:'].includes(targetUrl.protocol) || !WS_ALLOWED_HOSTS.has(targetUrl.hostname)) {
      console.warn(`${tag} Rejected target: ${target}`);
      clientWs.close(1008, 'Target not allowed');
      return;
    }

    const targetPort = Number(targetUrl.port) || (targetUrl.protocol === 'wss:' ? 443 : 80);
    if (targetPort < 1 || targetPort > 65535) {
      clientWs.close(1008, 'Invalid target port');
      return;
    }

    const isEncrypted = !!(req.socket as unknown as { encrypted?: boolean }).encrypted;
    const scheme = isEncrypted ? 'https' : 'http';
    const clientOrigin = (Array.isArray(req.headers.origin) ? req.headers.origin[0] : req.headers.origin)
      || `${scheme}://${req.headers.host}`;
    const isTrusted = canInjectGatewayToken(req);

    createGatewayRelay(clientWs, requestUrl, targetUrl, clientOrigin, connId, isTrusted);
  });
}

function createGatewayRelay(
  clientWs: WebSocket,
  requestUrl: URL,
  targetUrl: URL,
  clientOrigin: string,
  connId: string,
  isTrusted: boolean,
): void {
  const tag = `[ws-proxy:${connId}]`;
  let gwWs: WebSocket | null = null;

  const PING_INTERVAL = 30_000;
  let clientAlive = true;
  let gatewayAlive = true;

  clientWs.on('pong', () => { clientAlive = true; });

  const pingTimer = setInterval(() => {
    if (!clientAlive) {
      console.log(`${tag} Client pong timeout — terminating`);
      clientWs.terminate();
      return;
    }
    clientAlive = false;
    if (clientWs.readyState === WebSocket.OPEN) clientWs.ping();

    if (gwWs && !gatewayAlive) {
      console.log(`${tag} Gateway pong timeout — terminating`);
      gwWs.terminate();
      return;
    }
    gatewayAlive = false;
    if (gwWs?.readyState === WebSocket.OPEN) gwWs.ping();
  }, PING_INTERVAL);

  const effectiveToken = requestUrl.searchParams.get('token') || (isTrusted ? config.gatewayToken : '');
  const sessionId = requestUrl.searchParams.get('session_id') || '';

  const gatewayUrl = new URL(targetUrl.toString());
  if (sessionId && !gatewayUrl.searchParams.get('session_id')) {
    gatewayUrl.searchParams.set('session_id', sessionId);
  }
  if (effectiveToken && !gatewayUrl.searchParams.get('token')) {
    gatewayUrl.searchParams.set('token', effectiveToken);
  }

  const protocols = ['zeroclaw.v1'];
  if (effectiveToken) protocols.push(`bearer.${effectiveToken}`);

  gwWs = new WebSocket(gatewayUrl.toString(), protocols, {
    headers: {
      Origin: clientOrigin,
      ...(effectiveToken ? { Authorization: `Bearer ${effectiveToken}` } : {}),
    },
  });

  gwWs.on('pong', () => { gatewayAlive = true; });

  gwWs.on('open', () => {
    console.log(`${tag} Gateway connected: ${gatewayUrl.toString()}`);
  });

  gwWs.on('message', (data: Buffer | string, isBinary: boolean) => {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(isBinary ? data : data.toString());
    }
  });

  gwWs.on('error', (err) => {
    console.error(`${tag} Gateway error:`, err.message);
    if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
  });

  gwWs.on('close', (code, reason) => {
    console.log(`${tag} Gateway closed: code=${code}, reason=${reason?.toString() || ''}`);
    if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
  });

  clientWs.on('message', (data: Buffer | string, isBinary: boolean) => {
    if (!gwWs || gwWs.readyState !== WebSocket.OPEN) return;
    gwWs.send(isBinary ? data : data.toString());
  });

  clientWs.on('close', (code, reason) => {
    clearInterval(pingTimer);
    console.log(`${tag} Client closed: code=${code}, reason=${reason.toString()}`);
    if (gwWs && gwWs.readyState === WebSocket.OPEN) gwWs.close();
  });

  clientWs.on('error', (err) => {
    clearInterval(pingTimer);
    console.error(`${tag} Client error:`, err.message);
    if (gwWs && gwWs.readyState === WebSocket.OPEN) gwWs.close();
  });
}
