import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MarkdownDocumentView } from './MarkdownDocumentView';
import type { OpenFile } from './types';

vi.mock('@/features/markdown/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content, className }: { content: string; className?: string }) => (
    <div data-testid="markdown-renderer" className={className}>{content}</div>
  ),
}));

vi.mock('./FileEditor', () => ({
  FileEditor: () => <div data-testid="file-editor" />,
}));

const file: OpenFile = {
  path: 'docs/guide.md',
  name: 'guide.md',
  content: '# Guide',
  savedContent: '# Guide',
  dirty: false,
  locked: false,
  mtime: 0,
  loading: false,
};

describe('MarkdownDocumentView', () => {
  it('renders preview mode with light full-width gutters and no nested card', () => {
    render(
      <MarkdownDocumentView
        file={file}
        onContentChange={vi.fn()}
        onSave={vi.fn()}
        onRetry={vi.fn()}
      />,
    );

    const renderer = screen.getByTestId('markdown-renderer');
    expect(renderer.closest('article')).toBeNull();
    expect(renderer.parentElement).toHaveClass('px-4');
    expect(renderer.parentElement).toHaveClass('md:px-6');
  });
});
