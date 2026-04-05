import React, { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { hljs } from '@/lib/highlight';
import { sanitizeHtml } from '@/lib/sanitize';
import { escapeRegex } from '@/lib/constants';
import { CodeBlockActions } from './CodeBlockActions';

interface MarkdownRendererProps {
  content: string;
  className?: string;
  searchQuery?: string;
  suppressImages?: boolean;
  currentDocumentPath?: string;
  onOpenWorkspacePath?: (path: string, basePath?: string) => void | Promise<void>;
}

function highlightText(text: string, query: string): React.ReactNode {
  if (!query.trim()) return text;
  
  const regex = new RegExp(`(${escapeRegex(query)})`, 'gi');
  const parts = text.split(regex);
  
  // split() with a capture group alternates: non-match, match, non-match, ...
  // Odd indices are always the captured matches — no regex.test() needed
  return parts.map((part, i) => 
    i % 2 === 1 ? (
      <mark key={i} className="search-highlight">{part}</mark>
    ) : part
  );
}

// Process React children to apply search highlighting to text nodes
function processChildren(children: React.ReactNode, searchQuery?: string): React.ReactNode {
  if (!searchQuery?.trim()) return children;
  
  return React.Children.map(children, (child) => {
    if (typeof child === 'string') {
      return highlightText(child, searchQuery);
    }
    if (React.isValidElement<{ children?: React.ReactNode }>(child)) {
      if (child.props.children) {
        return React.cloneElement(child, {
          children: processChildren(child.props.children, searchQuery),
        });
      }
    }
    return child;
  });
}

function isWorkspacePathLink(href: string): boolean {
  if (!href) return false;
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith('#')) return false;
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed)) return false;
  if (trimmed.startsWith('//')) return false;
  return true;
}

function decodeWorkspacePathLink(href: string): string {
  try {
    return decodeURIComponent(href);
  } catch {
    return href;
  }
}

function normalizeWorkspaceLinkTarget(href: string): string {
  const decoded = decodeWorkspacePathLink(href).trim();
  if (!decoded) return decoded;

  if (decoded.startsWith('/')) {
    return decoded.replace(/^\/+/, '');
  }

  return decoded;
}

// ─── Code Block with actions ─────────────────────────────────────────────────

function CodeBlock({ code, language, highlightedHtml }: {
  code: string;
  language: string;
  highlightedHtml?: string;
}) {
  return (
    <div className="code-block-wrapper">
      <CodeBlockActions code={code} language={language} />
      <pre className="hljs">
        <span className="code-lang">{language}</span>
        {highlightedHtml
          ? <code dangerouslySetInnerHTML={{ __html: highlightedHtml }} />
          : <code>{code}</code>
        }
      </pre>
    </div>
  );
}

// ─── Main renderer ───────────────────────────────────────────────────────────

/** Render markdown content with syntax highlighting, search-term highlighting, and inline charts. */
export function MarkdownRenderer({ content, className = '', searchQuery, suppressImages, currentDocumentPath, onOpenWorkspacePath }: MarkdownRendererProps) {
  // Memoize components object to avoid unnecessary ReactMarkdown re-renders.
  // Only recreated when searchQuery or suppressImages changes.
  const components = useMemo(() => ({
    // Highlight search terms in text nodes
    p: ({ children }: { children?: React.ReactNode }) => (
      <p>{processChildren(children, searchQuery)}</p>
    ),
    li: ({ children }: { children?: React.ReactNode }) => (
      <li>{processChildren(children, searchQuery)}</li>
    ),
    td: ({ children }: { children?: React.ReactNode }) => (
      <td>{processChildren(children, searchQuery)}</td>
    ),
    th: ({ children }: { children?: React.ReactNode }) => (
      <th>{processChildren(children, searchQuery)}</th>
    ),
    code: ({ className: codeClassName, children, ...props }: { className?: string; children?: React.ReactNode }) => {
      const match = /language-(\w+)/.exec(codeClassName || '');
      const lang = match ? match[1] : '';
      const codeString = String(children).replace(/\n$/, '');
      const inline = !codeClassName;

      if (!inline && lang) {
        try {
          const highlighted = hljs.getLanguage(lang)
            ? hljs.highlight(codeString, { language: lang }).value
            : hljs.highlightAuto(codeString).value;

          return (
            <CodeBlock
              code={codeString}
              language={lang}
              highlightedHtml={sanitizeHtml(highlighted)}
            />
          );
        } catch {
          return (
            <CodeBlock code={codeString} language={lang} />
          );
        }
      }

      return (
        <code className={codeClassName} {...props}>
          {children}
        </code>
      );
    },
    table: ({ children }: { children?: React.ReactNode }) => (
      <div className="table-wrapper">
        <table className="markdown-table">{children}</table>
      </div>
    ),
    a: ({ children, href }: { children?: React.ReactNode; href?: string }) => {
      if (!href) {
        return <span>{children}</span>;
      }

      if (onOpenWorkspacePath && isWorkspacePathLink(href)) {
        const normalizedTarget = normalizeWorkspaceLinkTarget(href);
        return (
          <a
            href={href}
            className="markdown-link"
            onClick={(event) => {
              event.preventDefault();
              void onOpenWorkspacePath(normalizedTarget, currentDocumentPath);
            }}
          >
            {children}
          </a>
        );
      }

      return (
        <a href={href} target="_blank" rel="noopener noreferrer" className="markdown-link">
          {children}
        </a>
      );
    },
    ...(suppressImages ? { img: () => null } : {}), // When set, images handled by extractedImages + ImageLightbox
  }), [currentDocumentPath, onOpenWorkspacePath, searchQuery, suppressImages]);

  return (
    <div className={`markdown-content ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
