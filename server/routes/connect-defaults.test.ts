/** Tests for the GET /api/connect-defaults endpoint. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';

describe('GET /api/connect-defaults', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Build a Hono app with mocked config for testing. */
  async function buildApp(
    configOverrides: Record<string, unknown> = {},
    remoteAddress: string = '127.0.0.1',
    gatewayReachable = true,
  ) {
    vi.doMock('../lib/config.js', () => ({
      config: {
        gatewayUrl: 'http://127.0.0.1:18789',
        gatewayToken: 'test-token',
        agentName: 'test-agent',
        auth: false,
        ...configOverrides,
      },
    }));

    vi.doMock('../middleware/rate-limit.js', () => ({
      rateLimitGeneral: vi.fn((_c: unknown, next: () => Promise<void>) => next()),
    }));

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: gatewayReachable }));

    const mod = await import('./connect-defaults.js');

    // Wrap the route to inject env.incoming with a mock socket for remoteAddress
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.env = {
        incoming: {
          socket: { remoteAddress } as Socket,
        } as IncomingMessage,
      };
      await next();
    });
    app.route('/', mod.default);
    return app;
  }

  it('derives wsUrl from an http gatewayUrl and returns token: null', async () => {
    const app = await buildApp({ gatewayUrl: 'http://localhost:18789' });
    const res = await app.request('/api/connect-defaults');
    expect(res.status).toBe(200);

    const json = (await res.json()) as {
      wsUrl: string;
      token: string | null;
      agentName: string;
      authEnabled: boolean;
      serverSideAuth: boolean;
      gatewayReachable: boolean;
      handshakeRequired: boolean;
    };
    expect(json.wsUrl).toBe('ws://localhost:18789/ws/chat');
    expect(json.token).toBeNull();
    expect(json.agentName).toBe('test-agent');
    expect(json.authEnabled).toBe(false);
    expect(json.serverSideAuth).toBe(true); // default mock has token and it's loopback
    expect(json.gatewayReachable).toBe(true);
    expect(json.handshakeRequired).toBe(false);
  });

  it('derives wsUrl from an https gatewayUrl as wss://', async () => {
    const app = await buildApp({ gatewayUrl: 'https://example.com:8443' });
    const res = await app.request('/api/connect-defaults');
    expect(res.status).toBe(200);

    const json = (await res.json()) as { wsUrl: string };
    expect(json.wsUrl).toBe('wss://example.com:8443/ws/chat');
  });

  it('includes authEnabled reflecting server config', async () => {
    const app = await buildApp({ auth: true });
    const res = await app.request('/api/connect-defaults');
    const json = (await res.json()) as { authEnabled: boolean; serverSideAuth: boolean };

    expect(json.authEnabled).toBe(true);
    expect(json.serverSideAuth).toBe(true); // auth: true -> trusted -> serverSideAuth: true
  });

  it('sets serverSideAuth: false when gateway token is missing', async () => {
    const app = await buildApp({ gatewayToken: '' });
    const res = await app.request('/api/connect-defaults');
    const json = (await res.json()) as { serverSideAuth: boolean; handshakeRequired: boolean };

    expect(json.serverSideAuth).toBe(false);
    expect(json.handshakeRequired).toBe(true);
  });

  it('sets serverSideAuth: false for external IP when auth is disabled', async () => {
    const app = await buildApp({ auth: false }, '203.0.113.5');
    const res = await app.request('/api/connect-defaults');
    const json = (await res.json()) as { serverSideAuth: boolean; handshakeRequired: boolean };

    expect(json.serverSideAuth).toBe(false);
    expect(json.handshakeRequired).toBe(true);
  });

  it('keeps handshake required when the gateway is unreachable', async () => {
    const app = await buildApp({}, '127.0.0.1', false);
    const res = await app.request('/api/connect-defaults');
    const json = (await res.json()) as { serverSideAuth: boolean; gatewayReachable: boolean; handshakeRequired: boolean };

    expect(json.serverSideAuth).toBe(true);
    expect(json.gatewayReachable).toBe(false);
    expect(json.handshakeRequired).toBe(true);
  });
});
