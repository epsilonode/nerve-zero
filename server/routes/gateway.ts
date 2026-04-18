/**
 * Gateway API Routes
 *
 * GET  /api/gateway/models       — Returns configured models from the active ZeroClaw config.
 * GET  /api/gateway/session-info — Returns the current session's runtime info (model, thinking level).
 * POST /api/gateway/session-patch — Change model/effort for a session via HTTP (reliable fallback).
 * POST /api/gateway/restart      — Restart the ZeroClaw gateway service via `ZeroClaw gateway restart`.
 *
 * Response (models):       { models: Array<{ id: string; label: string; provider: string; configured: true; role: string }>, error: string | null, source: 'config' }
 * Response (session-info): { model?: string; thinking?: string }
 * Response (session-patch): { ok: boolean; model?: string; thinking?: string; error?: string }
 * Response (restart):      { ok: boolean; output: string }
 */

import { Hono } from 'hono';
import JSON5 from 'json5';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { Socket } from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { invokeGatewayTool } from '../lib/gateway-client.js';
import { rateLimitGeneral, rateLimitRestart } from '../middleware/rate-limit.js';
import { resolveZeroclawBin } from '../lib/zeroclaw-bin.js';
import { config } from '../lib/config.js';
import { extractDefaultModel, extractDefaultThinking, readZeroClawConfigSource } from '../lib/zeroclaw-config.js';

const app = new Hono();

const GATEWAY_TIMEOUT_MS = 8_000;
export const MODEL_LIST_TIMEOUT_MS = 15_000;
const SESSIONS_ACTIVE_MINUTES = 24 * 60;
const SESSIONS_LIMIT = 200;

export interface GatewayModelInfo {
  id: string;
  label: string;
  provider: string;
  alias?: string;
  configured: true;
  role: 'primary' | 'fallback' | 'allowed';
}

interface GatewaySessionSummary {
  sessionKey?: string;
  key?: string;
  model?: string;
  thinking?: string;
  thinkingLevel?: string;
}

const gatewayPairSchema = z.object({
  url: z.string().url(),
  pairCode: z.string().min(1).max(200),
});

function toGatewayHttpBase(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol === 'ws:') parsed.protocol = 'http:';
  if (parsed.protocol === 'wss:') parsed.protocol = 'https:';
  if (parsed.pathname.endsWith('/ws/chat')) {
    parsed.pathname = parsed.pathname.slice(0, -'/ws/chat'.length) || '/';
  } else if (parsed.pathname.endsWith('/ws')) {
    parsed.pathname = parsed.pathname.slice(0, -'/ws'.length) || '/';
  }
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/$/, '');
}

function extractPairToken(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  const candidates = [
    record.token,
    record.bearerToken,
    record.accessToken,
    record.access_token,
    (record.data as Record<string, unknown> | undefined)?.token,
    (record.data as Record<string, unknown> | undefined)?.bearerToken,
    (record.data as Record<string, unknown> | undefined)?.accessToken,
    (record.data as Record<string, unknown> | undefined)?.access_token,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return null;
}

// ─── Model catalog via active ZeroClaw config ──────────────────────────────────

const ZeroClawBin = resolveZeroclawBin();

/** Directory containing the node binary — needed in PATH for `#!/usr/bin/env node` shims. */
const nodeBinDir = process.execPath.replace(/\/node$/, '');

const CONFIG_READ_ERROR = 'Could not read ZeroClaw config.';
const NO_CONFIGURED_MODELS_ERROR = 'No models configured in ZeroClaw config.';

interface ZeroClawModelConfigEntry {
  alias?: string;
}

interface ZeroClawConfig {
  agents?: {
    defaults?: {
      model?: {
        primary?: string;
        fallbacks?: string[];
      };
      models?: Record<string, ZeroClawModelConfigEntry | undefined>;
    };
  };
}

/**
 * Infer the HOME directory for ZeroClaw execution.
 * When server runs as root but ZeroClaw is installed under a user account
 * (e.g., /home/username/.nvm/...), we need to use that user's HOME so ZeroClaw
 * can find its config at ~/.ZeroClaw/ZeroClaw.json.
 *
 * Extracts home from paths like:
 *   /home/username/.nvm/... → /home/username
 *   /Users/username/.nvm/... → /Users/username
 *
 * Falls back to process.env.HOME if extraction fails.
 */
function inferZeroClawHome(): string {
  const match = ZeroClawBin.match(/^(\/home\/[^/]+|\/Users\/[^/]+)/);
  if (match) return match[1];

  return process.env.HOME || homedir();
}

const ZeroClawHome = inferZeroClawHome();

function resolveZeroClawConfigPath(): string {
  return process.env.ZeroClaw_CONFIG_PATH?.trim() || path.join(ZeroClawHome, '.ZeroClaw', 'ZeroClaw.json');
}

function normalizeAlias(entry: ZeroClawModelConfigEntry | undefined): string | undefined {
  const alias = entry?.alias;
  return typeof alias === 'string' && alias.trim() ? alias.trim() : undefined;
}

function buildGatewayModelInfo(
  id: string,
  role: GatewayModelInfo['role'],
  entry: ZeroClawModelConfigEntry | undefined,
): GatewayModelInfo {
  const alias = normalizeAlias(entry);
  const [provider, ...rest] = id.split('/');

  return {
    id,
    label: alias || rest.join('/') || id,
    provider: provider || 'unknown',
    ...(alias ? { alias } : {}),
    configured: true,
    role,
  };
}

function readConfiguredModels(configData: ZeroClawConfig): GatewayModelInfo[] {
  const defaults = configData.agents?.defaults;
  const modelDefaults = defaults?.model;
  const allowlist = defaults?.models || {};
  const seen = new Set<string>();
  const models: GatewayModelInfo[] = [];

  const addModel = (value: unknown, role: GatewayModelInfo['role']) => {
    if (typeof value !== 'string' || !value.trim()) return;
    const id = value.trim();
    if (seen.has(id)) return;
    seen.add(id);
    models.push(buildGatewayModelInfo(id, role, allowlist[id]));
  };

  addModel(modelDefaults?.primary, 'primary');

  for (const fallback of modelDefaults?.fallbacks || []) {
    addModel(fallback, 'fallback');
  }

  const remainingAllowlistEntries = Object.keys(allowlist)
    .filter((id) => !seen.has(id))
    .sort((a, b) => a.localeCompare(b));

  for (const id of remainingAllowlistEntries) {
    addModel(id, 'allowed');
  }

  return models;
}

async function getModelCatalog(): Promise<{ models: GatewayModelInfo[]; error: string | null }> {
  try {
    const source = await readZeroClawConfigSource();
    const models = source.path.toLowerCase().endsWith('.toml')
      ? (() => {
          const primary = extractDefaultModel(source.raw);
          return primary ? [buildGatewayModelInfo(primary, 'primary', undefined)] : [];
        })()
      : readConfiguredModels(JSON5.parse(source.raw) as ZeroClawConfig);

    if (models.length === 0) {
      return { models: [], error: NO_CONFIGURED_MODELS_ERROR };
    }

    return { models, error: null };
  } catch (err) {
    console.warn('[gateway/models] failed to read configured models from config:', (err as Error).message);
    return { models: [], error: CONFIG_READ_ERROR };
  }
}

app.get('/api/gateway/models', rateLimitGeneral, async (c) => {
  const { models, error } = await getModelCatalog();
  return c.json({ models, error, source: 'config' });
});

app.post('/api/gateway/pair', rateLimitGeneral, async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  const parsed = gatewayPairSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, error: 'Invalid pairing request' }, 400);
  }

  const gatewayBaseUrl = toGatewayHttpBase(parsed.data.url);

  try {
    const response = await fetch(`${gatewayBaseUrl}/pair`, {
      method: 'POST',
      headers: {
        'X-Pairing-Code': parsed.data.pairCode.trim(),
      },
      signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
    });

    let payload: unknown = null;
    const text = await response.text();
    if (text.trim()) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { message: text.trim() };
      }
    }

    if (!response.ok) {
      const errorMessage = (payload && typeof payload === 'object' && 'error' in payload && typeof (payload as Record<string, unknown>).error === 'string')
        ? (payload as Record<string, unknown>).error as string
        : `Gateway pairing failed with HTTP ${response.status}`;
      return c.json({ ok: false, error: errorMessage }, { status: response.status as 400 | 401 | 403 | 404 | 429 | 500 | 502 | 503 | 504 });
    }

    const token = extractPairToken(payload);
    if (!token) {
      return c.json({ ok: false, error: 'Gateway pair succeeded but no token was returned' }, 502);
    }

    return c.json({ ok: true, token });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ ok: false, error: `Gateway pairing request failed: ${message}` }, 502);
  }
});

/**
 * Extract the current session's thinking/effort level from gateway status.
 * Looks in common locations: agent.thinking, config.thinking, top-level thinking,
 * and falls back to parsing the runtime string (e.g. "thinking=medium").
 */
function extractThinking(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;

  // Direct fields
  const candidates = [
    p.thinking,
    (p.agent as Record<string, unknown> | undefined)?.thinking,
    (p.config as Record<string, unknown> | undefined)?.thinking,
  ];

  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim().toLowerCase();
  }

  // Parse from runtime string (e.g. "thinking=medium")
  const runtime = p.runtime || (p.agent as Record<string, unknown> | undefined)?.runtime;
  if (typeof runtime === 'string') {
    const match = runtime.match(/thinking=(\w+)/);
    if (match) return match[1].toLowerCase();
  }

  return null;
}

/**
 * Extract the current session's model from gateway status.
 */
function extractSessionModel(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;

  const candidates = [
    p.model,
    p.defaultModel,
    (p.agent as Record<string, unknown> | undefined)?.model,
    (p.config as Record<string, unknown> | undefined)?.model,
  ];

  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }

  // Parse from runtime string (e.g. "model=anthropic/claude-opus-4-6")
  const runtime = p.runtime || (p.agent as Record<string, unknown> | undefined)?.runtime;
  if (typeof runtime === 'string') {
    const match = runtime.match(/model=(\S+)/);
    if (match) return match[1];
  }

  return null;
}

function getGatewaySessionKey(session: GatewaySessionSummary): string {
  return session.sessionKey || session.key || '';
}

function isTopLevelAgentSessionKey(sessionKey: string): boolean {
  return /^agent:[^:]+:main$/.test(sessionKey);
}

function pickPreferredSessionKey(sessions: GatewaySessionSummary[]): string {
  const explicitMain = sessions.find((session) => getGatewaySessionKey(session) === 'agent:main:main');
  if (explicitMain) return 'agent:main:main';

  const firstRoot = sessions.find((session) => isTopLevelAgentSessionKey(getGatewaySessionKey(session)));
  if (firstRoot) return getGatewaySessionKey(firstRoot);

  return getGatewaySessionKey(sessions[0] || {});
}

app.get('/api/gateway/session-info', rateLimitGeneral, async (c) => {
  const requestedSessionKey = c.req.query('sessionKey')?.trim() || '';
  const info: { model?: string; thinking?: string } = {};

  try {
    const source = await readZeroClawConfigSource();
    if (source.path.toLowerCase().endsWith('.toml')) {
      const model = extractDefaultModel(source.raw);
      const thinking = extractDefaultThinking(source.raw);
      if (model) info.model = model;
      if (thinking) info.thinking = thinking.toLowerCase();
      if (!requestedSessionKey || (info.model || info.thinking)) return c.json(info);
    }
  } catch (err) {
    console.warn('[gateway/session-info] config fallback failed:', (err as Error).message);
  }

  // Legacy fallback for older gateway builds that still expose sessions_list.
  try {
    const result = await invokeGatewayTool(
      'sessions_list',
      { activeMinutes: SESSIONS_ACTIVE_MINUTES, limit: SESSIONS_LIMIT },
      GATEWAY_TIMEOUT_MS,
    ) as Record<string, unknown>;

    // sessions_list output shape may vary depending on gateway version:
    // - { sessions: [...] }
    // - { details: { sessions: [...] }, ... }
    const r = result as unknown as { sessions?: unknown; details?: { sessions?: unknown } };
    const sessions = (Array.isArray(r.sessions)
      ? r.sessions
      : Array.isArray(r.details?.sessions)
        ? r.details?.sessions
        : []) as GatewaySessionSummary[];
    const sessionKey = requestedSessionKey || pickPreferredSessionKey(sessions);
    const session = sessions.find(s => (s.sessionKey || s.key) === sessionKey);
    if (session) {
      if (session.model) info.model = session.model;
      const thinking = session.thinking || session.thinkingLevel;
      if (thinking) info.thinking = thinking.toLowerCase();
    }
    if (info.model || info.thinking) return c.json(info);
  } catch (err) {
    console.warn(`[gateway/session-info] sessions_list failed:`, (err as Error).message);
  }

  // Fallback: try global status tools (less accurate — returns global defaults, not per-session)
  const toolsToTry = ['session_status'];
  for (const tool of toolsToTry) {
    try {
      const result = await invokeGatewayTool(tool, {}, GATEWAY_TIMEOUT_MS);
      const thinking = extractThinking(result);
      const model = extractSessionModel(result);
      if (thinking && !info.thinking) info.thinking = thinking;
      if (model && !info.model) info.model = model;
      if (info.thinking && info.model) return c.json(info);
    } catch (err) {
      console.warn(`[gateway/session-info] ${tool} failed:`, (err as Error).message);
    }
  }

  return c.json(info);
});

// ─── Session patch via HTTP (reliable fallback for WS RPC) ─────────────────────

const sessionPatchSchema = z.object({
  sessionKey: z.string().max(200).optional(),
  model: z.string().max(200).optional(),
  thinkingLevel: z.string().max(50).nullable().optional(),
});

type SessionPatchBody = z.infer<typeof sessionPatchSchema>;

function upsertTomlScalar(raw: string, section: string | null, key: string, value: string): string {
  const assignment = `${key} = ${JSON.stringify(value)}`;
  if (!section) {
    const re = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=.*$`, 'm');
    if (re.test(raw)) return raw.replace(re, assignment);
    return `${assignment}\n${raw}`;
  }

  const escapedSection = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const blockRe = new RegExp(`^\\[${escapedSection}\\]\\s*$[\\s\\S]*?(?=^\\[[^\n]+\\]\\s*$|\\Z)`, 'im');
  const existingBlock = raw.match(blockRe)?.[0];
  if (existingBlock) {
    const keyRe = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=.*$`, 'm');
    const nextBlock = keyRe.test(existingBlock)
      ? existingBlock.replace(keyRe, assignment)
      : `${existingBlock.trimEnd()}\n${assignment}`;
    return raw.replace(blockRe, nextBlock);
  }

  const suffix = raw.endsWith('\n') ? '' : '\n';
  return `${raw}${suffix}\n[${section}]\n${assignment}\n`;
}

/**
 * POST /api/gateway/session-patch
 *
 * Changes model and/or thinking level for a session.  Uses the `session_status`
 * tool for model changes (proven reliable) and `sessions_list` + gateway WS RPC
 * fallback for thinking level.
 *
 * This exists as a reliable HTTP fallback when the frontend's direct WS RPC
 * (`sessions.patch`) fails due to proxy issues, reconnection races, etc.
 */
app.post('/api/gateway/session-patch', rateLimitGeneral, async (c) => {
  let body: SessionPatchBody;
  try {
    const raw = await c.req.json();
    const parsed = sessionPatchSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ ok: false, error: parsed.error.issues[0]?.message || 'Invalid body' }, 400);
    }
    body = parsed.data;
  } catch {
    return c.json({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  let sessionKey = body.sessionKey?.trim() || '';
  const result: { ok: boolean; model?: string; thinking?: string; error?: string } = { ok: true };

  try {
    const source = await readZeroClawConfigSource();
    if (source.path.toLowerCase().endsWith('.toml')) {
      let nextRaw = source.raw;
      if (body.model) {
        nextRaw = upsertTomlScalar(nextRaw, null, 'default_model', body.model);
        result.model = body.model;
      }
      if (body.thinkingLevel !== undefined) {
        nextRaw = upsertTomlScalar(nextRaw, 'agent.thinking', 'default_level', body.thinkingLevel ?? 'off');
        result.thinking = body.thinkingLevel ?? 'off';
      }
      if (nextRaw !== source.raw) {
        await writeFile(source.path, nextRaw, 'utf8');
      }
      if (result.model || result.thinking) {
        return c.json(result);
      }
    }
  } catch (err) {
    console.warn('[gateway/session-patch] config-backed patch failed:', (err as Error).message);
  }

  if (!sessionKey) {
    try {
      const listResult = await invokeGatewayTool(
        'sessions_list',
        { activeMinutes: SESSIONS_ACTIVE_MINUTES, limit: SESSIONS_LIMIT },
        GATEWAY_TIMEOUT_MS,
      ) as Record<string, unknown>;
      const r = listResult as { sessions?: unknown; details?: { sessions?: unknown } };
      const sessions = (Array.isArray(r.sessions)
        ? r.sessions
        : Array.isArray(r.details?.sessions)
          ? r.details?.sessions
          : []) as GatewaySessionSummary[];
      sessionKey = pickPreferredSessionKey(sessions);
    } catch (err) {
      console.warn('[gateway/session-patch] sessions_list fallback failed:', (err as Error).message);
    }
  }

  if (!sessionKey) {
    return c.json(
      { ok: false, error: 'No active root session available. Provide sessionKey explicitly.' },
      409,
    );
  }

  // Change model via session_status tool (reliable — uses HTTP tools/invoke)
  if (body.model) {
    try {
      const statusResult = await invokeGatewayTool(
        'session_status',
        { model: body.model, sessionKey },
        GATEWAY_TIMEOUT_MS,
      ) as Record<string, unknown>;

      // Extract confirmed model from response
      const details = statusResult?.details as Record<string, unknown> | undefined;
      if (details?.changedModel === false && details?.statusText) {
        // session_status returns changedModel:false when model is already set or change failed
        // Parse the model from status text as confirmation
        const statusText = details.statusText as string;
        const modelMatch = statusText.match(/Model:\s*(\S+)/);
        result.model = modelMatch?.[1] || body.model;
      } else {
        result.model = body.model;
      }
    } catch (err) {
      console.warn('[gateway/session-patch] session_status model change failed:', (err as Error).message);
      result.ok = false;
      result.error = `Model change failed: ${(err as Error).message}`;
      return c.json(result, 502);
    }
  }

  // Thinking level changes are NOT supported via this HTTP endpoint.
  // The gateway's session_status tool doesn't accept thinkingLevel.
  // The frontend should use the WS RPC (sessions.patch) for thinking changes.
  if (body.thinkingLevel !== undefined && !body.model) {
    return c.json({ ok: false, error: 'Thinking level changes are only supported via WebSocket RPC' }, 501);
  } else if (body.thinkingLevel !== undefined) {
    // Model change succeeded above, but note thinking was not applied
    result.thinking = undefined;
  }

  return c.json(result);
});

// ── POST /api/gateway/restart ───────────────────────────────────────

const GATEWAY_RESTART_TIMEOUT_MS = 15_000;

app.post('/api/gateway/restart', rateLimitRestart, async (c) => {
  // DBus session vars are required for `systemctl --user` commands.
  // When Nerve runs as a system service these may be absent; provide fallbacks.
  const uid = process.getuid?.() ?? 1000;
  const xdgRuntime = process.env.XDG_RUNTIME_DIR || `/run/user/${uid}`;

  const execEnv = {
    ...process.env,
    HOME: ZeroClawHome,
    PATH: `${nodeBinDir}:${process.env.PATH || '/usr/bin:/bin'}`,
    XDG_RUNTIME_DIR: xdgRuntime,
    DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS || `unix:path=${xdgRuntime}/bus`,
  };

  // Step 1: restart the gateway
  const restartResult = await new Promise<{ ok: boolean; output: string }>((resolve) => {
    execFile(ZeroClawBin, ['gateway', 'restart'], {
      timeout: GATEWAY_RESTART_TIMEOUT_MS,
      maxBuffer: 512 * 1024,
      env: execEnv,
    }, (err, stdout, stderr) => {
      const output = (stdout + stderr).trim();
      if (err) {
        resolve({ ok: false, output: output || err.message });
      } else {
        // Treat zero exit code as success; actual health is verified in step 2.
        resolve({ ok: true, output });
      }
    });
  });

  if (!restartResult.ok) {
    return c.json(restartResult, 500);
  }

  // Step 2: verify gateway is actually running AND listening (not just systemd reporting)
  // Wait 2s after restart command, then retry up to 8 times with 1s delay (max ~10s total)
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  let statusResult: { ok: boolean; output: string } | null = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    if (attempt > 0) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    // First check if systemd reports it as running
    statusResult = await new Promise<{ ok: boolean; output: string }>((resolve) => {
      execFile(ZeroClawBin, ['gateway', 'status'], {
        timeout: 5000,
        maxBuffer: 512 * 1024,
        env: execEnv,
      }, (err, stdout, stderr) => {
        const output = (stdout + stderr).trim();
        if (err) {
          resolve({ ok: false, output: output || err.message });
        } else {
          // Check for positive running state AND absence of failure indicators
          const running = output.includes('Runtime: running');
          const activating = output.includes('state activating');
          const failed = output.includes('last exit 1') && !running;
          // activating is a normal transitional state -- keep retrying
          const ok = running && !failed;
          if (activating && !running) { resolve({ ok: false, output }); return; }
          resolve({ ok, output });
        }
      });
    });
    
    if (!statusResult.ok) continue;
    
    // If systemd reports running, verify the port is actually listening
    const portTest = await new Promise<boolean>((resolve) => {
      const socket = new Socket();
      
      const gwUrl = new URL(config.gatewayUrl);
      const gwPort = parseInt(gwUrl.port, 10) || 18789;
      socket.setTimeout(2000);
      socket.connect(gwPort, gwUrl.hostname, () => {
        socket.end();
        resolve(true);
      });
      
      socket.on('error', () => {
        socket.destroy();
        resolve(false);
      });
      socket.on('timeout', () => {
        socket.destroy();
        resolve(false);
      });
    });
    
    if (portTest) break;
    
    // Port not ready yet, continue retrying
    statusResult.ok = false;
    statusResult.output += '\nGateway running but port not ready yet';
  }

  if (!statusResult || !statusResult.ok) {
    return c.json({
      ok: false,
      output: `Gateway restarted but not running. Status:\n${statusResult?.output || 'Status check failed'}`,
    }, 500);
  }

  return c.json({ ok: true, output: 'Gateway restarted successfully' });
});

export default app;
