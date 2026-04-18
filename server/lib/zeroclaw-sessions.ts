import path from 'node:path';
import { config } from './config.js';
import { invokeGatewayTool } from './gateway-client.js';

export interface ZeroClawSessionSummary {
  sessionKey: string;
  createdAt: string;
  lastActivity: string;
  messageCount: number;
  name: string | null;
  state: string;
  turnId: string | null;
  turnStartedAt: string | null;
}

export interface ZeroClawStoredMessage {
  sessionKey: string;
  role: string;
  content: string;
  createdAt: string;
}

const SESSIONS_DB_PATH = path.join(config.home, '.ZeroClaw', 'workspace', 'sessions', 'sessions.db');

async function withSessionDb<T>(fn: (db: { query: (sql: string) => { all: (...params: unknown[]) => T } }) => T): Promise<T> {
  // @ts-expect-error Bun runtime module is available in the deployed server runtime.
  const { Database } = await import('bun:sqlite');
  const db = new Database(SESSIONS_DB_PATH, { readonly: false });
  try {
    return fn(db as { query: (sql: string) => { all: (...params: unknown[]) => T } });
  } finally {
    db.close(false);
  }
}

export async function listZeroClawSessions(limit = 200): Promise<ZeroClawSessionSummary[]> {
  return withSessionDb((db) => db.query(
    `SELECT session_key AS sessionKey, created_at AS createdAt, last_activity AS lastActivity,
            message_count AS messageCount, name, state, turn_id AS turnId, turn_started_at AS turnStartedAt
       FROM session_metadata
      ORDER BY last_activity DESC
      LIMIT ?`,
  ).all(limit) as ZeroClawSessionSummary[]);
}

export async function getZeroClawSessionMessages(sessionKey: string, limit = 20): Promise<ZeroClawStoredMessage[]> {
  return withSessionDb<ZeroClawStoredMessage[]>((db) => db.query(
    `SELECT session_key AS sessionKey, role, content, created_at AS createdAt
       FROM sessions
      WHERE session_key = ?
      ORDER BY id DESC
      LIMIT ?`,
  ).all(sessionKey, limit) as ZeroClawStoredMessage[]).then((rows) => rows.slice().reverse());
}

export async function deleteZeroClawSession(sessionKey: string): Promise<void> {
  await withSessionDb((db) => {
    db.query('DELETE FROM sessions WHERE session_key = ?').all(sessionKey);
    db.query('DELETE FROM session_metadata WHERE session_key = ?').all(sessionKey);
    return undefined;
  });
}

export async function spawnZeroClawSession(params: {
  task: string;
  label: string;
  model?: string;
  thinking?: string;
}): Promise<{ sessionKey: string; runId?: string }> {
  const args: Record<string, unknown> = {
    task: params.task,
    mode: 'run',
    label: params.label,
  };
  if (params.model) args.model = params.model;
  if (params.thinking) args.thinking = params.thinking;

  const raw = await invokeGatewayTool('sessions_spawn', args, 60_000) as Record<string, unknown>;
  const details = (raw.details && typeof raw.details === 'object' ? raw.details : raw) as Record<string, unknown>;
  const sessionKey = typeof details.childSessionKey === 'string'
    ? details.childSessionKey
    : typeof details.sessionKey === 'string'
      ? details.sessionKey
      : typeof details.sessionId === 'string'
        ? details.sessionId
        : '';
  if (!sessionKey) {
    throw new Error('sessions_spawn did not return a session key');
  }
  const runId = typeof details.runId === 'string' ? details.runId : undefined;
  return { sessionKey, runId };
}
