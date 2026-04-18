/**
 * Skills API Routes
 *
 * GET /api/skills — List all skills via `ZeroClaw skills list --json`
 */

import { Hono } from 'hono';
import fs from 'node:fs/promises';
import os from 'node:os';
import { execFile, type ExecFileException } from 'node:child_process';
import { dirname, join } from 'node:path';
import { rateLimitGeneral } from '../middleware/rate-limit.js';
import { resolveZeroclawBin } from '../lib/zeroclaw-bin.js';
import { InvalidAgentIdError, resolveAgentWorkspace } from '../lib/agent-workspace.js';
import { config } from '../lib/config.js';

const app = new Hono();

const SKILLS_TIMEOUT_MS = 15_000;
const ZeroClaw_CONFIG_FILENAME = 'ZeroClaw.json';

/** Ensure PATH includes the directory of the current Node binary (for #!/usr/bin/env node shims under systemd) */
const nodeDir = dirname(process.execPath);
const enrichedEnv = { ...process.env, PATH: `${nodeDir}:${process.env.PATH || ''}` };

interface SkillMissing {
  bins?: string[];
  anyBins?: string[];
  env?: string[];
  config?: string[];
  os?: string[];
}

interface RawSkill {
  name: string;
  description: string;
  emoji: string;
  eligible: boolean;
  disabled: boolean;
  blockedByAllowlist: boolean;
  source: string;
  bundled: boolean;
  homepage?: string;
  missing?: SkillMissing;
}

interface SkillsOutput {
  workspaceDir?: string;
  managedSkillsDir?: string;
  skills?: RawSkill[];
}

class SkillsRouteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillsRouteError';
  }
}

function extractJsonPayload(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new SkillsRouteError('ZeroClaw skills list returned empty output');
  }

  // Normal case: pure JSON output.
  try {
    return JSON.parse(trimmed);
  } catch {
    // Fall through to prelude-tolerant parsing.
  }

  // ZeroClaw can print warnings before JSON.
  // Try parsing from each possible JSON structure start ({ or [).
  const startIndices: number[] = [];
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === '{' || ch === '[') {
      startIndices.push(i);
    }
  }

  for (const start of startIndices) {
    const candidate = trimmed.slice(start).trim();
    try {
      return JSON.parse(candidate);
    } catch {
      // Keep scanning for the next JSON structure start.
    }
  }

  throw new SkillsRouteError('Failed to parse ZeroClaw skills output as JSON');
}

function parseSkillsOutput(stdout: string): RawSkill[] {
  const parsed = extractJsonPayload(stdout);

  if (Array.isArray(parsed)) {
    return parsed as RawSkill[];
  }

  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as SkillsOutput).skills)) {
    return (parsed as SkillsOutput).skills as RawSkill[];
  }

  throw new SkillsRouteError('Invalid ZeroClaw skills payload: missing skills array');
}

function formatExecError(err: ExecFileException, stderr: string, commandLabel: string): string {
  if (err.code === 'ENOENT') {
    return 'ZeroClaw CLI not found in PATH';
  }

  if (err.killed && err.signal === 'SIGTERM') {
    return `${commandLabel} timed out after ${SKILLS_TIMEOUT_MS}ms`;
  }

  const stderrLine = stderr.trim().split('\n').find(Boolean);
  if (stderrLine) {
    return `${commandLabel} failed: ${stderrLine}`;
  }

  return `${commandLabel} failed: ${err.message}`;
}

function execZeroClawCommand(
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const ZeroClawBin = resolveZeroclawBin();
    execFile(ZeroClawBin, args, {
      timeout: SKILLS_TIMEOUT_MS,
      maxBuffer: 2 * 1024 * 1024,
      env: opts.env ?? enrichedEnv,
      cwd: opts.cwd,
    }, (err, stdout, stderr) => {
      if (err) {
        const label = `ZeroClaw ${args.join(' ')}`;
        return reject(new SkillsRouteError(formatExecError(err, stderr, label)));
      }
      return resolve({ stdout, stderr });
    });
  });
}

function getActiveZeroClawConfigPath(): string {
  const envPath = process.env.ZeroClaw_CONFIG_PATH?.trim();
  if (envPath) {
    return envPath;
  }
  return join(config.home, '.ZeroClaw', ZeroClaw_CONFIG_FILENAME);
}

async function createScopedZeroClawEnv(workspaceRoot: string): Promise<{
  env: NodeJS.ProcessEnv;
  cleanup: () => Promise<void>;
}> {
  const tempDir = await fs.mkdtemp(join(os.tmpdir(), 'nerve-skills-'));
  const tempConfigPath = join(tempDir, ZeroClaw_CONFIG_FILENAME);

  try {
    await fs.copyFile(getActiveZeroClawConfigPath(), tempConfigPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      await fs.writeFile(tempConfigPath, '{}\n', 'utf-8');
    } else {
      await fs.rm(tempDir, { recursive: true, force: true });
      throw err;
    }
  }

  const scopedEnv = {
    ...enrichedEnv,
    ZeroClaw_CONFIG_PATH: tempConfigPath,
  };

  try {
    await execZeroClawCommand(['config', 'set', 'agents.defaults.workspace', workspaceRoot], {
      env: scopedEnv,
    });
  } catch (err) {
    await fs.rm(tempDir, { recursive: true, force: true });
    throw err;
  }

  return {
    env: scopedEnv,
    cleanup: async () => {
      await fs.rm(tempDir, { recursive: true, force: true });
    },
  };
}

async function resolveWorkspaceCwd(workspaceRoot: string): Promise<string | undefined> {
  try {
    await fs.access(workspaceRoot);
    return workspaceRoot;
  } catch {
    return undefined;
  }
}

async function execZeroClawSkills(agentId?: string): Promise<RawSkill[]> {
  const workspace = resolveAgentWorkspace(agentId);
  const scoped = await createScopedZeroClawEnv(workspace.workspaceRoot);

  try {
    const { stdout, stderr } = await execZeroClawCommand(['skills', 'list', '--json'], {
      env: scoped.env,
      cwd: await resolveWorkspaceCwd(workspace.workspaceRoot),
    });
    const payload = stdout.trim() ? stdout : stderr;
    return parseSkillsOutput(payload);
  } finally {
    await scoped.cleanup();
  }
}

app.get('/api/skills', rateLimitGeneral, async (c) => {
  try {
    const skills = await execZeroClawSkills(c.req.query('agentId'));
    return c.json({ ok: true, skills });
  } catch (err) {
    if (err instanceof InvalidAgentIdError) {
      return c.json({ ok: false, error: err.message }, 400);
    }

    const message = err instanceof Error ? err.message : 'Failed to list skills';
    console.error('[skills] list error:', message);
    return c.json({ ok: false, error: message }, 502);
  }
});

export default app;
