import { describe, it, expect, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';

vi.mock('@/features/markdown/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content, onOpenWorkspacePath }: { content: string; onOpenWorkspacePath?: ((path: string) => void) & { handlerId?: string } }) => (
    <div data-handler-id={onOpenWorkspacePath?.handlerId ?? ''}>{content}</div>
  ),
}));

vi.mock('@/features/charts/InlineChart', () => ({
  default: () => null,
}));

import { MessageBubble } from './MessageBubble';
import type { ChatMsg } from './types';

function makeMessage(overrides: Partial<ChatMsg> = {}): ChatMsg {
  return {
    role: 'user',
    html: '',
    rawText: 'hello from operator',
    timestamp: new Date('2026-03-18T12:00:00Z'),
    ...overrides,
  };
}

describe('MessageBubble', () => {
  it('right-anchors user bubbles while keeping message text left-aligned', () => {
    const { container } = render(
      <MessageBubble
        msg={makeMessage()}
        index={0}
        isCollapsed={false}
        isMemoryCollapsed={false}
        onToggleCollapse={() => {}}
        onToggleMemory={() => {}}
      />,
    );

    const bubble = container.querySelector('.msg-user');
    const body = container.querySelector('.msg-body');

    expect(bubble).toBeTruthy();
    expect(bubble?.className).toContain('ml-auto');
    expect(bubble?.className).toContain('w-fit');
    expect(body).toBeTruthy();
    expect(body?.className).toContain('text-left');
  });

  it('re-renders when onOpenWorkspacePath changes', async () => {
    const handlerOne = Object.assign(() => {}, { handlerId: 'one' });
    const handlerTwo = Object.assign(() => {}, { handlerId: 'two' });

    const { container, rerender } = render(
      <MessageBubble
        msg={makeMessage({ role: 'assistant', rawText: '[notes](docs/todo.md)' })}
        index={0}
        isCollapsed={false}
        isMemoryCollapsed={false}
        onToggleCollapse={() => {}}
        onToggleMemory={() => {}}
        onOpenWorkspacePath={handlerOne}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector('[data-handler-id="one"]')).toBeTruthy();
    });

    rerender(
      <MessageBubble
        msg={makeMessage({ role: 'assistant', rawText: '[notes](docs/todo.md)' })}
        index={0}
        isCollapsed={false}
        isMemoryCollapsed={false}
        onToggleCollapse={() => {}}
        onToggleMemory={() => {}}
        onOpenWorkspacePath={handlerTwo}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector('[data-handler-id="two"]')).toBeTruthy();
    });
  });

  it('renders upload attachment metadata for user messages loaded from history', async () => {
    const { getByText } = render(
      <MessageBubble
        msg={makeMessage({
          rawText: 'Please review these.',
          uploadAttachments: [
            {
              id: 'att-path',
              origin: 'server_path',
              mode: 'file_reference',
              name: 'capture.mov',
              mimeType: 'video/quicktime',
              sizeBytes: 8_000_000,
              reference: {
                kind: 'local_path',
                path: '/workspace/capture.mov',
                uri: 'file:///workspace/capture.mov',
              },
              preparation: {
                sourceMode: 'file_reference',
                finalMode: 'file_reference',
                outcome: 'file_reference_ready',
                originalMimeType: 'video/quicktime',
                originalSizeBytes: 8_000_000,
              },
              policy: { forwardToSubagents: true },
            },
          ],
        })}
        index={0}
        isCollapsed={false}
        isMemoryCollapsed={false}
        onToggleCollapse={() => {}}
        onToggleMemory={() => {}}
      />,
    );

    await waitFor(() => {
      expect(getByText('capture.mov')).toBeTruthy();
      expect(getByText('Local File')).toBeTruthy();
      expect(getByText('/workspace/capture.mov')).toBeTruthy();
    });
  });
});
