import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export interface ZeroClawConfigSource {
  path: string;
  raw: string;
}

const HOME = process.env.HOME || process.env.USERPROFILE || homedir();
const CONFIG_CANDIDATES = [
  process.env.ZeroClaw_CONFIG_PATH?.trim(),
  path.join(HOME, '.zeroclaw', 'config.toml'),
  path.join(HOME, '.ZeroClaw', 'config.toml'),
  path.join(HOME, '.ZeroClaw', 'ZeroClaw.json'),
].filter((value): value is string => Boolean(value));

function getSectionBody(raw: string, section: string): string {
  const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return raw.match(new RegExp(`^\\[${escaped}\\]\\s*$([\\s\\S]*?)(?=^\\[[^\n]+\\]\\s*$|\\Z)`, 'im'))?.[1] || '';
}

function getString(raw: string, key: string): string | null {
  const match = raw.match(new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*"([^"]*)"\\s*$`, 'm'));
  return match?.[1] ?? null;
}

function getNumber(raw: string, key: string): number | null {
  const match = raw.match(new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*(\d+)\\s*$`, 'm'));
  return match?.[1] ? Number(match[1]) : null;
}

function getBoolean(raw: string, key: string): boolean | null {
  const match = raw.match(new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*(true|false)\\s*$`, 'mi'));
  if (!match) return null;
  return match[1].toLowerCase() === 'true';
}

function getArrayLiteral(raw: string, key: string): string | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const keyMatch = raw.match(new RegExp(`^${escaped}\\s*=\\s*`, 'm'));
  if (!keyMatch || keyMatch.index === undefined) return null;
  const start = keyMatch.index + keyMatch[0].length;
  const tail = raw.slice(start).trimStart();
  if (!tail.startsWith('[')) return null;

  let depth = 0;
  let inString = false;
  let escapedChar = false;
  for (let i = 0; i < tail.length; i++) {
    const ch = tail[i];
    if (inString) {
      if (escapedChar) {
        escapedChar = false;
      } else if (ch === '\\') {
        escapedChar = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '[') depth++;
    if (ch === ']') {
      depth--;
      if (depth === 0) return tail.slice(0, i + 1);
    }
  }

  return null;
}

function tomlInlineToJson(arrayLiteral: string): string {
  return arrayLiteral.replace(/"([^"\\]|\\.)*"\s*=/g, (match) => match.replace(/\s*=\s*$/, ':'));
}

function serializeTomlInline(value: unknown): string {
  if (value === null) return '""';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map((item) => serializeTomlInline(item)).join(', ')}]`;
  if (typeof value === 'object') {
    return `{ ${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => `${JSON.stringify(key)} = ${serializeTomlInline(entry)}`)
      .join(', ')} }`;
  }
  return JSON.stringify(String(value));
}

export async function readZeroClawConfigSource(): Promise<ZeroClawConfigSource> {
  for (const candidate of CONFIG_CANDIDATES) {
    try {
      const raw = await fs.readFile(candidate, 'utf8');
      return { path: candidate, raw };
    } catch {
      // try next candidate
    }
  }

  throw new Error('Could not locate ZeroClaw config.');
}

export function extractDefaultModel(raw: string): string | null {
  return getString(raw, 'default_model');
}

export function extractDefaultThinking(raw: string): string | null {
  const section = getSectionBody(raw, 'agent.thinking');
  return getString(section, 'default_level');
}

export interface ZeroClawCronSection {
  enabled: boolean;
  catchUpOnStartup: boolean;
  maxRunHistory: number;
  jobs: Record<string, unknown>[];
}

export function readCronSection(raw: string): ZeroClawCronSection {
  const section = getSectionBody(raw, 'cron');
  const jobsLiteral = getArrayLiteral(section, 'jobs');
  let jobs: Record<string, unknown>[] = [];
  if (jobsLiteral) {
    try {
      jobs = JSON.parse(tomlInlineToJson(jobsLiteral)) as Record<string, unknown>[];
    } catch {
      jobs = [];
    }
  }

  return {
    enabled: getBoolean(section, 'enabled') ?? true,
    catchUpOnStartup: getBoolean(section, 'catch_up_on_startup') ?? true,
    maxRunHistory: getNumber(section, 'max_run_history') ?? 50,
    jobs,
  };
}

export function updateCronJobs(raw: string, jobs: Record<string, unknown>[]): string {
  const current = readCronSection(raw);
  const nextSection = [
    '[cron]',
    `enabled = ${current.enabled ? 'true' : 'false'}`,
    `catch_up_on_startup = ${current.catchUpOnStartup ? 'true' : 'false'}`,
    `max_run_history = ${current.maxRunHistory}`,
    `jobs = ${serializeTomlInline(jobs)}`,
    '',
  ].join('\n');

  const cronBlockRe = /^\[cron\]\s*$[\s\S]*?(?=^\[[^\n]+\]\s*$|\Z)/im;
  if (cronBlockRe.test(raw)) {
    return raw.replace(cronBlockRe, nextSection);
  }

  const suffix = raw.endsWith('\n') ? '' : '\n';
  return `${raw}${suffix}\n${nextSection}\n`;
}

export async function writeZeroClawConfig(pathname: string, raw: string): Promise<void> {
  await fs.writeFile(pathname, raw, 'utf8');
}
