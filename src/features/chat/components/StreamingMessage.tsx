import { lazy, Suspense } from 'react';
import type { BeadLinkTarget } from '@/features/beads';
import { formatElapsed } from '../utils';

const MarkdownRenderer = lazy(() =>
  import('@/features/markdown/MarkdownRenderer').then(module => ({ default: module.MarkdownRenderer })),
);

interface StreamingMessageProps {
  rawText: string;
  elapsedMs: number;
  agentName?: string;
  onOpenWorkspacePath?: (path: string) => void | Promise<void>;
  pathLinkPrefixes?: string[];
  onOpenBeadId?: (target: BeadLinkTarget) => void | Promise<void>;
}

/**
 * Streaming message display with live content.
 *
 * Uses the shared MarkdownRenderer so chat streaming matches markdown-document
 * link behavior for workspace and bead-compatible markdown links.
 */
export function StreamingMessage({
  rawText,
  elapsedMs,
  agentName = 'Agent',
  onOpenWorkspacePath,
  pathLinkPrefixes,
  onOpenBeadId,
}: StreamingMessageProps) {
  return (
    <div className="msg msg-assistant streaming relative max-w-full break-words bg-message-assistant">
      <div className="flex items-center gap-2 px-4 py-2">
        <span className="cockpit-badge" data-tone="success">{agentName}</span>
        {elapsedMs > 0 && (
          <span className="ml-auto font-mono text-[0.667rem] tabular-nums text-muted-foreground">{formatElapsed(elapsedMs)}</span>
        )}
      </div>
      <div className="ml-4 border-l-2 border-green/60 px-4 pb-3 pl-6">
        <div className="msg-body whitespace-pre-wrap text-foreground text-[0.867rem]">
          <Suspense fallback={<div>{rawText}</div>}>
            <MarkdownRenderer
              content={rawText}
              suppressImages
              onOpenWorkspacePath={onOpenWorkspacePath}
              pathLinkPrefixes={pathLinkPrefixes}
              onOpenBeadId={onOpenBeadId}
            />
          </Suspense>
        </div>
      </div>
    </div>
  );
}
