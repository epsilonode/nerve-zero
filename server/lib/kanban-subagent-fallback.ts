/**
 * Server-side Kanban subagent launch helper.
 *
 * Kanban tasks should run as real child sessions under an existing top-level
 * agent root, not as synthetic message conventions that hope the parent will
 * spawn on our behalf.
 *
 * Historical note: the surrounding route code still uses the word “fallback”
 * because assigned-root execution originally existed as a macOS-specific
 * workaround. The transport here is now a first-class session primitive.
 *
 * @module
 */

import { randomUUID } from 'node:crypto';
import { resolveKanbanAssigneeRootSessionKey } from './kanban-assignee.js';
import { deleteZeroClawSession, spawnZeroClawSession } from './zeroclaw-sessions.js';

export interface KanbanFallbackLaunchResult {
  /** Deterministic correlation key stored on the task run link. */
  sessionKey: string;
  /** Existing top-level agent root that owns the spawned child. */
  parentSessionKey: string;
  /** Real worker session created under the selected parent root. */
  childSessionKey: string;
  /** Back-compat snapshot hook for older poller logic. */
  knownSessionKeysBefore: string[];
  /** Optional runId returned by the initial session send. */
  runId?: string;
}

/**
 * Generate a deterministic Kanban run correlation key from a launch label.
 *
 * Historical note: the run link field is still named `sessionKey`, but for
 * Kanban execution this value is only a stable run correlation key. The real
 * worker session key is attached separately as `childSessionKey`.
 */
export function buildKanbanFallbackRunKey(label: string): string {
  const normalized = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return `kanban-root:${normalized}`;
}

/** Resolve the owning top-level worker root session for a task assignee. */
export function resolveKanbanFallbackParentSessionKey(assignee?: string): string | null {
  return resolveKanbanAssigneeRootSessionKey(assignee);
}

function buildChildSessionKey(parentSessionKey: string): string {
  const match = parentSessionKey.match(/^agent:([^:]+):main$/);
  if (!match) {
    throw new Error(`Parent agent session must be a top-level root: ${parentSessionKey}`);
  }
  return `agent:${match[1]}:subagent:${randomUUID()}`;
}

/**
 * Launch a Kanban task as a real child session under an existing top-level
 * agent root.
 */
export async function launchKanbanAssignedSubagent(params: {
  label: string;
  task: string;
  parentSessionKey: string;
  model?: string;
  thinking?: string;
}): Promise<KanbanFallbackLaunchResult> {
  const sessionKey = buildKanbanFallbackRunKey(params.label);
  const childSessionKey = buildChildSessionKey(params.parentSessionKey);

  let sendResponse: { sessionKey: string; runId?: string };
  try {
    sendResponse = await spawnZeroClawSession({
      task: params.task,
      label: params.label,
      model: params.model,
      thinking: params.thinking,
    });
  } catch (error) {
    try {
      await deleteZeroClawSession(childSessionKey);
    } catch {
      // Best-effort cleanup only; preserve the original launch failure.
    }
    throw error;
  }

  return {
    sessionKey,
    parentSessionKey: params.parentSessionKey,
    childSessionKey: sendResponse.sessionKey,
    knownSessionKeysBefore: [params.parentSessionKey],
    runId: sendResponse.runId,
  };
}
