import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { BeadViewerTab } from './BeadViewerTab';

const { beadDetailState, markdownRendererSpy } = vi.hoisted(() => ({
  beadDetailState: {
    bead: {
      id: 'nerve-4gpd',
      title: 'Second CodeRabbit fixes',
      notes: '[related](bead:nerve-related)',
      status: 'open',
      priority: 1,
      issueType: 'task',
      owner: 'chip',
      createdAt: null,
      updatedAt: null,
      closedAt: null,
      closeReason: null,
      dependencies: [{ id: 'nerve-dep', title: 'Dependency', status: 'open', dependencyType: 'blocks' }],
      dependents: [],
      linkedPlan: {
        path: '.plans/demo.md',
        workspacePath: 'projects/demo/.plans/demo.md',
        title: 'Demo plan',
        planId: 'plan-demo',
        archived: false,
        status: 'In Progress',
        updatedAt: 123,
      },
    },
    loading: false,
    error: null as string | null,
  },
  markdownRendererSpy: vi.fn(),
}));

vi.mock('./useBeadDetail', () => ({
  useBeadDetail: () => beadDetailState,
}));

vi.mock('@/features/markdown/MarkdownRenderer', () => ({
  MarkdownRenderer: (props: {
    onOpenBeadId?: (target: { beadId: string; explicitTargetPath?: string; currentDocumentPath?: string; workspaceAgentId?: string }) => void;
    currentDocumentPath?: string;
    workspaceAgentId?: string;
  }) => {
    markdownRendererSpy(props);
    return (
      <button
        type="button"
        onClick={() => props.onOpenBeadId?.({ beadId: 'nerve-inline' })}
      >
        Open inline bead
      </button>
    );
  },
}));

describe('BeadViewerTab', () => {
  beforeEach(() => {
    markdownRendererSpy.mockClear();
    beadDetailState.loading = false;
    beadDetailState.error = null;
  });

  it('preserves the current bead context when opening related beads and markdown bead links', async () => {
    const onOpenBeadId = vi.fn();

    render(
      <BeadViewerTab
        beadTarget={{
          beadId: 'nerve-4gpd',
          explicitTargetPath: '../projects/demo/.beads',
          currentDocumentPath: 'notes/beads.md',
          workspaceAgentId: 'research',
        }}
        onOpenBeadId={onOpenBeadId}
      />,
    );

    expect(markdownRendererSpy).toHaveBeenCalledWith(expect.objectContaining({
      currentDocumentPath: 'notes/beads.md',
      workspaceAgentId: 'research',
    }));

    fireEvent.click(screen.getByRole('button', { name: /Dependency/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Open inline bead' }));

    await waitFor(() => {
      expect(onOpenBeadId).toHaveBeenNthCalledWith(1, {
        beadId: 'nerve-dep',
        explicitTargetPath: '../projects/demo/.beads',
        currentDocumentPath: 'notes/beads.md',
        workspaceAgentId: 'research',
      });
      expect(onOpenBeadId).toHaveBeenNthCalledWith(2, {
        beadId: 'nerve-inline',
        explicitTargetPath: '../projects/demo/.beads',
        currentDocumentPath: 'notes/beads.md',
        workspaceAgentId: 'research',
      });
    });
  });

  it('opens linked plans via their resolved workspace path and logs async failures', async () => {
    const error = new Error('nope');
    const onOpenWorkspacePath = vi.fn().mockRejectedValueOnce(error);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <BeadViewerTab
        beadTarget={{ beadId: 'nerve-4gpd', workspaceAgentId: 'research' }}
        onOpenWorkspacePath={onOpenWorkspacePath}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Demo plan/i }));

    await waitFor(() => {
      expect(onOpenWorkspacePath).toHaveBeenCalledWith('projects/demo/.plans/demo.md');
      expect(consoleError).toHaveBeenCalledWith('Failed to open linked plan:', error);
    });

    consoleError.mockRestore();
  });
});
