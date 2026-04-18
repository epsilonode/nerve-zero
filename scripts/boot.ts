#!/usr/bin/env bun

import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

const bunPath = process.execPath;

async function run(command: string[], label: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(command[0], command.slice(1), {
      stdio: 'inherit',
      env: process.env,
    });

    proc.on('error', reject);
    proc.on('exit', (exitCode) => {
      if (exitCode && exitCode !== 0) {
        reject(new Error(`${label} failed with exit code ${exitCode}`));
        return;
      }
      resolve();
    });
  });
}

async function main(): Promise<void> {
  if (!existsSync('dist/index.html')) {
    console.log('[boot] dist/ missing, building Nerve first...');
    await run([bunPath, 'run', 'build'], 'build');
  }

  await import('../server/index.js');
}

main().catch((error: unknown) => {
  console.error('[boot] Failed to start Nerve:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
