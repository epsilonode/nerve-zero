import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StreamingMessage } from './StreamingMessage';

describe('StreamingMessage', () => {
  it('opens bead-compatible markdown links with the shared chat handlers', async () => {
    const onOpenBeadId = vi.fn();
    const onOpenWorkspacePath = vi.fn();

    render(
      <StreamingMessage
        rawText="[viewer](bead:///home/derrick/.openclaw/workspace/projects/demo/.beads#demo-1234)"
        elapsedMs={0}
        onOpenBeadId={onOpenBeadId}
        onOpenWorkspacePath={onOpenWorkspacePath}
      />,
    );

    const link = await screen.findByRole('link', { name: 'viewer' });
    expect(link).toHaveAttribute('href', 'bead:///home/derrick/.openclaw/workspace/projects/demo/.beads#demo-1234');

    fireEvent.click(link);

    await waitFor(() => {
      expect(onOpenBeadId).toHaveBeenCalledWith({
        beadId: 'demo-1234',
        explicitTargetPath: '/home/derrick/.openclaw/workspace/projects/demo/.beads',
      });
    });
    expect(onOpenWorkspacePath).not.toHaveBeenCalled();
  });

  it('does not treat raw bead ids as acceptable bead links in streaming chat', async () => {
    const onOpenBeadId = vi.fn();
    const onOpenWorkspacePath = vi.fn();

    render(
      <StreamingMessage
        rawText="[viewer](demo-1234)"
        elapsedMs={0}
        onOpenBeadId={onOpenBeadId}
        onOpenWorkspacePath={onOpenWorkspacePath}
      />,
    );

    fireEvent.click(await screen.findByRole('link', { name: 'viewer' }));

    await waitFor(() => {
      expect(onOpenWorkspacePath).toHaveBeenCalledWith('demo-1234', undefined);
    });
    expect(onOpenBeadId).not.toHaveBeenCalled();
  });
});
