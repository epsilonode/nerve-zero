/**
 * PdfViewer — Renders PDF files using the browser's built-in PDF viewer via iframe.
 */

import { Loader2, AlertTriangle } from 'lucide-react';
import type { OpenFile } from './types';

interface PdfViewerProps {
  file: OpenFile;
  agentId: string;
}

export function PdfViewer({ file, agentId }: PdfViewerProps) {
  if (file.loading) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-xs gap-2">
        <Loader2 className="animate-spin" size={14} />
        Loading {file.name}...
      </div>
    );
  }

  if (file.error) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
        <AlertTriangle size={24} className="text-destructive" />
        <div className="text-sm">Failed to load PDF</div>
        <div className="text-xs">{file.error}</div>
      </div>
    );
  }

  const src = `/api/files/raw?path=${encodeURIComponent(file.path)}&agentId=${encodeURIComponent(agentId)}`;

  return (
    <div className="h-full w-full bg-[#0a0a0a]">
      <iframe
        key={`pdf-${file.path}-v${file.viewerVersion ?? 0}`}
        src={src}
        title={file.name}
        className="w-full h-full border-0"
      />
    </div>
  );
}