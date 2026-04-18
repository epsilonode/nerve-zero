import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';

vi.mock('./config.js', () => ({
  config: {
    auth: false,
    host: '127.0.0.1',
    port: 3080,
    sslPort: 3443,
    sessionSecret: 'test-secret',
    gatewayToken: 'test-token',
  },
  WS_ALLOWED_HOSTS: new Set(['localhost', '127.0.0.1', '::1']),
  SESSION_COOKIE_NAME: 'nerve_session_3080',
}));

vi.mock('./session.js', () => ({
  verifySession: vi.fn(),
  parseSessionCookie: vi.fn(),
}));

import { setupWebSocketProxy, closeAllWebSockets } from './ws-proxy.js';
import { config } from './config.js';
import { verifySession, parseSessionCookie } from './session.js';

const describeWsProxy = process.platform === 'win32' ? describe.skip : describe;

type MutableConfig = typeof config & { auth: boolean; gatewayToken: string; sessionSecret: string };

interface GatewayProbeState {
  lastUrl: string | null;
  lastAuthHeader: string | undefined;
  lastProtocols: string[];
  received: string[];
}

function waitForMessage(ws: WebSocket, timeoutMs = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS message timeout')), timeoutMs);
    ws.once('message', (data) => {
      clearTimeout(timer);
      resolve(data.toString());
    });
  });
}

function waitForClose(ws: WebSocket, timeoutMs = 3000): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS close timeout')), timeoutMs);
    ws.once('close', (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString() });
    });
    ws.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function waitForCloseOrError(ws: WebSocket, timeoutMs = 3000): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS close/error timeout')), timeoutMs);
    const done = (code: number, reason: string) => {
      clearTimeout(timer);
      resolve({ code, reason });
    };
    ws.once('close', (code, reason) => done(code, reason.toString()));
    ws.once('error', (err) => done(1006, err.message));
  });
}

async function createGatewayProbe(): Promise<{
  server: Server;
  port: number;
  url: string;
  state: GatewayProbeState;
  broadcast: (payload: string) => void;
  close: () => Promise<void>;
}> {
  const server = createServer();
  const wss = new WebSocketServer({ server });
  const state: GatewayProbeState = {
    lastUrl: null,
    lastAuthHeader: undefined,
    lastProtocols: [],
    received: [],
  };

  wss.on('connection', (ws, req) => {
    state.lastUrl = req.url || null;
    state.lastAuthHeader = Array.isArray(req.headers.authorization)
      ? req.headers.authorization[0]
      : req.headers.authorization;
    state.lastProtocols = String(req.headers['sec-websocket-protocol'] || '')
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);

    setTimeout(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'session_start', session_id: 'gw_test_session', resumed: false, message_count: 0 }));
      }
    }, 10);
    ws.on('message', (data) => {
      state.received.push(data.toString());
    });
  });

  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 0);
    });
  });

  return {
    server,
    port,
    url: `ws://127.0.0.1:${port}/ws/chat`,
    state,
    broadcast: (payload: string) => {
      for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN) client.send(payload);
      }
    },
    close: async () => {
      for (const client of wss.clients) client.close();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describeWsProxy('ws-proxy', () => {
  let proxyServer: Server;
  let proxyPort: number;
  let gateway: Awaited<ReturnType<typeof createGatewayProbe>>;
  const mockedConfig = config as MutableConfig;
  const mockedVerifySession = verifySession as ReturnType<typeof vi.fn>;
  const mockedParseSessionCookie = parseSessionCookie as ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    mockedConfig.auth = false;
    mockedConfig.gatewayToken = 'test-token';
    mockedVerifySession.mockReset();
    mockedParseSessionCookie.mockReset();

    gateway = await createGatewayProbe();
    proxyServer = createServer();
    setupWebSocketProxy(proxyServer);
    proxyPort = await new Promise<number>((resolve) => {
      proxyServer.listen(0, '127.0.0.1', () => {
        const addr = proxyServer.address();
        resolve(typeof addr === 'object' && addr ? addr.port : 0);
      });
    });
  });

  afterEach(async () => {
    closeAllWebSockets();
    await new Promise<void>((resolve) => proxyServer.close(() => resolve()));
    await gateway.close();
  });

  afterAll(() => {
    closeAllWebSockets();
  });

  it('rejects connections without ?target param', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${proxyPort}/ws`);
    const { code, reason } = await waitForCloseOrError(ws);
    expect(code).toBe(1008);
    expect(reason).toContain('Missing');
  });

  it('rejects disallowed targets', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${proxyPort}/ws?target=${encodeURIComponent('ws://evil.example:1234/ws/chat')}`);
    const { code, reason } = await waitForCloseOrError(ws);
    expect(code).toBe(1008);
    expect(reason).toContain('not allowed');
  });

  it('rejects websocket upgrades from disallowed origins', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${proxyPort}/ws?target=${encodeURIComponent(gateway.url)}`, {
      origin: 'https://evil.example',
    });
    const { code, reason } = await waitForCloseOrError(ws);
    expect(code).toBe(1006);
    expect(reason.length).toBeGreaterThan(0);
  });

  it('relays session_start from the gateway', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${proxyPort}/ws?target=${encodeURIComponent(gateway.url)}`);
    const msg = JSON.parse(await waitForMessage(ws));
    expect(msg.type).toBe('session_start');
    expect(msg.session_id).toBe('gw_test_session');
    ws.close();
  });

  it('forwards token, session_id, and zeroclaw protocol metadata to the gateway', async () => {
    const token = 'zc_test_123';
    const sessionId = 'session-abc';
    const ws = new WebSocket(
      `ws://127.0.0.1:${proxyPort}/ws?target=${encodeURIComponent(gateway.url)}&token=${encodeURIComponent(token)}&session_id=${encodeURIComponent(sessionId)}`,
      ['zeroclaw.v1'],
    );
    await waitForMessage(ws);

    expect(gateway.state.lastUrl).toContain('/ws/chat');
    expect(gateway.state.lastUrl).toContain(`session_id=${sessionId}`);
    expect(gateway.state.lastUrl).toContain(`token=${token}`);
    expect(gateway.state.lastAuthHeader).toBe(`Bearer ${token}`);
    expect(gateway.state.lastProtocols).toContain('zeroclaw.v1');
    expect(gateway.state.lastProtocols).toContain(`bearer.${token}`);
    ws.close();
  });

  it('injects configured gateway token for trusted authenticated clients', async () => {
    mockedConfig.auth = true;
    mockedParseSessionCookie.mockReturnValue('good-token');
    mockedVerifySession.mockReturnValue({ exp: Date.now() + 60_000, iat: Date.now() });

    const ws = new WebSocket(`ws://127.0.0.1:${proxyPort}/ws?target=${encodeURIComponent(gateway.url)}&session_id=trusted-session`, {
      headers: { Cookie: 'nerve_session_3080=good-token' },
    });
    await waitForMessage(ws);

    expect(gateway.state.lastUrl).toContain('trusted-session');
    expect(gateway.state.lastAuthHeader).toBe('Bearer test-token');
    expect(gateway.state.lastProtocols).toContain('bearer.test-token');
    ws.close();
  });

  it('relays client messages to the gateway and gateway messages back to the client', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${proxyPort}/ws?target=${encodeURIComponent(gateway.url)}`);
    await waitForMessage(ws);

    ws.send(JSON.stringify({ type: 'message', content: 'hello proxy' }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(gateway.state.received).toContain(JSON.stringify({ type: 'message', content: 'hello proxy' }));

    gateway.broadcast(JSON.stringify({ type: 'chunk', content: 'hello back' }));
    const relayed = JSON.parse(await waitForMessage(ws));
    expect(relayed).toEqual({ type: 'chunk', content: 'hello back' });
    ws.close();
  });

  it('rejects upgrades when auth is enabled and no valid session exists', async () => {
    mockedConfig.auth = true;
    mockedParseSessionCookie.mockReturnValue(null);

    const ws = new WebSocket(`ws://127.0.0.1:${proxyPort}/ws?target=${encodeURIComponent(gateway.url)}`);
    const { code } = await waitForCloseOrError(ws);
    expect(code).toBe(1006);
  });

  it('allows upgrades when auth is enabled and the session is valid', async () => {
    mockedConfig.auth = true;
    mockedParseSessionCookie.mockReturnValue('good-token');
    mockedVerifySession.mockReturnValue({ exp: Date.now() + 60_000, iat: Date.now() });

    const ws = new WebSocket(`ws://127.0.0.1:${proxyPort}/ws?target=${encodeURIComponent(gateway.url)}`, {
      headers: { Cookie: 'nerve_session_3080=good-token' },
    });
    const msg = JSON.parse(await waitForMessage(ws));
    expect(msg.type).toBe('session_start');
    ws.close();
  });

  it('closeAllWebSockets closes active proxy connections', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${proxyPort}/ws?target=${encodeURIComponent(gateway.url)}`);
    await waitForMessage(ws);

    const closePromise = waitForClose(ws);
    closeAllWebSockets();
    const { code } = await closePromise;
    expect(code).toBe(1001);
  });
});
