import path from 'node:path';
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('./plans.js', () => ({
  findRepoPlanByBeadId: vi.fn(),
}));

vi.mock('./agent-workspace.js', () => ({
  resolveAgentWorkspace: vi.fn((agentId?: string) => ({
    agentId: agentId?.trim() || 'main',
    workspaceRoot: agentId?.trim() === 'research'
      ? '/workspace-research'
      : '/workspace',
    memoryPath: '/workspace/MEMORY.md',
    memoryDir: '/workspace/memory',
  })),
}));

import { BeadValidationError, getBeadDetail, resolveBeadLookupRepoRoot } from './beads.js';

describe('resolveBeadLookupRepoRoot', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('defaults legacy lookup to process cwd', () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/repo/nerve');
    expect(resolveBeadLookupRepoRoot()).toBe('/repo/nerve');
    cwdSpy.mockRestore();
  });

  it('uses explicit absolute repo roots directly when they stay within the workspace', () => {
    expect(resolveBeadLookupRepoRoot({ targetPath: '/workspace/repos/demo' })).toBe('/workspace/repos/demo');
  });

  it('normalizes explicit .beads targets to the owning repo root', () => {
    expect(resolveBeadLookupRepoRoot({ targetPath: '/workspace/repos/demo/.beads' })).toBe('/workspace/repos/demo');
  });

  it('rejects explicit absolute targets outside the workspace root', () => {
    expect(() => resolveBeadLookupRepoRoot({ targetPath: '/repos/demo' })).toThrow(BeadValidationError);
  });

  it('resolves relative explicit targets against the current markdown document directory', () => {
    expect(resolveBeadLookupRepoRoot({
      targetPath: '../projects/demo/.beads',
      currentDocumentPath: 'docs/specs/links.md',
    })).toBe(path.resolve('/workspace', 'docs/projects/demo'));
  });

  it('uses the scoped workspace root when resolving relative explicit targets', () => {
    expect(resolveBeadLookupRepoRoot({
      targetPath: './repos/demo',
      currentDocumentPath: 'notes/beads.md',
      workspaceAgentId: 'research',
    })).toBe(path.resolve('/workspace-research', 'notes/repos/demo'));
  });

  it('rejects absolute current document paths outside the workspace root', () => {
    expect(() => resolveBeadLookupRepoRoot({
      targetPath: './repos/demo',
      currentDocumentPath: '/tmp/beads.md',
    })).toThrow(BeadValidationError);
  });

  it('rejects resolved repo roots that escape the workspace root', () => {
    expect(() => resolveBeadLookupRepoRoot({
      targetPath: '../../../outside-repo',
      currentDocumentPath: 'docs/specs/links.md',
    })).toThrow(BeadValidationError);
  });

  it('rejects relative explicit targets when no current document path is available', () => {
    expect(() => resolveBeadLookupRepoRoot({ targetPath: '../projects/demo' })).toThrow(BeadValidationError);
  });
});

describe('getBeadDetail', () => {
  it('rejects blank bead ids as validation errors', async () => {
    await expect(getBeadDetail('   ')).rejects.toBeInstanceOf(BeadValidationError);
  });
});
