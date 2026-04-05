import { useMemo, useState } from 'react';
import { Eye, PencilLine } from 'lucide-react';
import { MarkdownRenderer } from '@/features/markdown/MarkdownRenderer';
import type { OpenFile } from './types';
import { FileEditor } from './FileEditor';

interface MarkdownDocumentViewProps {
  file: OpenFile;
  onContentChange: (path: string, content: string) => void;
  onSave: (path: string) => void;
  onRetry: (path: string) => void;
  onOpenWorkspacePath?: (path: string, basePath?: string) => void | Promise<void>;
}

export function MarkdownDocumentView({
  file,
  onContentChange,
  onSave,
  onRetry,
  onOpenWorkspacePath,
}: MarkdownDocumentViewProps) {
  const [mode, setMode] = useState<'preview' | 'edit'>('preview');

  const previewContent = useMemo(() => (
    file.loading || file.error ? '' : file.content
  ), [file.content, file.error, file.loading]);

  return (
    <div className="h-full flex flex-col min-h-0 bg-background/20">
      <div className="flex items-center justify-between gap-3 border-b border-border/60 px-3 py-2 shrink-0 bg-card/55">
        <div className="min-w-0">
          <div className="text-[0.733rem] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
            Markdown document
          </div>
          <div className="truncate text-[0.8rem] text-foreground/90">{file.path}</div>
        </div>
        <div className="flex items-center gap-1 rounded-xl border border-border/70 bg-background/55 p-1">
          <button
            type="button"
            className="cockpit-toolbar-button min-h-8 px-3 text-[0.733rem]"
            data-active={mode === 'preview'}
            onClick={() => setMode('preview')}
            aria-pressed={mode === 'preview'}
          >
            <Eye size={14} />
            Preview
          </button>
          <button
            type="button"
            className="cockpit-toolbar-button min-h-8 px-3 text-[0.733rem]"
            data-active={mode === 'edit'}
            onClick={() => setMode('edit')}
            aria-pressed={mode === 'edit'}
          >
            <PencilLine size={14} />
            Edit
          </button>
        </div>
      </div>

      {mode === 'preview' ? (
        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 md:px-6">
          <article className="markdown-document mx-auto max-w-4xl rounded-[24px] border border-border/60 bg-card/55 px-5 py-4 shadow-[0_18px_48px_rgba(0,0,0,0.16)] md:px-8 md:py-6">
            <MarkdownRenderer
              content={previewContent}
              className="markdown-document-content"
              onOpenWorkspacePath={(targetPath) => onOpenWorkspacePath?.(targetPath, file.path)}
            />
          </article>
        </div>
      ) : (
        <div className="flex-1 min-h-0">
          <FileEditor
            file={file}
            onContentChange={onContentChange}
            onSave={onSave}
            onRetry={onRetry}
          />
        </div>
      )}
    </div>
  );
}
