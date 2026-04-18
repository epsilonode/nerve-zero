import type React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FileTreeNode } from './FileTreeNode';
import type { TreeEntry } from './types';

vi.mock('./utils/fileIcons', () => ({
  FileIcon: ({ name }: { name: string }) => <div data-testid={`file-icon-${name}`} />,
  FolderIcon: ({ open }: { open: boolean }) => <div data-testid={`folder-icon-${open ? 'open' : 'closed'}`} />,
}));

vi.mock('./utils/fileTypes', () => ({
  isImageFile: () => false,
  isPdfFile: () => false,
}));

const entry: TreeEntry = {
  name: 'package.json',
  path: 'package.json',
  type: 'file',
  children: null,
};

function renderNode(overrides: Partial<React.ComponentProps<typeof FileTreeNode>> = {}) {
  return render(
    <FileTreeNode
      entry={entry}
      depth={0}
      expandedPaths={new Set()}
      selectedPath={null}
      loadingPaths={new Set()}
      onToggleDir={vi.fn()}
      onOpenFile={vi.fn()}
      onTouchLongPress={vi.fn()}
      onSelect={vi.fn()}
      onContextMenu={vi.fn()}
      dragSourcePath={null}
      dropTargetPath={null}
      onDragStart={vi.fn()}
      onDragEnd={vi.fn()}
      onDragOverDirectory={vi.fn()}
      onDragLeaveDirectory={vi.fn()}
      onDropDirectory={vi.fn()}
      renamingPath={null}
      renameValue=""
      onRenameChange={vi.fn()}
      onRenameCommit={vi.fn()}
      onRenameCancel={vi.fn()}
      {...overrides}
    />,
  );
}

describe('FileTreeNode', () => {
  it('captures the touch pointer when starting a long press', () => {
    renderNode();

    const row = screen.getByTitle('package.json') as HTMLDivElement & {
      setPointerCapture?: (pointerId: number) => void;
    };
    row.setPointerCapture = vi.fn();

    fireEvent.pointerDown(row, {
      pointerType: 'touch',
      pointerId: 7,
      clientX: 20,
      clientY: 30,
    });

    expect(row.setPointerCapture).toHaveBeenCalledWith(7);
  });

  it('does not try to capture non-touch pointers', () => {
    renderNode();

    const row = screen.getByTitle('package.json') as HTMLDivElement & {
      setPointerCapture?: (pointerId: number) => void;
    };
    row.setPointerCapture = vi.fn();

    fireEvent.pointerDown(row, {
      pointerType: 'mouse',
      pointerId: 9,
      clientX: 20,
      clientY: 30,
    });

    expect(row.setPointerCapture).not.toHaveBeenCalled();
  });
});
