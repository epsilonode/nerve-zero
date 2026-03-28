/**
 * Server-side root-session launch helper for Kanban execution.
 *
 * Replacement for the architecturally-broken child-session workaround.
 * Uses the frontend-proven pattern: sessions.patch + chat.send(deliver:false).
 *
 * @module
 */

import { randomUUID } from 'node:crypto';
import { gatewayRpcCall } from './gateway-rpc.js';

// ── Types ────────────────────────────────────────────────────────────

export interface KanbanRootSessionLaunchResult {
  sessionKey: string;
  runId?: string;
}

// ── Session key builder ─────────────────────────────────────────────

/**
 * Generate a deterministic root-session key from a Kanban run label.
 * Server-side equivalent to frontend root-session key builder.
 */
export function buildKanbanRootSessionKey(label: string): string {
  // Normalize label for use in session key
  const normalized = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  
  return `kanban-root:${normalized}`;
}

// ── Main launch helper ──────────────────────────────────────────────

/**
 * Launch a Kanban task in a dedicated top-level root session.
 *
 * Uses the frontend-proven pattern:
 * 1. sessions.patch to create/configure the root session
 * 2. chat.send with deliver:false to execute without leaking to main chat
 *
 * @param params - Kanban task launch parameters
 * @returns Session key and optional run ID from chat.send
 */
export async function launchKanbanRootSessionViaRpc(params: {
  label: string;
  task: string;
  model?: string;
  thinking?: string;
}): Promise<KanbanRootSessionLaunchResult> {
  // 1. Generate deterministic session key from label
  const sessionKey = buildKanbanRootSessionKey(params.label);

  // 2. Build sessions.patch params
  const patchParams: Record<string, unknown> = {
    sessionKey,
  };

  // Include model and thinking only if provided
  if (params.model) {
    patchParams.model = params.model;
  }
  if (params.thinking) {
    patchParams.thinking = params.thinking;
  }

  // 3. Call sessions.patch to create/configure the root session
  await gatewayRpcCall('sessions.patch', patchParams);

  // 4. Build chat.send params with idempotency key
  const idempotencyKey = `kanban-root-${Date.now()}-${randomUUID().slice(0, 8)}`;
  
  const chatSendParams: Record<string, unknown> = {
    sessionKey,
    message: params.task,
    deliver: false,
    idempotencyKey,
  };

  // 5. Call chat.send with deliver:false
  const chatSendResponse = await gatewayRpcCall('chat.send', chatSendParams) as {
    runId?: string;
  };

  // 6. Return session key and runId
  return {
    sessionKey,
    runId: chatSendResponse.runId,
  };
}
