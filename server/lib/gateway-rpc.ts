/**
 * Gateway compatibility helpers.
 *
 * ZeroClaw no longer exposes the older JSON-RPC websocket transport Nerve used
 * for file operations. For the active cockpit paths, the practical replacement
 * is direct workspace filesystem access derived from the current agent id.
 *
 * The generic `gatewayRpcCall` export remains as an explicit compatibility stub
 * for older backend flows that still need to be migrated independently.
 * @module
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveAgentWorkspace } from './agent-workspace.js';

export interface GatewayFileEntry {
  name: string;
  path: string;
  missing: boolean;
  size: number;
  updatedAtMs: number;
}

export interface GatewayFileWithContent extends GatewayFileEntry {
  content: string;
}

export async function gatewayRpcCall(
  method: string,
  _params: Record<string, unknown>,
  _timeoutMs = 10_000,
): Promise<unknown> {
  throw new Error(`Legacy gateway RPC method is not available on current ZeroClaw: ${method}`);
}

function getWorkspaceRoot(agentId: string): string {
  return resolveAgentWorkspace(agentId).workspaceRoot;
}

export async function gatewayFilesList(agentId: string): Promise<GatewayFileEntry[]> {
  const workspaceRoot = getWorkspaceRoot(agentId);
  try {
    const entries = await fs.readdir(workspaceRoot, { withFileTypes: true });
    const files = await Promise.all(entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        const fullPath = path.join(workspaceRoot, entry.name);
        const stat = await fs.stat(fullPath);
        return {
          name: entry.name,
          path: entry.name,
          missing: false,
          size: stat.size,
          updatedAtMs: Math.floor(stat.mtimeMs),
        } satisfies GatewayFileEntry;
      }));
    return files;
  } catch (err) {
    console.debug('[gateway-rpc] filesList fallback error:', (err as Error).message);
    return [];
  }
}

export async function gatewayFilesGet(agentId: string, name: string): Promise<GatewayFileWithContent | null> {
  const workspaceRoot = getWorkspaceRoot(agentId);
  const fullPath = path.join(workspaceRoot, name);
  try {
    const [content, stat] = await Promise.all([
      fs.readFile(fullPath, 'utf8'),
      fs.stat(fullPath),
    ]);
    return {
      name,
      path: name,
      missing: false,
      size: stat.size,
      updatedAtMs: Math.floor(stat.mtimeMs),
      content,
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      console.debug('[gateway-rpc] filesGet fallback error:', (err as Error).message);
    }
    return null;
  }
}

export async function gatewayFilesSet(agentId: string, name: string, content: string): Promise<void> {
  const workspaceRoot = getWorkspaceRoot(agentId);
  const fullPath = path.join(workspaceRoot, name);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, 'utf8');
}
