/**
 * Prerequisite checker — verifies Bun, ffmpeg, openssl, and Tailscale.
 */

import { execSync } from 'node:child_process';
import { success, warn, fail } from './banner.js';
import { getTailscaleState, type TailscaleState } from './tailscale.js';

export interface PrereqResult {
  bunOk: boolean;
  bunVersion: string;
  ffmpegOk: boolean;
  opensslOk: boolean;
  tailscaleOk: boolean;
  tailscaleIp: string | null;
  tailscale: TailscaleState;
}

/** Check all prerequisites and print results. */
export function checkPrerequisites(opts?: { quiet?: boolean }): PrereqResult {
  const quiet = opts?.quiet ?? false;

  if (!quiet) console.log('  Checking prerequisites...');

  const bunVersion = process.versions.bun || '';
  const bunMajor = parseInt(bunVersion.split('.')[0] || '0', 10);
  const bunOk = bunMajor >= 1;

  if (!quiet) {
    if (bunOk) success(`Bun ${bunVersion} (>=1 required)`);
    else fail(`Bun ${bunVersion || 'not detected'} — version 1 or later is required`);
  }

  const ffmpegOk = commandExists('ffmpeg');
  if (!quiet) {
    if (ffmpegOk) success('ffmpeg found (optional, for Qwen TTS)');
    else warn('ffmpeg not found (optional — needed for Qwen TTS WAV→MP3)');
  }

  const opensslOk = commandExists('openssl');
  if (!quiet) {
    if (opensslOk) success('openssl found (for HTTPS cert generation)');
    else warn('openssl not found (optional — needed for self-signed HTTPS certs)');
  }

  const tailscale = getTailscaleState();
  const tailscaleOk = tailscale.installed;
  const tailscaleIp = tailscale.ipv4;
  if (!quiet && tailscaleOk) {
    if (tailscaleIp) success(`Tailscale detected (${tailscaleIp})`);
    else if (tailscale.authenticated && tailscale.dnsName) success(`Tailscale detected (${tailscale.dnsName})`);
    else warn('Tailscale installed but not connected');
  }

  return { bunOk, bunVersion, ffmpegOk, opensslOk, tailscaleOk, tailscaleIp, tailscale };
}

/** Check if a command exists on the system. */
function commandExists(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { stdio: 'pipe', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}
