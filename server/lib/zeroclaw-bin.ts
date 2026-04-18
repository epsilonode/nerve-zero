/**
 * Resolve the `zeroclaw` binary path.
 *
 * Checks (in order):
 *  1. `ZEROCLAW_BIN` env var (explicit override)
 *  2. Sibling of current Bun binary
 *  3. Common system paths (`/opt/homebrew/bin`, `/usr/local/bin`, etc.)
 *  4. Falls back to bare `'zeroclaw'` (relies on `PATH`)
 *
 * Result is cached after the first call.
 * @module
 */

import { accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

let cached: string | null = null;

export function resolveZeroclawBin(): string {
  if (cached) return cached;
  if (process.env.ZEROCLAW_BIN) { cached = process.env.ZEROCLAW_BIN; return cached; }

  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  const runtimeDir = path.dirname(process.execPath);
  const exeSuffix = process.platform === 'win32' ? '.exe' : '';
  const candidates = [
    path.join(process.cwd(), 'dep', `zeroclaw${exeSuffix}`),          // bundled workspace binary
    path.join(runtimeDir, `zeroclaw${exeSuffix}`),                    // same dir as current runtime
    '/opt/homebrew/bin/zeroclaw',                                     // macOS Apple Silicon (Homebrew)
    '/usr/local/bin/zeroclaw',                                        // macOS Intel (Homebrew) / global install
    '/usr/bin/zeroclaw',                                              // system package (Linux)
    path.join(home, '.bun', 'bin', `zeroclaw${exeSuffix}`),           // bun global install
    path.join(home, '.local', 'bin', `zeroclaw${exeSuffix}`),         // local bin
    path.join(home, '.volta', 'bin', `zeroclaw${exeSuffix}`),         // volta
    path.join(home, '.fnm', 'aliases', 'default', 'bin', `zeroclaw${exeSuffix}`),
  ];

  for (const c of candidates) {
    try { accessSync(c, constants.X_OK); cached = c; return cached; } catch { /* next */ }
  }

  console.warn('[zeroclaw-bin] Could not find zeroclaw binary. Checked:', candidates.join(', '),
    '— Set ZEROCLAW_BIN env var to fix. Falling back to bare "zeroclaw" (requires PATH).');
  cached = 'zeroclaw';
  return cached;
}
